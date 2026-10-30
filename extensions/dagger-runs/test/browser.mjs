import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunManager } from "../lib/manager.mjs";
import { createPanel } from "../lib/extension-core.mjs";
import { traces, span } from "./helpers.mjs";

// Optional developer-only dependency; no browser code is loaded by the extension.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const directory = await fs.mkdtemp(path.join(tmpdir(), "dagger-runs-browser-"));
const manager = new RunManager({ directory });
await manager.init();
let browser, panel;
try {
  for (const [version, index] of [["v0.21.11", 1], ["v1.0.0-beta.21", 2]]) {
    const fixture = JSON.parse(await fs.readFile(new URL(`./fixtures/${version}.json`, import.meta.url)));
    const capture = fixture.captures[index];
    const { runId, endpoint } = await manager.external({ cwd: directory });
    const raw = manager.require(runId);
    raw.cwd = "/workspace/sample-pipeline";
    raw.version = version;
    for (const signal of ["traces", "logs"]) {
      const response = await fetch(`${endpoint}/v1/${signal}`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(capture[signal]) });
      assert.equal(response.status, 200);
    }
    const spans = Object.values(raw.spans);
    raw.command = spans.find((s) => !s.parentId)?.name || "Recorded Dagger run";
    raw.startedAt = Math.min(...spans.map((s) => s.start));
    await manager.finish(runId, capture.operation === "Fail" ? "failed" : "succeeded");
    raw.endedAt = Math.max(...spans.map((s) => s.end ?? s.start));
    manager.notify(raw);
  }
  const failed = manager.list().find((r) => r.status === "failed");
  panel = await createPanel(manager, { runId: failed.id, cwd: "/workspace/sample-pipeline" });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(panel.url);
  await page.waitForFunction(() => document.getElementById("logs").textContent.includes("expected 42, got 41"));
  assert.ok((await page.locator(".tree-row.selected .operation").textContent()).includes("withExec"), "Auto-focus must select the error_origin operation with logs");
  assert.ok(await page.locator("#logs .ansi-red").count(), "ANSI stderr must render with a safe color span");
  await page.locator("#tree").focus();
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowRight");
  await page.locator("#failure").click();
  await page.waitForFunction(() => document.getElementById("logs").textContent.includes("expected 42, got 41"));
  if (process.env.DAGGER_RUNS_SCREENSHOT) {
    await fs.mkdir(path.dirname(process.env.DAGGER_RUNS_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.DAGGER_RUNS_SCREENSHOT, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  assert.notEqual(await page.locator("body").evaluate((e) => getComputedStyle(e).backgroundColor), "rgb(13, 17, 23)");
  await page.locator("#compare").selectOption({ index: 1 });
  await page.waitForFunction(() => document.getElementById("comparison").textContent.includes("Total:"));
  // Replay 2,500 spans to test actual DOM virtualization, not just ingestion speed.
  const large = await manager.external({ cwd: process.cwd() });
  await fetch(`${large.endpoint}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces(...Array.from({ length: 2500 }, (_, i) =>
      span((i + 1).toString(16), i ? { parentSpanId: "1".padStart(16, "0") } : {})))) });
  await manager.finish(large.runId, "succeeded");
  await page.waitForFunction(() => [...document.querySelectorAll(".history-item")].some((e) => e.textContent.includes("External terminal")));
  await page.getByRole("button", { name: /External terminal export/ }).click();
  await page.waitForFunction(() => document.querySelector(".metric strong")?.textContent === "2500");
  assert.ok(await page.locator(".tree-row").count() < 40, "Large trees must not create one DOM row per span");
  await page.locator("#tree").focus(); await page.keyboard.press("End");
  await page.waitForFunction(() => document.querySelector(".tree-row.selected")?.textContent.includes("span 9c4"));
  assert.ok(await page.locator(".tree-row").count() < 40);
  await page.locator("#cwd").fill("/edited");
  await page.locator("#command").fill("dagger call edited");
  panel.updateInput({ runId: failed.id, cwd: "/reopened", command: "dagger call reopened" });
  await page.waitForFunction(() => document.getElementById("cwd").value === "/reopened" &&
    document.getElementById("command").value === "dagger call reopened" &&
    document.getElementById("run-status").textContent === "failed");
  assert.ok((await page.locator("#run-name").textContent()).includes("Fail"));
  panel.updateInput({ runId: large.runId });
  await page.waitForFunction(() => document.querySelector(".metric strong")?.textContent === "2500");
  assert.deepEqual(errors, []);
  process.stdout.write("Browser verification passed: root-cause auto-focus, ANSI logs, keyboard navigation, light/dark, comparison, and 2,500-span virtualization.\n");
} finally {
  if (browser) await browser.close();
  if (panel) await panel.close();
  await manager.close(); await manager.saveQueue;
  await fs.rm(directory, { recursive: true, force: true });
}
