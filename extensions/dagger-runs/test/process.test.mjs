import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { managerFor, until } from "./helpers.mjs";

const executable = fileURLToPath(new URL("./fake-dagger.mjs", import.meta.url));
test("process output is redacted across chunks; final non-newline output survives", async (t) => {
  const m = await managerFor(t, { executable, env: { ...process.env, DEMO_TOKEN: "split-secret-value" } });
  const { runId } = await m.start({ cwd: process.cwd(), command: "dagger output" });
  await until(() => m.get(runId).status !== "running");
  const logs = JSON.stringify(m.logs(runId, "process"));
  assert.ok(logs.includes("no-newline"));
  assert.ok(!logs.includes("split-secret-value"));
  assert.ok(!logs.includes("with spaces"));
  assert.equal(m.get(runId).status, "succeeded");
});
test("crashed processes have explicit failure and engine-unavailable diagnostics", async (t) => {
  const m = await managerFor(t, { executable });
  const { runId } = await m.start({ cwd: process.cwd(), command: "dagger crash" });
  await until(() => m.get(runId).status !== "running");
  const result = m.failures(runId);
  assert.equal(result.status, "failed");
  assert.ok(result.errors.some((s) => s.includes("exited 2")));
  assert.ok(JSON.stringify(result.processLogs).includes("Engine unavailable"));
});
test("cancel kills descendants, including a child that ignores SIGTERM", { skip: process.platform === "win32" }, async (t) => {
  const m = await managerFor(t, { executable });
  const { runId } = await m.start({ cwd: process.cwd(), command: "dagger tree" });
  const pid = await until(() => {
    const text = m.logs(runId, "process").entries.map((e) => e.text).join("");
    return text.includes("descendant-ready") && Number(text.match(/descendant=(\d+)/)?.[1]) || false;
  });
  const cancelledAt = Date.now();
  assert.equal((await m.cancel(runId)).status, "cancelling");
  await until(() => m.get(runId).status === "cancelled", 10_000);
  assert.ok(Date.now() - cancelledAt >= 1800, "SIGKILL escalation must be needed for the SIGTERM-ignoring child");
  await until(async () => {
    try { return (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2] === "Z"; }
    catch (error) { if (error.code === "ENOENT") return true; throw error; }
  }, 10_000);
});
