import { anyValue, records, attributes } from "./otlp.mjs";

export const LOG_LIMIT = 1024 * 1024;
export const SPAN_LIMIT = 100_000;
export const spanKey = (traceId, spanId) => `${traceId}:${spanId}`;
const flag = (value) => value === true || value === "true" || value === 1 || value === "1";
const millis = (value) => {
  if (value == null || value === "") return 0;
  try { return Number(BigInt.asIntN(64, BigInt(value))) / 1e6; }
  catch { throw new Error("Invalid OTLP timestamp"); }
};

export function makeRun(id, cwd, command, version) {
  return { id, cwd, command, version, status: "running", startedAt: Date.now(),
    endedAt: null, spans: {}, logs: {}, errors: [], cloudUrl: null, droppedSpans: 0 };
}

export function appendLog(run, key, stream, text, redact, time = Date.now()) {
  const entry = run.logs[key] ??= { entries: [], bytes: 0, truncated: false };
  if (entry.truncated) return;
  const safe = typeof text === "object" ? JSON.stringify(redact.clean(text)) : redact.text(text);
  const total = run.logBytes ??= 0;
  const room = Math.max(0, Math.min(LOG_LIMIT - entry.bytes, 16 * LOG_LIMIT - total));
  let clipped = Buffer.from(safe).subarray(0, room).toString("utf8");
  while (Buffer.byteLength(clipped) > room) clipped = clipped.slice(0, -1);
  entry.bytes += Buffer.byteLength(clipped);
  run.logBytes += Buffer.byteLength(clipped);
  if (entry.entries.length < 10_000) entry.entries.push({ stream, text: clipped, time });
  else { entry.truncated = true; return; }
  if (Buffer.byteLength(safe) > room) entry.truncated = true;
  const match = safe.match(/https:\/\/(?:dagger\.cloud|cloud\.dagger\.io)\/[^\s"'<>]+/);
  if (match) {
    const url = new URL(match[0]);
    url.search = "";
    url.hash = "";
    if (!/\/(?:setup|signup)\/?$/.test(url.pathname)) run.cloudUrl = url.href;
  }
}

export function ingest(run, payload, signal, redact) {
  const batch = records(payload, signal);
  let count = Object.keys(run.spans).length;
  // Validate the entire batch before changing the run.
  for (const s of batch) {
    if ((signal === "traces" || s.traceId) && !/^[\da-f]{32}$/i.test(s.traceId ?? "") ||
        (signal === "traces" || s.spanId) && !/^[\da-f]{16}$/i.test(s.spanId ?? ""))
      throw new Error("OTLP records require hex traceId (32) and spanId (16)");
    if (signal === "traces") {
      if (millis(s.startTimeUnixNano) <= 0) throw new Error("OTLP span requires a positive start timestamp");
      millis(s.endTimeUnixNano);
    }
  }
  for (const s of batch) redact.capture(s.attributes);
  for (const s of batch) {
    const key = s.traceId && s.spanId ? spanKey(s.traceId.toLowerCase(), s.spanId.toLowerCase()) : "process";
    const attrs = redact.clean(s.attributes);
    if (run.external && typeof attrs["dagger.io/client.version"] === "string")
      run.version = attrs["dagger.io/client.version"];
    if (signal === "logs") {
      if (attrs["dagger.io/content.type"] === "application/vnd.dagger.call+proto") {
        run.omittedPayloads = (run.omittedPayloads ?? 0) + 1;
        continue;
      }
      if (attrs["dagger.io/log.role"] === "span.name") {
        if (run.spans[key]) run.spans[key].name = redact.text(anyValue(s.body));
        continue;
      }
      if (attrs["dagger.io/progress.item"]) continue;
      appendLog(run, key, attrs["stdio.stream"] === "2" || attrs["stdio.stream"] === 2 ? "stderr" : "stdout",
        anyValue(s.body), redact, millis(s.timeUnixNano) || Date.now());
      continue;
    }
    if (!run.spans[key] && count >= SPAN_LIMIT) { run.droppedSpans++; continue; }
    const old = run.spans[key];
    if (!old) count++;
    const start = millis(s.startTimeUnixNano), rawEnd = millis(s.endTimeUnixNano);
    const end = rawEnd >= start && rawEnd > 0 ? rawEnd : null;
    // Export retries and live updates may arrive after the final span.
    if (old?.end && (!end || old.end > end)) continue;
    const failed = s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR";
    const status = failed ? "failed" : flag(attrs["dagger.io/dag.cached"]) ? "cached" :
      flag(attrs["dagger.io/dag.pending"]) ? "pending" : end ? "succeeded" : "running";
    run.spans[key] = { id: key, spanId: s.spanId.toLowerCase(), traceId: s.traceId.toLowerCase(),
      parentId: s.parentSpanId && !/^0+$/.test(s.parentSpanId) ? spanKey(s.traceId.toLowerCase(), s.parentSpanId.toLowerCase()) : null,
      name: redact.text(s.name || "(unnamed span)"), start, end, status, attributes: attrs,
      links: (s.links ?? []).filter((l) => /^[\da-f]{32}$/i.test(l.traceId ?? "") && /^[\da-f]{16}$/i.test(l.spanId ?? ""))
        .map((l) => ({ id: spanKey(l.traceId.toLowerCase(), l.spanId.toLowerCase()), purpose: attributes(l.attributes)["dagger.io/link.purpose"] ?? "cause" })),
      error: redact.text(s.status?.message || ""), events: redact.clean((s.events ?? []).map((e) => ({
        ...e, attributes: Object.fromEntries((e.attributes ?? []).map((a) => [a.key, anyValue(a.value)])),
      }))) };
  }
}

export function snapshot(run, now = Date.now()) {
  const end = run.endedAt ?? now;
  const nodes = Object.values(run.spans).map((s) => ({ ...s, durationMs: Math.max(0, (s.end ?? end) - s.start), children: [] }));
  const byId = new Map(nodes.map((s) => [s.id, s]));
  const effects = new Map();
  for (const s of nodes) for (const link of s.links ?? []) {
    if (link.purpose === "cause") {
      if (!effects.has(link.id)) effects.set(link.id, []);
      effects.get(link.id).push(s);
    }
  }
  // Dagger API calls are lazy: linked resumption spans carry their actual result.
  const resolved = new Set(), visiting = new Set();
  function resolve(s, depth = 0) {
    if (resolved.has(s.id) || visiting.has(s.id) || depth > 64) return;
    visiting.add(s.id);
    const linked = effects.get(s.id) ?? [];
    for (const effect of linked) resolve(effect, depth + 1);
    s.effects = linked.map((e) => e.id);
    if (s.status === "pending" && linked.length) {
      const complete = linked.filter((e) => !flag(e.attributes["dagger.io/dag.partial"]) && !flag(e.attributes["dagger.io/dag.blocked"]));
      const failed = complete.find((e) => e.status === "failed");
      if (failed) { s.status = "failed"; s.error ||= failed.error; }
      else if (complete.some((e) => e.status === "running")) s.status = "running";
      else if (complete.length && complete.every((e) => e.end)) s.status = complete.every((e) => e.status === "cached") ? "cached" : "succeeded";
      const final = Math.max(s.end ?? s.start, ...linked.map((e) => e.end ?? end));
      s.durationMs = Math.max(0, final - s.start);
    }
    visiting.delete(s.id); resolved.add(s.id);
  }
  for (const s of nodes) resolve(s);
  const origins = new Set(nodes.flatMap((s) => (s.links ?? [])
    .filter((l) => l.purpose === "error_origin").map((l) => l.id)));
  for (const s of nodes) {
    s.rawStatus = run.spans[s.id].status;
    if (["cancelled", "failed", "interrupted"].includes(run.status) && ["running", "pending"].includes(s.status)) {
      s.status = run.status === "cancelled" ? "cancelled" : "interrupted";
      s.end ??= end;
      s.durationMs = Math.max(0, s.end - s.start);
    }
    s.errorOriginIds = (s.links ?? []).filter((l) => l.purpose === "error_origin").map((l) => l.id);
    s.rootCause = s.status === "failed" && origins.has(s.id) && !s.errorOriginIds.some((id) => id !== s.id && origins.has(id));
    const code = Number(s.attributes["http.response.status_code"] ?? s.attributes["http.status_code"]);
    // Registry auth challenges are successful control flow, not pipeline failures.
    s.recovered = s.status === "failed" && (run.status === "succeeded" || (code === 401 && !s.error));
    if (s.recovered) { s.status = "succeeded"; s.rootCause = false; }
  }
  if (!nodes.some((s) => s.rootCause)) {
    const failedParents = new Set(nodes.filter((s) => s.status === "failed").map((s) => s.parentId));
    const failed = nodes.filter((s) => s.status === "failed" && s.error && !s.errorOriginIds.length);
    const withLogs = failed.filter((s) => run.logs[s.id]?.entries.length);
    for (const s of withLogs.length ? withLogs : failed.filter((s) => !failedParents.has(s.id)))
      s.rootCause = true;
  }
  const roots = [];
  for (const s of nodes) {
    let parent = byId.get(s.parentId), cursor = parent;
    const seen = new Set([s.id]);
    while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); cursor = byId.get(cursor.parentId); }
    if (cursor) parent = null; // Cyclic/malformed parent graphs remain visible as roots.
    if (parent) parent.children.push(s.id);
    else roots.push(s.id);
  }
  nodes.sort((a, b) => a.start - b.start);
  const cached = nodes.filter((s) => s.status === "cached").length;
  const failed = nodes.filter((s) => s.status === "failed").length;
  const recovered = nodes.filter((s) => s.recovered).length;
  const executed = nodes.filter((s) => s.status === "succeeded" || s.status === "failed").length;
  const { spans: _spans, logs: _logs, ...meta } = run;
  return { ...meta, durationMs: Math.max(0, end - run.startedAt), tree: { roots, nodes },
    summary: { total: nodes.length, cached, executed, failed, recovered, rootCauses: nodes.filter((s) => s.rootCause).length,
      executedPercentage: nodes.length ? Math.round(executed / nodes.length * 100) : 0,
      cachedPercentage: nodes.length ? Math.round(cached / nodes.length * 100) : 0,
      slowest: [...nodes].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
        .map(({ id, name, durationMs, status }) => ({ id, name, durationMs, status })) } };
}
