import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager } from "../lib/manager.mjs";
import { dispatcher } from "../lib/extension-core.mjs";
import { until, attrs } from "./helpers.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await fs.mkdtemp(path.join(tmpdir(), "dagger-runs-live-"));
await fs.copyFile(path.join(root, "examples", "pipeline.graphql"), path.join(directory, "pipeline.graphql"));
const manager = new RunManager({ directory, executable: process.env.DAGGER_RUNS_BINARY || "dagger",
  report: (m) => process.stderr.write(`${m}\n`) });
await manager.init();
const dispatch = dispatcher(manager);
const version = await manager.version(root);
const beta = version.startsWith("v1.");
const prefix = beta ? "dagger api query" : "dagger query";
const results = [], captures = [];
try {
  for (const operation of ["Build", "Build", "Fail"]) {
    const { runId } = await dispatch("start_run", { cwd: directory, command: `${prefix} --doc pipeline.graphql ${operation}` });
    let liveSeen = false;
    await until(() => {
      const run = manager.get(runId);
      if (run.tree.nodes.some((s) => s.status === "running")) liveSeen = true;
      return run.status !== "running";
    }, 180_000);
    const run = await dispatch("get_run", { runId });
    assert.equal(run.status, operation === "Fail" ? "failed" : "succeeded", JSON.stringify(await dispatch("get_failures", { runId })));
    assert.ok(run.summary.total > 0, "Real protobuf OTLP must reach receiver");
    assert.equal(run.errors.some((s) => s.startsWith("Malformed OTLP")), false, run.errors.join("\n"));
    if (operation === "Fail") {
      const failures = await dispatch("get_failures", { runId });
      assert.ok(failures.failedSpans.length);
      assert.equal(failures.failedSpans[0].rootCause, true, "Root-cause failures must come first");
      assert.ok(JSON.stringify(failures.failedSpans[0].logs).includes("expected 42, got 41"), "Root-cause logs must be inline");
      assert.ok(JSON.stringify(failures).includes("expected 42, got 41"), "Failure logs must reach span or process output");
      if (process.env.DAGGER_RUNS_RESULT_DIR) {
        await fs.mkdir(process.env.DAGGER_RUNS_RESULT_DIR, { recursive: true });
        await fs.writeFile(path.join(process.env.DAGGER_RUNS_RESULT_DIR, `${version}-failures.json`), JSON.stringify(failures, null, 2));
      }
      if (operation === "Build") assert.equal(run.summary.failed, 0, "A green run must not count recovered diagnostic errors");
    }
    const summary = { version, operation, status: run.status, liveSeen, ...run.summary };
    results.push(summary);
    const raw = manager.require(runId);
    const spans = Object.values(raw.spans).slice(0, 250).map((s) => ({
      traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentId?.split(":")[1] || "",
      name: s.name, startTimeUnixNano: String(BigInt(Math.round(s.start * 1e6))),
      endTimeUnixNano: s.end ? String(BigInt(Math.round(s.end * 1e6))) : "0",
      attributes: attrs(s.attributes), status: { code: s.status === "failed" ? 2 : 1, message: s.error },
      links: (s.links ?? []).map((l) => ({ traceId: l.id.split(":")[0], spanId: l.id.split(":")[1],
        attributes: attrs({ "dagger.io/link.purpose": l.purpose }) })),
    }));
    const logRecords = Object.entries(raw.logs).filter(([id]) => id !== "process").flatMap(([id, log]) => log.entries.slice(0, 30).map((e) => ({
      traceId: id.split(":")[0], spanId: id.split(":")[1], body: { stringValue: e.text },
      attributes: attrs({ "stdio.stream": e.stream === "stderr" ? "2" : "1" }),
    })));
    captures.push({ operation, traces: { resourceSpans: [{ scopeSpans: [{ spans }] }] },
      logs: { resourceLogs: [{ scopeLogs: [{ logRecords }] }] } });
  }
  assert.ok(results[1].cached > 0, "Second identical build must contain cached spans");
  assert.ok(results.some((r) => r.liveSeen), "Must observe at least one running span before completion");
  if (process.env.DAGGER_RUNS_RECORD === "1") {
    const fixtures = path.join(root, "test", "fixtures");
    await fs.mkdir(fixtures, { recursive: true });
    await fs.writeFile(path.join(fixtures, `${version}.json`), JSON.stringify({
      version, source: "Sanitized normalized live OTLP HTTP/protobuf capture, capped at 250 spans per operation",
      results, captures,
    }, null, 2));
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await manager.close(); await manager.saveQueue;
  await fs.rm(directory, { recursive: true, force: true });
}
