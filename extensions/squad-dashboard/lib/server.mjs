import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

const JSON_LIMIT_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const FLUSH_MS = 250;
const MAX_BATCH_ITEMS = 512;
const SSE_BACKPRESSURE_BYTES = 256 * 1024;
const STORE_SNAPSHOT_MIN_MS = 5_000;
const STATIC_CACHE_CONTROL = "public, max-age=300, must-revalidate";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
]);

const ZERO_USAGE_TOTALS = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  nanoAiu: 0,
  requests: 0,
});

function defaultLog() {}

function writeJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function createSsePayload(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function resolveStaticPath(uiRoot, pathname) {
  const decoded = decodePathname(pathname);
  if (!decoded || decoded.includes("\0")) {
    return null;
  }

  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(uiRoot, relativePath);
  const rootWithSeparator = uiRoot.endsWith(path.sep) ? uiRoot : `${uiRoot}${path.sep}`;

  if (resolved !== uiRoot && !resolved.startsWith(rootWithSeparator)) {
    return null;
  }

  return resolved;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > JSON_LIMIT_BYTES) {
        reject(Object.assign(new Error("JSON body too large"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(error, { code: "invalid_json" }));
      }
    });
  });
}

function chooseEncoding(req, contentType) {
  if (!isCompressibleContentType(contentType)) {
    return null;
  }

  const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
  if (acceptEncoding.includes("br")) {
    return "br";
  }
  if (acceptEncoding.includes("gzip")) {
    return "gzip";
  }
  return null;
}

function isCompressibleContentType(contentType) {
  return /^(text\/|application\/(?:json|javascript)|image\/svg\+xml)/i.test(contentType);
}

async function compressBuffer(buffer, encoding) {
  if (encoding === "br") {
    return brotliAsync(buffer, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    });
  }
  if (encoding === "gzip") {
    return gzipAsync(buffer, { level: 6 });
  }
  return buffer;
}

function maybeNotModified(req, res, etag, headers) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  const ifNoneMatch = req.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && entityTagListMatches(ifNoneMatch, etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  return false;
}

function normalizeEntityTag(tag) {
  return tag.trim().replace(/^W\//i, "");
}

function entityTagListMatches(ifNoneMatch, currentEtag) {
  const current = normalizeEntityTag(currentEtag);
  for (const rawCandidate of ifNoneMatch.split(",")) {
    const candidate = rawCandidate.trim();
    if (candidate === "*") {
      return true;
    }
    if (normalizeEntityTag(candidate) === current) {
      return true;
    }
  }
  return false;
}

function isProtectedRequest(req, pathname) {
  return req.method === "POST" || pathname === "/events" || pathname.startsWith("/api/");
}

function isAllowedOrigin(req, allowedOrigins) {
  const origin = req.headers.origin;
  return origin === undefined || (typeof origin === "string" && allowedOrigins.has(origin));
}

function isAllowedFetchSite(req) {
  const fetchSite = req.headers["sec-fetch-site"];
  return (
    fetchSite === undefined ||
    fetchSite === "same-origin" ||
    fetchSite === "none"
  );
}

async function ensureStaticAsset(staticCache, filePath, stat, contentType) {
  const cacheKey = filePath;
  const version = `${Number(stat.mtimeMs)}:${stat.size}`;
  const cached = staticCache.get(cacheKey);
  if (cached?.version === version) {
    return cached;
  }

  const raw = await fs.readFile(filePath);
  const asset = {
    version,
    size: stat.size,
    mtimeMs: Number(stat.mtimeMs),
    contentType,
    raw,
    variants: new Map(),
  };
  staticCache.set(cacheKey, asset);
  return asset;
}

async function serveStatic({ req, res, uiRoot, uiRootReal, pathname, staticCache }) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    writeJson(res, 404, { error: "not_found" });
    return;
  }

  const filePath = resolveStaticPath(uiRoot, pathname);
  if (!filePath) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    writeJson(res, 404, { error: "not_found" });
    return;
  }

  if (!stat.isFile()) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }

  const realFilePath = await fs.realpath(filePath);
  const realRootWithSeparator = uiRootReal.endsWith(path.sep) ? uiRootReal : `${uiRootReal}${path.sep}`;
  if (realFilePath !== uiRootReal && !realFilePath.startsWith(realRootWithSeparator)) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }

  const contentType = CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
  const asset = await ensureStaticAsset(staticCache, realFilePath, stat, contentType);
  const encoding = chooseEncoding(req, contentType);

  let payload = asset.raw;
  let contentEncoding;
  if (encoding) {
    if (!asset.variants.has(encoding)) {
      asset.variants.set(encoding, compressBuffer(asset.raw, encoding));
    }
    payload = await asset.variants.get(encoding);
    contentEncoding = encoding;
  }

  const etag = `W/"${asset.size}-${asset.mtimeMs}"`;
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": STATIC_CACHE_CONTROL,
    ETag: etag,
    Vary: "Accept-Encoding",
    ...(contentEncoding ? { "Content-Encoding": contentEncoding } : {}),
    "Content-Length": String(payload.length),
  };

  if (maybeNotModified(req, res, etag, headers)) {
    return;
  }

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(payload);
}

