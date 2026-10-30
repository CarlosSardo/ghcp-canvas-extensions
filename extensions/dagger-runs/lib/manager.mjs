import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendLog, ingest, makeRun, snapshot } from "./model.mjs";
import { decodeOTLP } from "./otlp.mjs";
import { redactor } from "./redact.mjs";
import { body, guard, json, listen } from "./http.mjs";

const exec = promisify(execFile);
export const historyDirectory = () => path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"),
  "extensions", "dagger-runs", "artifacts");

export function parseCommand(command) {
  if (typeof command !== "string" || command.length > 32_768) throw new Error("Provide a dagger command (maximum 32 KB)");
  const args = [];
  let token = "", quote = "", escaped = false, started = false;
  for (const ch of command.trim()) {
    if (escaped) { token += ch; escaped = false; started = true; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (ch === quote) quote = ""; else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { args.push(token); token = ""; started = false; } }
    else {
      if (/[;&|<>`$()\u0000-\u001f]/.test(ch)) throw new Error("Shell operators/expansion are not supported; quote command arguments");
      token += ch; started = true;
    }
  }
  if (quote || escaped) throw new Error("Unterminated command quote or escape");
  if (started) args.push(token);
  if (args.shift() !== "dagger") throw new Error("Only commands whose first token is dagger are allowed");
  if (!args.length) throw new Error("Provide a Dagger subcommand");
  return args;
}

export function exporterEnv(endpoint, env = process.env) {
  // Do not forward inherited exporter auth headers or metrics to a local receiver.
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("OTEL_EXPORTER_")));
  return { ...clean, DAGGER_NO_NAG: "1",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_TRACES_LIVE: "1" };
}

export class RunManager {
  constructor({ directory = historyDirectory(), limit = 20, executable = "dagger", env = process.env, report = () => {} } = {}) {
    this.directory = directory;
    this.limit = limit;
    this.executable = executable;
    this.env = env;
    this.report = report;
    this.redact = redactor(env);
    this.runs = new Map();
    this.active = new Map();
    this.listeners = new Set();
    this.saveQueue = Promise.resolve();
    this.dirty = new Set();
    this.owned = new Set();
    this.persisted = new Set();
    this.error = null;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Migrate the pre-release development store without discarding its history.
    let data;
    try { data = await fs.readFile(path.join(this.directory, "history.json"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (data) {
      const saved = JSON.parse(data);
      if (!Array.isArray(saved)) throw new Error("Dagger Runs history is invalid; preserve history.json and repair or move it aside");
      for (const run of saved) {
        if (!/^[\da-f-]{36}$/.test(run?.id ?? "")) throw new Error("Invalid saved run ID");
        try {
          await fs.writeFile(path.join(this.directory, `${run.id}.json`), JSON.stringify(this.redact.clean(run)), { flag: "wx", mode: 0o600 });
        } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      try { await fs.rename(path.join(this.directory, "history.json"), path.join(this.directory, "history.legacy.json")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await this.syncHistory();
    await this.persist();
    this.syncTimer = setInterval(() => {
      this.syncHistory().catch((error) => {
        this.error = `Unable to read run history: ${this.redact.text(error.message)}`;
        this.report(this.error);
        for (const fn of this.listeners) fn(null);
      });
    }, 2000);
    this.syncTimer.unref();
  }
  async syncHistory() {
    const files = (await fs.readdir(this.directory)).filter((name) => /^[\da-f-]{36}\.json$/.test(name));
    for (const file of files) {
      let raw;
      try { raw = await fs.readFile(path.join(this.directory, file), "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const run = JSON.parse(raw);
      if (run?.id !== file.slice(0, -5) || !run.spans || !run.logs) throw new Error("Invalid saved run");
      this.persisted.add(run.id);
      if (this.owned.has(run.id)) continue;
      let alive = false;
      if (Number.isInteger(run.ownerPid) && run.ownerPid > 0) {
        try { process.kill(run.ownerPid, 0); alive = true; }
        catch (error) { if (error.code === "EPERM") alive = true; else if (error.code !== "ESRCH") throw error; }
      }
      if (run.status === "running" && !alive) {
        run.status = "interrupted"; run.endedAt = Date.now();
        run.errors.push("Provider stopped before this run completed; process ownership cannot be recovered.");
        this.dirty.add(run.id);
      }
      this.runs.set(run.id, this.redact.clean(run));
    }
    const present = new Set(files.map((file) => file.slice(0, -5)));
    for (const id of this.persisted) {
      if (!present.has(id) && !this.active.has(id) && !this.dirty.has(id)) {
        this.runs.delete(id); this.owned.delete(id); this.persisted.delete(id);
      }
    }
    for (const fn of this.listeners) fn(null);
  }
  notify(run) {
    this.dirty.add(run.id);
    for (const fn of this.listeners) fn(run.id);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.persist().catch((error) => this.report(error.message));
    }, 300);
  }
  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const updates = [...this.dirty].filter((id) => this.runs.has(id)).map((id) =>
      [id, JSON.stringify(this.redact.clean(this.runs.get(id)))]);
    this.dirty.clear();
    const write = async () => {
      for (const [id, data] of updates) {
        const target = path.join(this.directory, `${id}.json`);
        await fs.writeFile(`${target}.${process.pid}.tmp`, data, { mode: 0o600 });
        await fs.rename(`${target}.${process.pid}.tmp`, target);
        this.persisted.add(id);
      }
      const completed = [...this.runs.values()].filter((r) => r.status !== "running").sort((a, b) => b.startedAt - a.startedAt);
      for (const run of completed.slice(this.limit)) {
        this.runs.delete(run.id); this.owned.delete(run.id);
        this.persisted.delete(run.id);
        try { await fs.unlink(path.join(this.directory, `${run.id}.json`)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (this.error?.startsWith("Unable to save")) this.error = null;
    };
    this.saveQueue = this.saveQueue.then(write, write).catch((error) => {
      for (const [id] of updates) this.dirty.add(id);
      this.error = "Unable to save run history; check the extension artifacts directory permissions.";
      this.report(`${this.error} ${this.redact.text(error.message)}`);
      for (const fn of this.listeners) fn(null);
      throw new Error(this.error, { cause: error });
    });
    return this.saveQueue;
  }
  require(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    return run;
  }
  get(id) { return { ...snapshot(this.require(id)), storageError: this.error }; }
  list(limit = this.limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
      .map((r) => { const { tree: _tree, ...meta } = snapshot(r); return meta; });
  }
  logs(id, spanId) {
    const r = this.require(id);
    let key = spanId;
    if (key !== "process" && !r.spans[key] && !r.logs[key]) {
      const candidates = Object.keys(r.spans).filter((k) => r.spans[k].spanId === spanId);
      if (candidates.length !== 1) throw new Error("Span not found or ambiguous; use the composite id from get_run");
      [key] = candidates;
    }
    return this.redact.clean({ spanId: key, ...(r.logs[key] ?? { entries: [], bytes: 0, truncated: false }) });
  }
  failures(id) {
    const r = this.get(id);
    const failed = r.tree.nodes.filter((s) => s.status === "failed")
      .sort((a, b) => Number(b.rootCause) - Number(a.rootCause) || a.start - b.start);
    return { runId: id, status: r.status, errors: r.errors,
      rootCauseIds: failed.filter((s) => s.rootCause).map((s) => s.id),
      failedSpans: failed.map((s) => ({ ...s, propagated: !s.rootCause, logs: this.logs(id, s.id) })),
      processLogs: this.logs(id, "process") };
  }
  async receiver(run) {
    const token = randomUUID();
    let entry;
    entry = await listen(async (req, res) => {
      guard(req, entry.origin);
      const signal = req.url === `/${token}/v1/traces` ? "traces" : req.url === `/${token}/v1/logs` ? "logs" : null;
      if (req.method !== "POST" || !signal) return json(res, { error: "Not found" }, 404);
      try {
        const payload = decodeOTLP(await body(req), signal, req.headers["content-type"]);
        ingest(run, payload, signal, this.redact);
        this.notify(run);
        const protobuf = req.headers["content-type"]?.includes("application/x-protobuf");
        res.writeHead(200, { "Content-Type": protobuf ? "application/x-protobuf" : "application/json" });
        res.end(protobuf ? Buffer.alloc(0) : "{}");
      } catch (error) {
        const message = `Malformed OTLP ${signal}: ${this.redact.text(error.message)}`;
        if (run.errors.at(-1) !== message && run.errors.length < 100) run.errors.push(message);
        this.notify(run);
        json(res, { error: message }, error.status ?? 400);
      }
    });
    return { ...entry, endpoint: `${entry.origin}/${token}` };
  }
  async create(cwd, command, version) {
    if (this.active.size >= 4) throw new Error("At most four runs may be active; finish or cancel one first");
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory())
      throw new Error("cwd must be an existing absolute directory");
    const run = makeRun(randomUUID(), this.redact.text(cwd), this.redact.text(command), version);
    run.ownerPid = process.pid;
    const receiver = await this.receiver(run);
    this.runs.set(run.id, run);
    this.owned.add(run.id);
    this.active.set(run.id, { receiver });
    this.notify(run);
    return run;
  }
  async version(cwd) {
    try {
      const { stdout } = await exec(this.executable, ["version"], { cwd, env: this.env, timeout: 10_000, maxBuffer: 64 * 1024 });
      const v = stdout.match(/v?\d+\.\d+\.\d+(?:-[\w.]+)?/);
      if (!v) throw new Error("Unrecognized dagger version output");
      return v[0].startsWith("v") ? v[0] : `v${v[0]}`;
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("Dagger is missing from PATH. Install it: https://docs.dagger.io/install", { cause: error });
      throw new Error(`Could not detect Dagger version: ${this.redact.text(error.message)}`, { cause: error });
    }
  }
  async start({ cwd, command }) {
    const args = parseCommand(command);
    for (let i = 0; i < args.length; i++) {
      if (/^--?[^=]*(?:token|secret|password|key)/i.test(args[i])) {
        const [name, value] = args[i].split("=", 2);
        this.redact.capture(value ?? args[i + 1], name);
      }
    }
    const version = await this.version(cwd);
    const run = await this.create(cwd, command, version);
    const active = this.active.get(run.id);
    const child = spawn(this.executable, args, { cwd, env: exporterEnv(active.receiver.endpoint, this.env),
      shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    active.child = child;
    for (const [stream, pipe] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
      const decoder = new StringDecoder("utf8");
      let pending = "", discard = false;
      const consume = (chunk, final = false) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        if (final && pending) { lines.push(pending); pending = ""; }
        for (const line of lines) {
          if (!discard) appendLog(run, "process", stream, `${line}\n`, this.redact);
          discard = false;
        }
        if (pending.length > 1024 * 1024) {
          pending = ""; discard = true;
          appendLog(run, "process", stream, "[oversized output line omitted]\n", this.redact);
        }
        this.notify(run);
      };
      pipe.on("data", (chunk) => consume(decoder.write(chunk)));
      pipe.on("end", () => consume(decoder.end(), true));
    }
    child.once("error", (error) => {
      run.errors.push(`Dagger process failed: ${this.redact.text(error.message)}`);
    });
    active.done = new Promise((resolve) => child.once("close", async (code, signal) => {
      if (!active.cancelled) clearTimeout(active.killTimer);
      const status = active.cancelled ? "cancelled" : code === 0 ? "succeeded" : "failed";
      if (status === "failed") {
        run.errors.push(`Dagger exited ${code ?? signal ?? "unexpectedly"}. Check process output; if the engine is unavailable, start Docker and retry.`);
      }
      if (!Object.keys(run.spans).length) run.errors.push("No OTLP spans received. Check exporter support and engine connectivity.");
      try { await this.finish(run.id, status); }
      catch (error) { this.report(this.redact.text(error.message)); }
      finally { resolve(); }
    }));
    return { runId: run.id, version };
  }
  async external({ cwd }) {
    const run = await this.create(cwd, "External terminal export", "external");
    run.external = true;
    const endpoint = this.active.get(run.id).receiver.endpoint;
    const env = exporterEnv(endpoint, {});
    const snippet = Object.entries(env).map(([k, v]) => `export ${k}='${v}'`).join("\n");
    return { runId: run.id, endpoint, snippet, note: "Run dagger in this terminal, then use Finish external run. Endpoint expires on finish/reload." };
  }
  async finish(id, status) {
    const run = this.require(id), active = this.active.get(id);
    if (!active) throw new Error("Run is not active");
    if (active.child && active.child.exitCode === null && active.child.signalCode === null)
      throw new Error("Cannot finish a still-running process; cancel it instead");
    run.status = status; run.endedAt = Date.now();
    await active.receiver.close();
    this.active.delete(id);
    this.notify(run);
    await this.persist();
    return { runId: id, status };
  }
  async cancel(id) {
    const active = this.active.get(id);
    if (!active) throw new Error("Run is not active");
    active.cancelled = true;
    if (!active.child) return this.finish(id, "cancelled");
    const terminate = (signal) => {
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(active.child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
          killer.on("error", (error) => this.report(this.redact.text(error.message)));
        } else process.kill(-active.child.pid, signal);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    terminate("SIGTERM");
    active.killTimer = setTimeout(() => {
      try { terminate("SIGKILL"); }
      catch (error) { this.report(this.redact.text(error.message)); }
    }, 2000);
    return { runId: id, status: "cancelling" };
  }
  async close() {
    clearInterval(this.syncTimer);
    for (const [id, active] of this.active) {
      if (active.child) { await this.cancel(id); await active.done; }
      else await this.finish(id, "interrupted");
    }
    await this.persist();
  }
}
