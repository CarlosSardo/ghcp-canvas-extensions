import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { RunManager } from "./manager.mjs";
import { body, guard, json, listen } from "./http.mjs";

const str = { type: "string", minLength: 1, maxLength: 32768 };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const inputSchema = object({ cwd: str, command: str, runId: str });
export const actionDefinitions = [
  ["start_run", "Launch a local dagger command without a shell; returns runId and detected version.", object({ cwd: str, command: str }, ["cwd", "command"])],
  ["cancel_run", "Cancel a running Dagger process and its descendants (or stop an external receiver).", object({ runId: str }, ["runId"])],
  ["get_run", "Read run status, durationMs, errors, summary and structured tree {roots,nodes}; node children are composite IDs.", object({ runId: str }, ["runId"])],
  ["list_runs", "List newest run summaries from persistent user history; limit defaults to 20.", object({ limit: { type: "integer", minimum: 1, maximum: 100 } })],
  ["get_span_logs", "Read redacted stdout/stderr entries and truncation flag for a span; use composite id or process.", object({ runId: str, spanId: str }, ["runId", "spanId"])],
  ["get_failures", "Read failed spans with redacted logs, run errors, and process output.", object({ runId: str }, ["runId"])],
  ["prepare_external", "Create an external-run receiver and shell export snippet; no Dagger process is launched.", object({ cwd: str }, ["cwd"])],
  ["finish_external", "Finish an external run after its terminal command exits; pass failed=true on failure.", object({ runId: str, failed: { type: "boolean" } }, ["runId"])],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

export function validate(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  for (const key of schema.required) if (!(key in input)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(input)) {
    const rule = schema.properties[key];
    if (!rule) throw new Error(`Unknown input field ${key}`);
    if (rule.type === "string" && (typeof value !== "string" || !value.length || value.length > rule.maxLength))
      throw new Error(`${key} must be a nonempty string, at most ${rule.maxLength} characters`);
    if (rule.type === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be boolean`);
    if (rule.type === "integer" && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum))
      throw new Error(`${key} must be an integer from ${rule.minimum} to ${rule.maximum}`);
  }
}

export function dispatcher(manager) {
  return async (name, input = {}) => {
    const action = actionDefinitions.find((a) => a.name === name);
    if (!action) throw new Error("Unknown action");
    validate(action.inputSchema, input);
    switch (name) {
      case "start_run": return manager.start(input);
      case "cancel_run": return manager.cancel(input.runId);
      case "get_run": return manager.get(input.runId);
      case "list_runs": return manager.list(input.limit);
      case "get_span_logs": return manager.logs(input.runId, input.spanId);
      case "get_failures": return manager.failures(input.runId);
      case "prepare_external": return manager.external(input);
      case "finish_external": {
        const active = manager.active.get(input.runId);
        if (active?.child) throw new Error("Only external runs can be finished manually");
        const failed = input.failed || manager.get(input.runId).summary.failed > 0;
        return manager.finish(input.runId, failed ? "failed" : "succeeded");
      }
    }
  };
}

export async function createPanel(manager, input = {}) {
  const token = randomUUID();
  const base = `/${token}`;
  const dispatch = dispatcher(manager), clients = new Set();
  let entry, timer;
  const notify = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const res of clients) if (!res.writableNeedDrain) res.write("data: changed\n\n");
    }, 200);
  };
  manager.listeners.add(notify);
  const assets = new Map(await Promise.all(["index.html", "app.js", "styles.css"].map(async (name) =>
    [name, await fs.readFile(new URL(`../ui/${name}`, import.meta.url))])));
  entry = await listen(async (req, res) => {
    const url = new URL(req.url, entry.origin);
    const staticAsset = req.method === "GET" && ["/", "/app.js", "/styles.css"].some((route) => url.pathname === `${base}${route}`);
    // The host's cross-site iframe navigation may load static assets, never data/actions.
    guard(req, entry.origin, staticAsset);
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!url.pathname.startsWith(`${base}/`)) return json(res, { error: "Not found" }, 404);
    const route = url.pathname.slice(base.length);
    if (req.method === "GET" && route === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write("data: connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (req.method === "GET" && route === "/state") {
      const id = url.searchParams.get("runId") || input.runId;
      const run = id ? manager.get(id) : null;
      if (run) run.tree.nodes = run.tree.nodes.map(({ attributes: _attrs, events: _events, ...s }) => s);
      json(res, { runs: manager.list(), run, prefill: input, error: manager.error });
    } else if (req.method === "POST" && route.startsWith("/actions/")) {
      try {
        json(res, await dispatch(route.slice("/actions/".length), JSON.parse((await body(req, 64 * 1024)).toString())));
      } catch (error) { json(res, { error: manager.redact.text(error.message) }, 400); }
    } else if (req.method === "GET") {
      const name = route === "/" ? "index.html" : route.slice(1);
      if (!assets.has(name)) return json(res, { error: "Not found" }, 404);
      res.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html" });
      res.end(assets.get(name));
    } else json(res, { error: "Not found" }, 404);
  });
  return { url: `${entry.origin}${base}/`, close: async () => {
    clearTimeout(timer);
    manager.listeners.delete(notify);
    for (const res of clients) res.end();
    await entry.close();
  } };
}

export async function createExtension({ CanvasError, createCanvas, joinSession }) {
  const manager = new RunManager({ report: (message) => { process.stderr.write(`${message}\n`); } });
  await manager.init();
  const panels = new Map(), dispatch = dispatcher(manager);
  await joinSession({ canvases: [createCanvas({
    id: "dagger-runs", displayName: "Dagger Runs",
    description: "Launch, inspect and compare local Dagger runs with live nested OTLP spans and redacted logs.",
    inputSchema,
    actions: actionDefinitions.map((definition) => ({ ...definition, handler: async (ctx) => {
      try { return await dispatch(ctx.actionName, ctx.input ?? {}); }
      catch (error) { throw new CanvasError("dagger_runs_error", manager.redact.text(error.message)); }
    } })),
    open: async (ctx) => {
      const input = ctx.input ?? {};
      validate(inputSchema, input);
      if (input.runId) manager.require(input.runId);
      let panel = panels.get(ctx.instanceId);
      if (!panel) {
        panel = await createPanel(manager, input);
        panels.set(ctx.instanceId, panel);
      }
      return { title: "Dagger Runs", url: panel.url };
    },
    onClose: async (ctx) => {
      const panel = panels.get(ctx.instanceId);
      panels.delete(ctx.instanceId);
      if (panel) await panel.close();
    },
  })] });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      for (const panel of panels.values()) await panel.close();
      await manager.close();
    } catch (error) { process.stderr.write(`${manager.redact.text(error.message)}\n`); process.exitCode = 1; }
    setTimeout(() => process.exit(process.exitCode ?? 0), 2500);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { manager, panels };
}
