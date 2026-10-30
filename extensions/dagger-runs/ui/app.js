const $ = (id) => document.getElementById(id);
let state = { runs: [], run: null }, selectedRun = "", selectedSpan = "", visible = [], nodes = new Map();
let collapsed = new Set(), firstFailureShown = new Set(), loading = false, dirty = false, detailRequest = 0;
const ROW = 32;
const duration = (ms) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 60_000).toFixed(1)} min`;
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function notice(message = "") { $("notice").textContent = message; $("notice").hidden = !message; }
async function action(name, input) {
  const response = await fetch(`actions/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Action failed");
  return value;
}
function chooseRun(id) {
  selectedRun = id; selectedSpan = ""; collapsed = new Set(); $("tree").scrollTop = 0;
  $("detail-name").textContent = "Select a span to inspect";
  $("logs").textContent = ""; $("attributes").textContent = ""; $("detail-error").textContent = "";
  refresh().catch((e) => notice(e.message));
}
async function refresh() {
  if (loading) { dirty = true; return; }
  loading = true;
  try {
    const response = await fetch(`state?runId=${encodeURIComponent(selectedRun)}`);
    const next = await response.json();
    if (!response.ok) throw new Error(next.error || "Unable to load run");
    state = next;
    if (!$("cwd").value) $("cwd").value = state.prefill.cwd || "";
    if (state.prefill.command && !$("command").dataset.edited) $("command").value = state.prefill.command;
    if (!selectedRun && state.prefill.runId) selectedRun = state.prefill.runId;
    if (!selectedRun && state.runs.length) { selectedRun = state.runs[0].id; dirty = true; }
    if (state.error) notice(state.error);
    render();
    $("connection").textContent = "● Live connection";
    if (selectedSpan) await showDetail(selectedSpan);
  } finally {
    loading = false;
    if (dirty) { dirty = false; queueMicrotask(() => refresh().catch((e) => notice(e.message))); }
  }
}
function render() {
  $("history").replaceChildren(...state.runs.map((r) => {
    const button = el("button", null, `history-item${r.id === selectedRun ? " active" : ""}`);
    button.append(el("span", r.status, `badge ${r.status}`), el("span", r.command, "history-name"));
    const meta = el("span", null, "history-meta");
    meta.append(el("span", new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), el("span", duration(r.durationMs)));
    button.append(meta); button.onclick = () => chooseRun(r.id);
    return button;
  }));
  const r = state.run;
  $("empty").hidden = !!r; $("workspace").hidden = !r;
  if (!r) return;
  $("run-status").replaceChildren(el("span", r.status, `badge ${r.status}`));
  $("run-name").textContent = r.command;
  $("run-meta").textContent = `${r.cwd} · ${r.version} · ${duration(r.durationMs)}`;
  $("cancel").hidden = r.status !== "running";
  $("finish").hidden = r.status !== "running" || !r.external;
  $("cloud").hidden = !r.cloudUrl;
  if (r.cloudUrl) $("cloud").href = r.cloudUrl;
  const m = r.summary;
  $("metrics").replaceChildren(...[
    [m.total, "TOTAL SPANS", ""],
    [`${m.cachedPercentage}%`, `${m.cached} CACHED`, ""],
    [`${m.executedPercentage}%`, `${m.executed} EXECUTED`, ""],
    [m.failed, `FAILED SPANS · ${m.rootCauses} ROOT CAUSES`, "failure"],
  ].map(([value, label, cls]) => {
    const metric = el("div", null, `metric ${cls}`);
    metric.append(el("strong", value), el("span", label));
    return metric;
  }));
  $("span-count").textContent = `Slowest: ${m.slowest.map((s) => `${s.name} ${duration(s.durationMs)}`).join(" · ") || "Waiting for telemetry"}`;
  $("errors").textContent = [...r.errors, ...(r.droppedSpans ? [`${r.droppedSpans} spans omitted (100,000 span safety cap).`] : [])].join("\n");
  $("footer-status").textContent = `${m.total} spans · ${duration(r.durationMs)} · ${r.version}`;
  nodes = new Map(r.tree.nodes.map((s) => [s.id, s]));
  rebuildVisible();
  const comparison = $("compare").value;
  $("compare").replaceChildren(el("option", "No comparison"));
  $("compare").firstChild.value = "";
  for (const other of state.runs.filter((x) => x.id !== r.id)) {
    const option = el("option", `${other.command} · ${duration(other.durationMs)}`);
    option.value = other.id; $("compare").append(option);
  }
  $("compare").value = comparison;
  if (!firstFailureShown.has(r.id) && r.tree.nodes.some((s) => s.rootCause)) {
    firstFailureShown.add(r.id);
    focusFailure();
  } else renderRows();
}
function rebuildVisible() {
  visible = [];
  const seen = new Set(), stack = [...(state.run?.tree.roots ?? [])].reverse().map((id) => [id, 0]);
  while (stack.length) {
    const [id, depth] = stack.pop(), node = nodes.get(id);
    if (!node || seen.has(id)) continue;
    seen.add(id); visible.push({ node, depth });
    if (!collapsed.has(id)) for (const child of [...node.children].reverse()) stack.push([child, depth + 1]);
  }
  $("tree-space").style.height = `${visible.length * ROW}px`;
}
function renderRows() {
  const start = Math.max(0, Math.floor($("tree").scrollTop / ROW) - 5);
  const end = Math.min(visible.length, start + Math.ceil($("tree").clientHeight / ROW) + 10);
  const run = state.run;
  if (!run) return;
  const min = Math.min(run.startedAt, ...run.tree.nodes.map((s) => s.start).filter((n) => n > 0));
  const range = Math.max(1, (run.endedAt ?? Date.now()) - min);
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const { node: s, depth } = visible[i];
    const row = el("div", null, `tree-row${s.id === selectedSpan ? " selected" : ""}${s.status === "failed" && !s.rootCause ? " propagated" : ""}`);
    row.id = `row-${i}`; row.style.top = `${i * ROW}px`;
    row.setAttribute("role", "treeitem"); row.setAttribute("aria-level", depth + 1);
    row.setAttribute("aria-selected", s.id === selectedSpan);
    row.setAttribute("aria-label", `${s.name}, ${s.status}, ${duration(s.durationMs)}`);
    if (s.children.length) row.setAttribute("aria-expanded", !collapsed.has(s.id));
    const operation = el("div", null, "operation");
    operation.style.paddingLeft = `${Math.min(depth, 12) * 14}px`;
    const toggle = el("span", s.children.length ? collapsed.has(s.id) ? "▸" : "▾" : "·", "toggle");
    toggle.onclick = (event) => {
      event.stopPropagation();
      if (s.children.length) { if (collapsed.has(s.id)) collapsed.delete(s.id); else collapsed.add(s.id); rebuildVisible(); renderRows(); }
    };
    operation.append(toggle, document.createTextNode(s.name));
    operation.title = s.name;
    const timing = el("div", null, "timing"), track = el("div", null, "track"), bar = el("i", null, `bar ${s.status}`);
    bar.style.left = `${Math.max(0, (s.start - min) / range * 100)}%`;
    bar.style.width = `${Math.min(100, s.durationMs / range * 100)}%`;
    track.append(bar); timing.append(el("span", duration(s.durationMs)), track);
    row.append(operation, el("span", s.rootCause ? "● failed" : s.recovered ? "recovered" : s.status, `badge ${s.status}`), timing);
    row.onclick = () => selectSpan(s.id);
    fragment.append(row);
  }
  $("tree-space").replaceChildren(fragment);
  const index = visible.findIndex((v) => v.node.id === selectedSpan);
  if (index >= start && index < end) $("tree").setAttribute("aria-activedescendant", `row-${index}`);
  else $("tree").removeAttribute("aria-activedescendant");
}
function selectSpan(id, scroll = false) {
  selectedSpan = id;
  if (scroll) {
    const index = visible.findIndex((v) => v.node.id === id);
    if (index >= 0) $("tree").scrollTop = Math.max(0, index * ROW - ROW * 3);
  }
  renderRows(); showDetail(id).catch((e) => notice(e.message));
}
function focusFailure() {
  const failed = state.run?.tree.nodes.find((s) => s.rootCause) ?? state.run?.tree.nodes.find((s) => s.status === "failed");
  if (!failed) return;
  let parent = nodes.get(failed.parentId);
  const seen = new Set();
  while (parent && !seen.has(parent.id)) { seen.add(parent.id); collapsed.delete(parent.id); parent = nodes.get(parent.parentId); }
  rebuildVisible(); selectSpan(failed.id, true);
}
function ansi(text) {
  const fragment = document.createDocumentFragment();
  const safe = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[\d;]*[A-HJKSTfhlnsu]/g, "");
  const colors = { 31: "ansi-red", 91: "ansi-red", 32: "ansi-green", 92: "ansi-green", 33: "ansi-yellow", 34: "ansi-blue", 36: "ansi-blue" };
  let classes = new Set(), offset = 0;
  for (const match of safe.matchAll(/\x1b\[([\d;]*)m/g)) {
    fragment.append(el("span", safe.slice(offset, match.index), [...classes].join(" ")));
    for (const code of (match[1] || "0").split(";").map(Number)) {
      if (code === 0) classes = new Set();
      else if (code === 1) classes.add("ansi-bold");
      else if (code === 22) classes.delete("ansi-bold");
      else if (code === 39) classes = new Set([...classes].filter((c) => c === "ansi-bold"));
      else if (colors[code]) { classes = new Set([...classes].filter((c) => c === "ansi-bold")); classes.add(colors[code]); }
    }
    offset = match.index + match[0].length;
  }
  fragment.append(el("span", safe.slice(offset), [...classes].join(" ")));
  return fragment;
}
async function showDetail(id) {
  const request = ++detailRequest, runId = selectedRun;
  const log = await action("get_span_logs", { runId, spanId: id });
  if (request !== detailRequest || runId !== selectedRun) return;
  const s = nodes.get(id);
  $("detail-name").textContent = s?.name || "Dagger process output";
  $("detail-error").textContent = s?.error || "";
  $("logs").replaceChildren();
  for (const entry of log.entries) {
    const line = el("span", null, entry.stream === "stderr" ? "stderr" : "");
    line.append(ansi(entry.text)); $("logs").append(line);
  }
  if (!log.entries.length) $("logs").textContent = "No logs emitted for this span.";
  $("truncation").textContent = log.truncated ? "TRUNCATED AT 1 MB / 10,000 RECORDS" : "";
  if (s) {
    const full = await action("get_run", { runId });
    if (request !== detailRequest || runId !== selectedRun) return;
    const span = full.tree.nodes.find((n) => n.id === id);
    $("attributes").textContent = JSON.stringify({ rawStatus: span?.rawStatus, recovered: span?.recovered,
      errorOriginIds: span?.errorOriginIds, attributes: span?.attributes, events: span?.events }, null, 2);
  } else $("attributes").textContent = "";
}
$("launcher").onsubmit = async (event) => {
  event.preventDefault(); notice(); $("run").disabled = true;
  try { const r = await action("start_run", { cwd: $("cwd").value, command: $("command").value }); chooseRun(r.runId); }
  catch (error) { notice(error.message); }
  finally { $("run").disabled = false; }
};
$("command").oninput = () => { $("command").dataset.edited = "true"; };
$("external").onclick = async () => {
  try {
    const r = await action("prepare_external", { cwd: $("cwd").value });
    $("snippet").textContent = r.snippet; $("export").hidden = false; chooseRun(r.runId);
  } catch (error) { notice(error.message); }
};
$("close-export").onclick = () => { $("export").hidden = true; };
$("cancel").onclick = async () => {
  try { await action("cancel_run", { runId: selectedRun }); await refresh(); }
  catch (error) { notice(error.message); }
};
$("finish").onclick = async () => {
  try { await action("finish_external", { runId: selectedRun }); await refresh(); }
  catch (error) { notice(error.message); }
};
$("failure").onclick = focusFailure;
$("process-logs").onclick = () => selectSpan("process");
$("tree").onscroll = () => requestAnimationFrame(renderRows);
$("tree").onkeydown = (event) => {
  let index = visible.findIndex((v) => v.node.id === selectedSpan), current = visible[index];
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "ArrowDown") index = Math.min(visible.length - 1, index + 1);
  else if (event.key === "ArrowUp") index = Math.max(0, index - 1);
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = visible.length - 1;
  else if (current && event.key === "ArrowRight") {
    if (collapsed.has(current.node.id)) { collapsed.delete(current.node.id); rebuildVisible(); }
    else if (current.node.children.length) index++;
  } else if (current && event.key === "ArrowLeft") {
    if (current.node.children.length && !collapsed.has(current.node.id)) { collapsed.add(current.node.id); rebuildVisible(); }
    else index = visible.findIndex((v) => v.node.id === current.node.parentId);
  } else if (current) { showDetail(current.node.id).catch((e) => notice(e.message)); return; }
  if (visible[index]) selectSpan(visible[index].node.id, true);
};
$("compare").onchange = async () => {
  const id = $("compare").value; $("comparison").hidden = !id;
  if (!id) return;
  try {
    const other = await action("get_run", { runId: id });
    const r = state.run, delta = r.durationMs - other.durationMs;
    const otherSpans = new Map(other.summary.slowest.map((s) => [s.name, s.durationMs]));
    $("comparison").textContent = `Total: ${delta >= 0 ? "+" : ""}${duration(Math.abs(delta))} ${delta >= 0 ? "slower" : "faster"} than ${other.version}\n` +
      r.summary.slowest.map((s) => `${s.name}: ${duration(s.durationMs)}${otherSpans.has(s.name) ? ` (previous ${duration(otherSpans.get(s.name))})` : " (not in previous top 5)"}`).join("\n");
  } catch (error) { notice(error.message); }
};
const events = new EventSource("events");
events.onmessage = () => refresh().catch((e) => notice(e.message));
events.onerror = () => { $("connection").textContent = "Reconnecting…"; };
setInterval(() => {
  if (state.run?.status !== "running") return;
  const now = Date.now(), run = state.run;
  run.durationMs = now - run.startedAt;
  for (const s of run.tree.nodes) if (!s.end) s.durationMs = Math.max(0, now - s.start);
  $("run-meta").textContent = `${run.cwd} · ${run.version} · ${duration(run.durationMs)}`;
  renderRows();
}, 250);
refresh().catch((e) => notice(e.message));
