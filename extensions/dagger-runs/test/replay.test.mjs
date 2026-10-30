import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { managerFor } from "./helpers.mjs";

for (const version of ["v0.21.11", "v1.0.0-beta.21"]) {
  test(`recorded ${version} traces replay through the HTTP receiver with cache and failure logs`, async (t) => {
    const fixture = JSON.parse(await readFile(new URL(`./fixtures/${version}.json`, import.meta.url), "utf8"));
    assert.equal(fixture.version, version);
    const manager = await managerFor(t);
    for (const capture of fixture.captures) {
      const { runId, endpoint } = await manager.external({ cwd: process.cwd() });
      for (const signal of ["traces", "logs"]) {
        const response = await fetch(`${endpoint}/v1/${signal}`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(capture[signal]) });
        assert.equal(response.status, 200);
      }
      const run = manager.get(runId);
      assert.ok(run.summary.total > 20);
      if (capture.operation === "Fail") {
        assert.ok(run.summary.failed > 0);
        assert.ok(JSON.stringify(manager.failures(runId)).includes("expected 42, got 41"));
      }
      await manager.finish(runId, capture.operation === "Fail" ? "failed" : "succeeded");
    }
    assert.ok(manager.list().some((r) => r.summary.cached > 0));
  });
}
