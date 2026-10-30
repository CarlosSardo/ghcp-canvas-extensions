import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunManager } from "../lib/manager.mjs";

export async function managerFor(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dagger-runs-test-"));
  const manager = new RunManager({ directory, ...options });
  await manager.init();
  t.after(async () => { await manager.close(); await manager.saveQueue; await rm(directory, { recursive: true, force: true }); });
  return manager;
}
export const traceId = "0123456789abcdef0123456789abcdef";
export function value(v) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  if (v && typeof v === "object") return { kvlistValue: { values: attrs(v) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return { doubleValue: v };
  return { stringValue: String(v) };
}
export const attrs = (obj) => Object.entries(obj).map(([key, v]) => ({ key, value: value(v) }));
export function span(id, overrides = {}) {
  return { traceId, spanId: id.padStart(16, "0"), name: `span ${id}`,
    startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000001000000000", ...overrides };
}
export const traces = (...spans) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
export const logs = (...logRecords) => ({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });
export async function until(fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("Timed out waiting for condition");
}
