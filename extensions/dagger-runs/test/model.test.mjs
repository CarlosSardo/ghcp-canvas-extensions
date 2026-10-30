import test from "node:test";
import assert from "node:assert/strict";
import { ingest, makeRun, snapshot, appendLog, LOG_LIMIT } from "../lib/model.mjs";
import { redactor } from "../lib/redact.mjs";
import { decodeOTLP } from "../lib/otlp.mjs";
import { attrs, logs, span, traces, traceId } from "./helpers.mjs";

const create = () => makeRun("test", "/tmp", "dagger call test", "v0.21.11");
test("abnormal completion ends unfinished spans without changing completed work or raw telemetry", () => {
  for (const status of ["cancelled", "failed", "interrupted"]) {
    const r = create();
    ingest(r, traces(span("1", { endTimeUnixNano: "0" }), span("2"),
      span("3", { attributes: attrs({ "dagger.io/dag.pending": true }) })), "traces", redactor({}));
    r.status = status; r.endedAt = 1700000002000;
    const first = snapshot(r, r.endedAt + 1000), later = snapshot(r, r.endedAt + 10000);
    for (const id of ["1", "3"]) {
      const s = first.tree.nodes.find((s) => s.spanId.endsWith(id));
      assert.equal(s.status, status === "cancelled" ? "cancelled" : "interrupted");
      assert.ok(s.end);
      assert.equal(s.durationMs, later.tree.nodes.find((n) => n.id === s.id).durationMs);
    }
    assert.equal(first.tree.nodes.find((s) => s.spanId.endsWith("2")).status, "succeeded");
    assert.equal(r.spans[`${traceId}:${"1".padStart(16, "0")}`].status, "running");
  }
});
test("out of order spans reparent; missing parents remain visible; cached/pending/failure recognized", () => {
  const r = create(), redact = redactor({});
  ingest(r, traces(span("2", { parentSpanId: "1".padStart(16, "0"), attributes: attrs({ "dagger.io/dag.cached": true }) }),
    span("3", { parentSpanId: "f".repeat(16), attributes: attrs({ "dagger.io/dag.pending": true }) }),
    span("4", { status: { code: 2, message: "deliberate failure" } })), "traces", redact);
  assert.equal(snapshot(r).tree.roots.length, 3);
  ingest(r, traces(span("1")), "traces", redact);
  const result = snapshot(r);
  assert.equal(result.tree.roots.length, 3);
  assert.equal(result.tree.nodes.find((s) => s.spanId.endsWith("1")).children.length, 1);
  assert.equal(result.summary.cached, 1); assert.equal(result.summary.failed, 1);
  assert.equal(result.tree.nodes.find((s) => s.spanId.endsWith("3")).status, "pending");
});
test("live negative end timestamps and final updates, stale updates cannot revert completion", () => {
  const r = create(), redact = redactor({});
  const live = span("1", { endTimeUnixNano: "-6795364578871345152" });
  ingest(r, traces(live), "traces", redact);
  assert.equal(snapshot(r).tree.nodes[0].status, "running");
  ingest(r, traces(span("1")), "traces", redact);
  ingest(r, traces(live), "traces", redact);
  assert.equal(snapshot(r).tree.nodes[0].status, "succeeded");
  assert.equal(snapshot(r).tree.nodes[0].durationMs, 1000);
});
test("trace IDs isolate duplicate span IDs and malformed batches are atomic", () => {
  const r = create(), redact = redactor({});
  ingest(r, traces(span("1"), span("1", { traceId: "f".repeat(32) })), "traces", redact);
  assert.equal(snapshot(r).summary.total, 2);
  assert.throws(() => ingest(r, traces(span("2"), span("bad", { traceId: "invalid" })), "traces", redact));
  assert.equal(snapshot(r).summary.total, 2);
});
test("cyclic parents stay visible instead of recursing forever", () => {
  const r = create();
  ingest(r, traces(span("1", { parentSpanId: "2".padStart(16, "0") }), span("2", { parentSpanId: "1".padStart(16, "0") })), "traces", redactor({}));
  assert.equal(snapshot(r).tree.roots.length, 2);
});
test("redacts sensitive attributes, events, command values, known env secrets, and ANSI logs; caps logs", () => {
  const r = create(), redact = redactor({ API_TOKEN: "env-sensitive-value" });
  ingest(r, traces(span("1", { attributes: attrs({ "auth.token": "attribute-sensitive-value", "dagger.io/dag.call": "encoded payload" }),
    events: [{ name: "exception", attributes: attrs({ password: "event-sensitive-value" }) }] })), "traces", redact);
  ingest(r, logs({ traceId, spanId: "1".padStart(16, "0"), body: { stringValue: "\u001b[31menv-sensitive-value attribute-sensitive-value password='with spaces'\u001b[0m" }, attributes: attrs({ "stdio.stream": "2" }) }), "logs", redact);
  const json = JSON.stringify(r);
  for (const secret of ["env-sensitive-value", "attribute-sensitive-value", "event-sensitive-value", "with spaces", "encoded payload"]) assert.ok(!json.includes(secret), secret);
  assert.ok(json.includes("[REDACTED]"));
  assert.equal(Object.values(r.logs)[0].entries[0].stream, "stderr");
  appendLog(r, "big", "stdout", "x".repeat(LOG_LIMIT + 10), redact);
  assert.equal(r.logs.big.truncated, true); assert.equal(r.logs.big.bytes, LOG_LIMIT);
});
test("protobuf decodes trace envelope and rejects truncation/invalid wire types", () => {
  // resource_spans -> scope_spans -> span(name='test').
  const encoded = Buffer.from([10, 10, 18, 8, 18, 6, 42, 4, 116, 101, 115, 116]);
  assert.equal(decodeOTLP(encoded, "traces", "application/x-protobuf").resourceSpans[0].scopeSpans[0].spans[0].name, "test");
  assert.throws(() => decodeOTLP(encoded.subarray(0, -1), "traces", "application/x-protobuf"));
  assert.throws(() => decodeOTLP(Buffer.from([15]), "traces", "application/x-protobuf"));
});
test("2500-span tree ingestion and summaries preserve exact shape", () => {
  const r = create();
  const batch = Array.from({ length: 2500 }, (_, i) => span((i + 1).toString(16), i ? { parentSpanId: "1".padStart(16, "0") } : {}));
  ingest(r, traces(...batch), "traces", redactor({}));
  const s = snapshot(r);
  assert.equal(s.summary.total, 2500); assert.equal(s.summary.executedPercentage, 100);
  assert.equal(s.tree.roots.length, 1); assert.equal(s.tree.nodes[0].children.length, 2499);
  assert.equal(s.summary.slowest.length, 5);
});
test("lazy effects resolve API failures and identify error_origin root causes with logs", () => {
  const r = create(), redact = redactor({}), root = span("1", { attributes: attrs({ "dagger.io/dag.pending": true }) });
  const links = [
    { traceId, spanId: root.spanId, attributes: attrs({ "dagger.io/link.purpose": "cause" }) },
    { traceId, spanId: root.spanId, attributes: attrs({ "dagger.io/link.purpose": "error_origin" }) },
  ];
  ingest(r, traces(root, span("2", { name: "resume withExec", links, status: { code: 2, message: "exit code: 1" } })), "traces", redact);
  const api = snapshot(r).tree.nodes.find((s) => s.spanId === root.spanId);
  assert.equal(api.status, "failed"); assert.equal(api.rootCause, true);
});
test("green runs recover diagnostic errors; registry 401 probes are never counted as failures", () => {
  const r = create(), redact = redactor({});
  ingest(r, traces(span("1", { status: { code: 2 }, attributes: attrs({ "http.response.status_code": "401" }) }),
    span("2", { status: { code: 2, message: "retry succeeded later" } })), "traces", redact);
  assert.equal(snapshot(r).summary.failed, 1);
  r.status = "succeeded";
  assert.equal(snapshot(r).summary.failed, 0); assert.equal(snapshot(r).summary.recovered, 2);
  assert.equal(snapshot(r).tree.nodes[0].rawStatus, "failed");
});
test("beta protobuf call-payload logs are structured records, not stdout or decoding errors", () => {
  const r = create();
  ingest(r, logs({ traceId, spanId: "1".padStart(16, "0"), body: { bytesValue: "deadbeef" },
    attributes: attrs({ "dagger.io/content.type": "application/vnd.dagger.call+proto" }) }), "logs", redactor({}));
  assert.equal(r.omittedPayloads, 1); assert.equal(Object.keys(r.logs).length, 0);
});
test("unattributed and structured logs remain readable; UTF-8 logs never exceed the byte cap", () => {
  const r = create(), redact = redactor({});
  ingest(r, logs({ body: { kvlistValue: { values: attrs({ message: "engine notice", password: "do not persist" }) } } }), "logs", redact);
  assert.ok(r.logs.process.entries[0].text.includes("engine notice"));
  assert.ok(!JSON.stringify(r.logs).includes("do not persist"));
  appendLog(r, "unicode", "stdout", "😀".repeat(LOG_LIMIT / 4 + 1), redact);
  assert.ok(r.logs.unicode.bytes <= LOG_LIMIT);
  assert.equal(r.logs.unicode.truncated, true);
});