function resolveUsageSnapshot(store) {
  if (typeof store?.getUsage === "function") {
    const usage = store.getUsage();
    if (usage && typeof usage === "object") {
      return usage;
    }
  }

  const snapshot = typeof store?.getSnapshot === "function" ? store.getSnapshot() : null;
  if (snapshot?.usage && typeof snapshot.usage === "object") {
    return snapshot.usage;
  }

  return {
    session: { ...ZERO_USAGE_TOTALS },
    byModel: {},
    prompts: [],
    pricing: { unitLabel: "AIU", nanoPerUnit: 1e9 },
    meta: { partial: true },
  };
}

function withoutGeneratedAt(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { generatedAt, ...stablePayload } = payload;
  return stablePayload;
}

async function writeMaybeCompressedJson(req, res, statusCode, payload, headers = {}, { etagPayload = payload } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const etagRaw = Buffer.from(JSON.stringify(etagPayload));
  const contentType = "application/json; charset=utf-8";
  const encoding = chooseEncoding(req, contentType);
  const etag = `W/"${createHash("sha1").update(etagRaw).digest("hex")}"`;
  const responseHeaders = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    Vary: "Accept-Encoding",
    ETag: etag,
    ...headers,
  };

  if (maybeNotModified(req, res, etag, responseHeaders)) {
    return;
  }

  if (!encoding) {
    responseHeaders["Content-Length"] = String(raw.length);
    res.writeHead(statusCode, responseHeaders);
    res.end(raw);
    return;
  }

  const compressed = await compressBuffer(raw, encoding);
  responseHeaders["Content-Encoding"] = encoding;
  responseHeaders["Content-Length"] = String(compressed.length);
  res.writeHead(statusCode, responseHeaders);
  res.end(compressed);
}

function hasPending(pendingState) {
  return (
    pendingState.snapshotRequested ||
    pendingState.keys.length > 0 ||
    pendingState.orderedItems.length > 0
  );
}

function clearPending(pendingState) {
  pendingState.snapshotRequested = false;
  pendingState.entries.clear();
  pendingState.keys = [];
  pendingState.orderedItems = [];
}

function clearPendingDeltas(pendingState) {
  pendingState.entries.clear();
  pendingState.keys = [];
  pendingState.orderedItems = [];
}

function pushPendingEntry(pendingState, key, item) {
  if (!pendingState.entries.has(key)) {
    pendingState.keys.push(key);
  }
  pendingState.entries.set(key, item);
}

function queueDelta(pendingState, message) {
  if (!message?.type) {
    return;
  }

  if (message.type === "snapshot") {
    pendingState.snapshotRequested = true;
    pendingState.entries.clear();
    pendingState.keys = [];
    pendingState.orderedItems = [];
    return;
  }

  switch (message.type) {
    case "agent.updated":
      if (message.agent?.id) {
        pushPendingEntry(pendingState, `agent:${message.agent.id}`, message);
      }
      break;
    case "usage.updated":
      pushPendingEntry(pendingState, "usage", message);
      break;
    case "files.changed":
      pushPendingEntry(pendingState, "files", message);
      break;
    case "activity.added":
    case "prompt.updated":
      pendingState.orderedItems.push(message);
      break;
    default:
      pendingState.orderedItems.push(message);
      break;
  }

  const count = pendingState.keys.length + pendingState.orderedItems.length;
  if (count > MAX_BATCH_ITEMS) {
    pendingState.snapshotRequested = true;
    pendingState.entries.clear();
    pendingState.keys = [];
    pendingState.orderedItems = [];
  }
}

function buildBatchItems(pendingState) {
  const items = [];
  for (const key of pendingState.keys) {
    const message = pendingState.entries.get(key);
    if (message) {
      items.push(message);
    }
  }
  items.push(...pendingState.orderedItems);
  return items;
}

function waitForClientDrain(client) {
  if (client.waitingDrain || client.closed || client.res.destroyed) {
    return;
  }
  client.waitingDrain = true;
  client.res.once("drain", () => {
    client.waitingDrain = false;
    if (!client.closed && !client.res.destroyed && client.needsSnapshot) {
      void client.sendSnapshot();
    }
  });
}

function markClientNeedsSnapshot(client) {
  client.needsSnapshot = true;
  waitForClientDrain(client);
}

