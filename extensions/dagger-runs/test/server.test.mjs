import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, rename } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { request } from "node:http";
import { RunManager, parseCommand, exporterEnv } from "../lib/manager.mjs";
import { createPanel, dispatcher, validate, inputSchema, actionDefinitions } from "../lib/extension-core.mjs";
import { managerFor, span, traces, logs, traceId } from "./helpers.mjs";

test("command tokenization permits quoted literal args but never shells, paths, or expansions", () => {
  assert.deepEqual(parseCommand('dagger api query --doc "/tmp/my query.graphql" Fail'), ["api", "query", "--doc", "/tmp/my query.graphql", "Fail"]);
  for (const bad of ["echo dagger", "/bin/dagger call test", "dagger call test; touch nope", "dagger $(evil)", "dagger call 'oops", "dagger"]) assert.throws(() => parseCommand(bad));
  assert.deepEqual(parseCommand('dagger call test --message "hello; $(not expanded)"'), ["call", "test", "--message", "hello; $(not expanded)"]);
  const env = exporterEnv("http://127.0.0.1:123/a", { PATH: "/bin", OTEL_EXPORTER_OTLP_HEADERS: "auth=do-not-forward" });
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(env.OTEL_EXPORTER_OTLP_TRACES_LIVE, "1");
});
test("all action schemas reject unknown/missing/wrong types", () => {
  validate(inputSchema, { cwd: "/tmp", command: "dagger version" });
  assert.throws(() => validate(inputSchema, { extra: true }));
  for (const action of actionDefinitions) {
    assert.throws(() => validate(action.inputSchema, { unknown: "x" }));
    for (const key of action.inputSchema.required) assert.throws(() => validate(action.inputSchema, { [key]: 1 }));
  }
});
test("receiver ingests JSON and gzip, persists history, validates failures and every action", async (t) => {
  const m = await managerFor(t), dispatch = dispatcher(m);
  const external = await dispatch("prepare_external", { cwd: process.cwd() });
  assert.ok(external.snippet.includes("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"));
  const response = await fetch(`${external.endpoint}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: gzipSync(JSON.stringify(traces(span("1", { status: { code: 2, message: "deliberate failure" } })))) });
  assert.equal(response.status, 200);
  await fetch(`${external.endpoint}/v1/logs`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(logs({ traceId, spanId: "1".padStart(16, "0"), body: { stringValue: "failure output\n" } })) });
  assert.equal((await dispatch("get_run", { runId: external.runId })).summary.failed, 1);
  assert.equal((await dispatch("list_runs", {})).length, 1);
  assert.equal((await dispatch("get_span_logs", { runId: external.runId, spanId: "1".padStart(16, "0") })).entries[0].text, "failure output\n");
  assert.equal((await dispatch("get_failures", { runId: external.runId })).failedSpans.length, 1);
  await assert.rejects(dispatch("get_run", { runId: "missing" }), /not found/);
  await assert.rejects(dispatch("get_span_logs", { runId: external.runId, spanId: "missing" }), /not found/);
  await assert.rejects(dispatch("start_run", { cwd: "/tmp", command: "sh -c evil" }), /Only commands/);
  assert.equal((await dispatch("finish_external", { runId: external.runId })).status, "failed");
  await assert.rejects(dispatch("cancel_run", { runId: external.runId }), /not active/);
  const second = await dispatch("prepare_external", { cwd: process.cwd() });
  assert.equal((await dispatch("cancel_run", { runId: second.runId })).status, "cancelled");
  await m.persist();
  const loaded = new RunManager({ directory: m.directory });
  await loaded.init();
  await loaded.close();
  assert.equal(loaded.list().length, 2);
  const file = path.join(m.directory, `${external.runId}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok((await readFile(file, "utf8")).includes("deliberate failure"));
});
test("receiver rejects hostile origins, malformed OTLP and unknown endpoints; panel is capability guarded", async (t) => {
  const m = await managerFor(t), external = await m.external({ cwd: process.cwd() });
  for (const headers of [{ Origin: "https://evil.example" }, { Host: "evil.example" }]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(`${external.endpoint}/v1/traces`, { method: "POST", headers }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(status, 403);
  }
  const malformed = await fetch(`${external.endpoint}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.ok(m.get(external.runId).errors[0].startsWith("Malformed OTLP"));
  assert.equal((await fetch(`${external.endpoint}/bad`, { method: "POST" })).status, 404);
  const panel = await createPanel(m);
  t.after(() => panel.close());
  assert.equal((await fetch(panel.url)).status, 200);
  assert.equal((await fetch(panel.url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 200);
  assert.equal((await fetch(new URL("state", panel.url), { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(new URL("/", panel.url))).status, 404);
  assert.equal((await fetch(new URL("state", panel.url))).status, 200);
  const badAction = await fetch(new URL("actions/start_run", panel.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(badAction.status, 400);
  const index = await (await fetch(panel.url)).text();
  assert.ok(index.includes('role="tree"'));
});
test("history keeps latest N completed runs, preserves active, and marks interrupted on reload", async (t) => {
  const m = await managerFor(t, { limit: 2 });
  for (let i = 0; i < 3; i++) {
    const r = await m.external({ cwd: process.cwd() });
    await m.finish(r.runId, "succeeded");
    await new Promise((r) => setTimeout(r, 2));
  }
  const active = await m.external({ cwd: process.cwd() });
  m.require(active.runId).ownerPid = -1;
  await m.persist();
  assert.equal(m.list(100).length, 3);
  const loaded = new RunManager({ directory: m.directory });
  await loaded.init();
  await loaded.close();
  assert.equal(loaded.get(active.runId).status, "interrupted");
});
test("missing Dagger has a friendly install URL and does not create false successful runs", async (t) => {
  const m = await managerFor(t, { executable: "/no/such/dagger" });
  await assert.rejects(m.start({ cwd: process.cwd(), command: "dagger call test" }), /https:\/\/docs.dagger.io\/install/);
  assert.equal(m.list().length, 0);
});
test("providers merge separate run files without interrupting or overwriting another live owner", async (t) => {
  const first = await managerFor(t), second = new RunManager({ directory: first.directory });
  await second.init();
  const a = await first.external({ cwd: process.cwd() }), b = await second.external({ cwd: process.cwd() });
  await Promise.all([first.persist(), second.persist()]);
  await first.syncHistory(); await second.syncHistory();
  assert.equal(first.get(b.runId).status, "running");
  assert.equal(second.get(a.runId).status, "running");
  assert.equal(first.list().length, 2); assert.equal(second.list().length, 2);
  await second.close();
});
test("persistence failures are explicit and retry dirty data instead of reporting success", async (t) => {
  const reports = [], manager = await managerFor(t, { report: (m) => reports.push(m) });
  const { runId } = await manager.external({ cwd: process.cwd() });
  const moved = `${manager.directory}-moved`;
  await rename(manager.directory, moved);
  try {
    await assert.rejects(manager.persist(), /Unable to save run history/);
    assert.ok(manager.get(runId).storageError);
    assert.ok(reports.length);
  } finally { await rename(moved, manager.directory); }
  await manager.persist();
  assert.equal(manager.get(runId).storageError, null);
  assert.ok((await readFile(path.join(manager.directory, `${runId}.json`), "utf8")).includes(runId));
});
test("continuous telemetry is checkpointed during a run, not postponed until it finishes", async (t) => {
  const m = await managerFor(t), { runId } = await m.external({ cwd: process.cwd() });
  for (let i = 0; i < 6; i++) {
    m.notify(m.require(runId));
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const saved = JSON.parse(await readFile(path.join(m.directory, `${runId}.json`), "utf8"));
  assert.equal(saved.status, "running");
});