export async function createDashboardServer({ store, uiDir, log = defaultLog, onActive, onIdle, getUsage } = {}) {
  if (!store || typeof store.getSnapshot !== "function") {
    throw new TypeError("createDashboardServer requires a store with getSnapshot()");
  }
  if (!uiDir) {
    throw new TypeError("createDashboardServer requires uiDir");
  }
  const activeHook = typeof onActive === "function" ? onActive : store.onActive?.bind(store);
  const idleHook = typeof onIdle === "function" ? onIdle : store.onIdle?.bind(store);

  const uiRoot = path.resolve(uiDir);
  const uiRootReal = await fs.realpath(uiRoot).catch(() => uiRoot);
  const staticCache = new Map();
  const sseClients = new Set();
  const pendingState = {
    snapshotRequested: false,
    entries: new Map(),
    keys: [],
    orderedItems: [],
  };

  let closing = false;
  let unsubscribeStore;
  let flushTimer;
  let flushTimerDueAt = 0;
  let heartbeatTimer;
  let active = false;
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  let lastStoreSnapshotAt = 0;

  function clearFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
      flushTimerDueAt = 0;
    }
  }

  function clearHeartbeatTimer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function stopLiveFeed() {
    if (!active) {
      clearPending(pendingState);
      clearFlushTimer();
      clearHeartbeatTimer();
      return;
    }

    active = false;
    clearFlushTimer();
    clearHeartbeatTimer();
    clearPending(pendingState);
    if (typeof unsubscribeStore === "function") {
      unsubscribeStore();
      unsubscribeStore = undefined;
    }
    if (typeof idleHook === "function") {
      try {
        idleHook();
      } catch (error) {
        log?.(`onIdle failed: ${error?.stack ?? error}`);
      }
    }
  }

  function scheduleFlush() {
    if (!active || !hasPending(pendingState)) {
      return;
    }
    const hasDeltas = pendingState.keys.length > 0 || pendingState.orderedItems.length > 0;
    if (flushTimer) {
      if (!hasDeltas || flushTimerDueAt - Date.now() <= FLUSH_MS) {
        return;
      }
      clearFlushTimer();
    }
    const nextSnapshotAt = lastStoreSnapshotAt + STORE_SNAPSHOT_MIN_MS;
    const snapshotDelay = pendingState.snapshotRequested && !hasDeltas
      ? Math.max(0, nextSnapshotAt - Date.now())
      : FLUSH_MS;
    flushTimerDueAt = Date.now() + snapshotDelay;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushTimerDueAt = 0;
      void flushPending();
    }, snapshotDelay);
    flushTimer.unref?.();
  }

  function writeToClient(client, raw, { prioritizeSnapshot = false } = {}) {
    if (client.closed || client.res.destroyed) {
      return;
    }

    if (client.waitingDrain || client.res.writableNeedDrain || client.res.writableLength > SSE_BACKPRESSURE_BYTES) {
      if (prioritizeSnapshot) {
        client.needsSnapshot = true;
        waitForClientDrain(client);
        return;
      }
      markClientNeedsSnapshot(client);
      return;
    }

    const ok = client.res.write(raw);
    if (prioritizeSnapshot) {
      client.needsSnapshot = false;
      if (!ok || client.res.writableLength > SSE_BACKPRESSURE_BYTES) {
        waitForClientDrain(client);
      }
    } else if (!ok || client.res.writableLength > SSE_BACKPRESSURE_BYTES) {
      markClientNeedsSnapshot(client);
    }
  }

  async function sendSnapshotToClient(client) {
    if (client.closed || client.res.destroyed) {
      return;
    }
    const raw = createSsePayload("snapshot", store.getSnapshot());
    writeToClient(client, raw, { prioritizeSnapshot: true });
  }

  async function flushPending() {
    if (!active || sseClients.size === 0 || !hasPending(pendingState)) {
      clearPending(pendingState);
      return;
    }

    if (pendingState.snapshotRequested && Date.now() >= lastStoreSnapshotAt + STORE_SNAPSHOT_MIN_MS) {
      const raw = createSsePayload("snapshot", store.getSnapshot());
      lastStoreSnapshotAt = Date.now();
      clearPending(pendingState);
      for (const client of sseClients) {
        writeToClient(client, raw, { prioritizeSnapshot: true });
      }
      return;
    }

    const items = buildBatchItems(pendingState);
    clearPendingDeltas(pendingState);
    if (items.length === 0) {
      scheduleFlush();
      return;
    }

    const raw = createSsePayload("delta", { type: "batch", items });
    for (const client of sseClients) {
      if (client.needsSnapshot) {
        continue;
      }
      writeToClient(client, raw);
    }
    scheduleFlush();
  }

  function startHeartbeat() {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (!active || sseClients.size === 0) {
        return;
      }
      const raw = createSsePayload("heartbeat", { timestamp: new Date().toISOString() });
      for (const client of sseClients) {
        if (!client.needsSnapshot && !client.waitingDrain) {
          writeToClient(client, raw);
        }
      }
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function startLiveFeed() {
    if (active) {
      return;
    }
    active = true;
    if (typeof activeHook === "function") {
      try {
        activeHook();
      } catch (error) {
        log?.(`onActive failed: ${error?.stack ?? error}`);
      }
    }
    unsubscribeStore =
      typeof store.subscribe === "function"
        ? store.subscribe((message) => {
            queueDelta(pendingState, message);
            scheduleFlush();
          })
        : undefined;
    startHeartbeat();
  }

  const server = createServer({ requireHostHeader: false }, async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const { pathname } = url;

    try {
      const host = req.headers.host;
      if (typeof host !== "string" || !allowedHosts.has(host)) {
        writeJson(res, 421, { error: "invalid_host" });
        return;
      }

      if (isProtectedRequest(req, pathname) && !isAllowedOrigin(req, allowedOrigins)) {
        writeJson(res, 403, { error: "forbidden" });
        return;
      }

      if (req.method === "POST" && !isAllowedFetchSite(req)) {
        writeJson(res, 403, { error: "forbidden" });
        return;
      }

      if (req.method === "GET" && pathname === "/api/snapshot") {
        const snapshot = store.getSnapshot();
        await writeMaybeCompressedJson(req, res, 200, snapshot, {}, { etagPayload: withoutGeneratedAt(snapshot) });
        return;
      }

      if (req.method === "GET" && pathname === "/api/usage") {
        const usage = typeof getUsage === "function" ? await getUsage() : resolveUsageSnapshot(store);
        await writeMaybeCompressedJson(req, res, 200, usage);
        return;
      }

      if (req.method === "POST" && pathname === "/api/refresh") {
        const snapshot = await store.refresh();
        writeJson(res, 200, snapshot);
        return;
      }

      if (req.method === "POST" && pathname === "/api/note") {
        const body = await readJsonBody(req);
        if (!body || typeof body.agentId !== "string" || typeof body.note !== "string") {
          writeJson(res, 400, { error: "invalid_request" });
          return;
        }
        const noteResult = store.setNote(body.agentId, body.note);
        if (noteResult == null) {
          writeJson(res, 404, { error: "unknown agent" });
          return;
        }
        writeJson(res, 200, noteResult);
        return;
      }

      if (req.method === "GET" && pathname === "/events") {
        const client = {
          res,
          closed: false,
          waitingDrain: false,
          needsSnapshot: false,
          sendSnapshot: async () => sendSnapshotToClient(client),
          close: () => {
            if (client.closed) {
              return;
            }
            client.closed = true;
            sseClients.delete(client);
            if (!res.destroyed) {
              res.end();
            }
            if (sseClients.size === 0) {
              stopLiveFeed();
            }
          },
        };

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        sseClients.add(client);
        if (sseClients.size === 1) {
          startLiveFeed();
        }

        await sendSnapshotToClient(client);

        req.on("close", client.close);
        res.on("close", client.close);
        return;
      }

      if (pathname.startsWith("/api/") || pathname === "/events") {
        writeJson(res, 404, { error: "not_found" });
        return;
      }

      await serveStatic({ req, res, uiRoot, uiRootReal, pathname, staticCache });
    } catch (error) {
      log?.(`server request failed: ${error?.stack ?? error}`);
      if (!res.headersSent) {
        const statusCode = error?.code === "body_too_large" ? 413 : 500;
        const errorCode = error?.code === "invalid_json" ? "invalid_json" : "internal_error";
        writeJson(res, statusCode, { error: errorCode });
      } else if (!res.destroyed) {
        writeToClient(
          {
            res,
            closed: false,
            waitingDrain: false,
            needsSnapshot: false,
            sendSnapshot: async () => {},
          },
          createSsePayload("error", { code: "internal_error", message: "Request failed" }),
        );
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  allowedHosts = new Set([
    `127.0.0.1:${address.port}`,
    `localhost:${address.port}`,
    `[::1]:${address.port}`,
  ]);
  allowedOrigins = new Set([
    `http://127.0.0.1:${address.port}`,
    `http://localhost:${address.port}`,
    `http://[::1]:${address.port}`,
  ]);

  return {
    url,
    clientCount() {
      return sseClients.size;
    },
    async close() {
      if (closing) {
        return;
      }
      closing = true;

      stopLiveFeed();
      for (const client of [...sseClients]) {
        client.close();
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
