import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDashboardServer } from "./server.mjs";
import { readSquadFiles, resolveProjectRoot, watchSquadFiles } from "./squad-files.mjs";
import { createDashboardStore } from "./store.mjs";

const DEFAULT_EXTENSION_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_LIMIT_BYTES = 512 * 1024;
const BACKFILL_CHUNK_SIZE = 500;
const USAGE_CACHE_TTL_MS = 5_000;
const USAGE_POLL_INTERVAL_MS = 10_000;
const DASHBOARD_TITLE = "Squad Dashboard";
const ZERO_USAGE_TOTALS = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  nanoAiu: 0,
  requests: 0,
});

const TRACKED_SESSION_EVENT_TYPES = new Set([
  "assistant.turn_start",
  "assistant.usage",
  "session.idle",
  "session.shutdown",
  "session.usage_checkpoint",
  "tool.execution_complete",
  "tool.execution_start",
  "user.message",
]);

export const inputSchema = {
  type: "object",
  properties: {
    projectPath: { type: "string" },
  },
  additionalProperties: false,
};

export const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const noteInputSchema = {
  type: "object",
  properties: {
    agentId: { type: "string" },
    note: { type: "string" },
  },
  required: ["agentId", "note"],
  additionalProperties: false,
};

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function shouldTrackSessionEvent(event) {
  if (!event?.type) {
    return false;
  }
  if (TRACKED_SESSION_EVENT_TYPES.has(event.type)) {
    return true;
  }
  return event.type.startsWith("subagent.");
}

async function yieldToEventLoop() {
  await new Promise((resolve) => setImmediate(resolve));
}

function safeWatcherCall(watcher, method, log) {
  if (typeof watcher?.[method] !== "function") {
    return;
  }
  try {
    watcher[method]();
  } catch (error) {
    log(`watcher.${method} failed: ${error?.stack ?? error}`);
  }
}

function storeStatus(snapshot) {
  if (snapshot?.noSquad) {
    return "No Squad files";
  }

  const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
  const working = agents.filter((agent) => agent.status === "working" || agent.status === "spawning").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  return `${working} working · ${idle} idle`;
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

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function usageTotalsFromModelMetric(metric) {
  const usage = metric?.usage ?? {};
  const inputTokens = finiteNumber(usage.inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  const cacheReadTokens = finiteNumber(usage.cacheReadTokens);
  const cacheWriteTokens = finiteNumber(usage.cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    nanoAiu: finiteNumber(metric?.totalNanoAiu),
    requests: finiteNumber(metric?.requests?.count),
    premiumRequests: finiteNumber(metric?.requests?.cost),
  };
}

function mergeUsageTotals(current, next) {
  return {
    inputTokens: Number(next?.inputTokens ?? current?.inputTokens ?? 0),
    outputTokens: Number(next?.outputTokens ?? current?.outputTokens ?? 0),
    cacheReadTokens: Number(next?.cacheReadTokens ?? current?.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(next?.cacheWriteTokens ?? current?.cacheWriteTokens ?? 0),
    totalTokens: Number(next?.totalTokens ?? current?.totalTokens ?? 0),
    nanoAiu: Number(next?.nanoAiu ?? current?.nanoAiu ?? 0),
    requests: Number(next?.requests ?? current?.requests ?? 0),
    ...(next?.premiumRequests != null || current?.premiumRequests != null
      ? { premiumRequests: Number(next?.premiumRequests ?? current?.premiumRequests ?? 0) }
      : {}),
  };
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value) {
    return value;
  }
  return new Date().toISOString();
}

function mapLiveUsageMetrics(metrics, base = {}) {
  const byModel = {};
  const sessionTotals = { ...ZERO_USAGE_TOTALS };
  for (const [model, metric] of Object.entries(metrics?.modelMetrics ?? {})) {
    if (!metric || !model) {
      continue;
    }
    const totals = usageTotalsFromModelMetric(metric);
    byModel[model] = totals;
    sessionTotals.inputTokens += totals.inputTokens;
    sessionTotals.outputTokens += totals.outputTokens;
    sessionTotals.cacheReadTokens += totals.cacheReadTokens;
    sessionTotals.cacheWriteTokens += totals.cacheWriteTokens;
    sessionTotals.totalTokens += totals.totalTokens;
    sessionTotals.requests += totals.requests;
    sessionTotals.nanoAiu += totals.nanoAiu;
    sessionTotals.premiumRequests = Number(sessionTotals.premiumRequests ?? 0) + totals.premiumRequests;
  }

  if (Number.isFinite(metrics?.totalNanoAiu)) {
    sessionTotals.nanoAiu = Number(metrics.totalNanoAiu);
  }

  const premiumRequests = Number.isFinite(metrics?.totalPremiumRequestCost)
    ? Number(metrics.totalPremiumRequestCost)
    : Number.isFinite(metrics?.totalUserRequests)
      ? Number(metrics.totalUserRequests)
      : Number(sessionTotals.premiumRequests ?? 0);
  sessionTotals.premiumRequests = premiumRequests;
  if (Number.isFinite(metrics?.totalUserRequests)) {
    sessionTotals.requests = Number(metrics.totalUserRequests);
  }

  return {
    ...base,
    session: mergeUsageTotals(base.session, sessionTotals),
    byModel,
    ...(Number.isFinite(metrics?.totalNanoAiu)
      ? {
          sessionNanoAiuAuthoritative: Math.max(
            Number(base.sessionNanoAiuAuthoritative ?? 0),
            Number(metrics.totalNanoAiu),
          ),
        }
      : {}),
    ...(premiumRequests ? { premiumRequests } : {}),
    ...(Number.isFinite(metrics?.totalUserRequests) ? { userRequests: Number(metrics.totalUserRequests) } : {}),
    meta: {
      ...(base.meta ?? {}),
      liveUsageFetchedAt: normalizeTimestamp(Date.now()),
      ...(Number.isFinite(metrics?.totalPremiumRequestCost)
        ? { totalPremiumRequestCost: Number(metrics.totalPremiumRequestCost) }
        : {}),
    },
  };
}

function applyMappedMetricsToStore(store, mapped) {
  if (typeof store?.applyLiveUsageMetrics !== "function") {
    return;
  }
  store.applyLiveUsageMetrics({
    totalNanoAiu: mapped.sessionNanoAiuAuthoritative ?? mapped.session?.nanoAiu,
    premiumRequests: mapped.premiumRequests ?? mapped.session?.premiumRequests,
    byModel: mapped.byModel,
    fetchedAt: mapped.meta?.liveUsageFetchedAt,
  });
}

async function readConfiguredUsdPerUnit(projectRoot, env, log) {
  const envValue = env?.SQUAD_DASHBOARD_USD_PER_AIU;
  if (envValue != null && envValue !== "") {
    const parsed = Number(envValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (!projectRoot) {
    return undefined;
  }

  try {
    const raw = await fs.readFile(path.join(projectRoot, ".squad", "dashboard.json"), "utf8");
    const parsed = JSON.parse(raw);
    const usdPerAiu = Number(parsed?.usdPerAiu);
    return Number.isFinite(usdPerAiu) ? usdPerAiu : undefined;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log(`dashboard.json read failed: ${error?.stack ?? error}`);
    }
    return undefined;
  }
}

function createFileLogger(logFile) {
  let logQueue = Promise.resolve();
  return function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    logQueue = logQueue
      .then(async () => {
        await fs.mkdir(path.dirname(logFile), { recursive: true });
        try {
          const stat = await fs.stat(logFile);
          if (stat.size > LOG_LIMIT_BYTES) {
            await fs.truncate(logFile, 0);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
        await fs.appendFile(logFile, line, "utf8");
      })
      .catch(() => {});
  };
}

export async function createSquadDashboardExtension({
  CanvasError,
  createCanvas,
  joinSession,
  extensionRoot = DEFAULT_EXTENSION_ROOT,
  env = process.env,
  cwd = () => process.cwd(),
  logFile = path.join(os.homedir(), ".copilot", "extensions", "squad-dashboard", "artifacts", "extension.log"),
} = {}) {
  if (typeof CanvasError !== "function" || typeof createCanvas !== "function" || typeof joinSession !== "function") {
    throw new TypeError("createSquadDashboardExtension requires CanvasError, createCanvas, and joinSession");
  }

  const uiDir = path.join(extensionRoot, "ui");
  const stores = new Map();
  const instances = new Map();
  const log = createFileLogger(logFile);
  let session;
  let unsubscribeSession;

  function canvasError(code, error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${code}: ${error?.stack ?? message}`);
    return new CanvasError(code, message);
  }

  async function readPricedUsageBase(entry) {
    const base = resolveUsageSnapshot(entry.store);
    const pricing = { ...(base.pricing ?? { unitLabel: "AIU", nanoPerUnit: 1e9 }) };
    const configuredUsdPerUnit = await readConfiguredUsdPerUnit(entry.projectRoot, env, log);
    if (configuredUsdPerUnit !== undefined) {
      pricing.usdPerUnit = configuredUsdPerUnit;
    } else {
      delete pricing.usdPerUnit;
    }
    return { ...base, pricing };
  }

  async function refreshUsageCache(entry, { force = false } = {}) {
    const now = Date.now();
    const cache = entry.usageCache;
    if (!force && cache.value && now - cache.fetchedAt < USAGE_CACHE_TTL_MS) {
      return cache.value;
    }
    if (cache.promise) {
      return cache.promise;
    }

    cache.promise = (async () => {
      const base = await readPricedUsageBase(entry);
      try {
        const metrics = await session?.rpc?.usage?.getMetrics?.();
        if (!metrics || typeof metrics !== "object") {
          cache.value = base;
          cache.fetchedAt = Date.now();
          return base;
        }
        const mapped = mapLiveUsageMetrics(metrics, base);
        applyMappedMetricsToStore(entry.store, mapped);
        cache.value = mapped;
        cache.fetchedAt = Date.now();
        return mapped;
      } catch (error) {
        log(`session.rpc.usage.getMetrics failed: ${error?.stack ?? error}`);
        if (cache.value) {
          return cache.value;
        }
        return base;
      } finally {
        cache.promise = undefined;
      }
    })();

    return cache.promise;
  }

  function startUsagePolling(entry) {
    if (entry.usagePollTimer) {
      return;
    }
    refreshUsageCache(entry, { force: true }).catch((error) => {
      log(`usage poll refresh failed: ${error?.stack ?? error}`);
    });
    entry.usagePollTimer = setInterval(() => {
      refreshUsageCache(entry, { force: true }).catch((error) => {
        log(`usage poll refresh failed: ${error?.stack ?? error}`);
      });
    }, USAGE_POLL_INTERVAL_MS);
    entry.usagePollTimer.unref?.();
  }

  function stopUsagePolling(entry) {
    if (!entry.usagePollTimer) {
      return;
    }
    clearInterval(entry.usagePollTimer);
    entry.usagePollTimer = undefined;
  }

  function setBackfillProgress(entry, progress) {
    if (typeof entry.store?.setBackfillProgress !== "function") {
      return;
    }
    try {
      entry.store.setBackfillProgress(progress);
    } catch (error) {
      log(`setBackfillProgress failed: ${error?.stack ?? error}`);
    }
  }

  function flushBufferedLiveEvents(entry) {
    const buffered = entry.liveBuffer;
    entry.liveBuffer = [];
    for (const event of buffered) {
      try {
        entry.store.ingestSessionEvent(event);
      } catch (error) {
        log(`buffered live event ingest failed: ${error?.stack ?? error}`);
      }
    }
  }

  function ingestLiveEvent(entry, event) {
    if (entry.backfillRunning && !entry.backfilled) {
      entry.liveBuffer.push(event);
      return;
    }
    try {
      entry.store.ingestSessionEvent(event);
    } catch (error) {
      log(`live event ingest failed: ${error?.stack ?? error}`);
    }
  }

  function handleLiveSessionEvent(event) {
    if (!shouldTrackSessionEvent(event)) {
      return;
    }

    for (const entry of stores.values()) {
      ingestLiveEvent(entry, event);
    }
  }

  function ensureSessionSubscription() {
    if (unsubscribeSession || typeof session?.on !== "function") {
      return;
    }
    unsubscribeSession = session.on(handleLiveSessionEvent);
  }

  function removeSessionSubscription() {
    if (typeof unsubscribeSession !== "function") {
      unsubscribeSession = undefined;
      return;
    }
    try {
      unsubscribeSession();
    } catch (error) {
      log(`session unsubscribe failed: ${error?.stack ?? error}`);
    } finally {
      unsubscribeSession = undefined;
    }
  }

  function startBackfillStoreEntry(entry) {
    if (entry.backfilled || entry.backfillPromise) {
      return entry.backfillPromise;
    }

    setBackfillProgress(entry, { state: "pending", processed: 0 });
    entry.backfillPromise = (async () => {
      if (!session || typeof session.getEvents !== "function") {
        entry.backfilled = true;
        setBackfillProgress(entry, { state: "done", processed: 0, total: 0 });
        return;
      }

      let events = null;
      let processed = 0;
      let total;
      let lastRootType;
      let lastRootTimestamp;
      entry.backfillRunning = true;
      setBackfillProgress(entry, { state: "running", processed: 0 });

      try {
        events = await session.getEvents();
        if (!Array.isArray(events)) {
          entry.backfilled = true;
          setBackfillProgress(entry, { state: "done", processed: 0, total: 0 });
          return;
        }

        total = events.length;
        setBackfillProgress(entry, { state: "running", processed: 0, total });
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index];
          events[index] = null;
          processed = index + 1;

          if (shouldTrackSessionEvent(event)) {
            if (!event.agentId) {
              lastRootType = event.type;
              lastRootTimestamp = event.timestamp ?? lastRootTimestamp;
            }

            try {
              entry.store.ingestSessionEvent(event);
            } catch (error) {
              log(`backfill ingest failed: ${error?.stack ?? error}`);
            }
          }

          if (processed % BACKFILL_CHUNK_SIZE === 0) {
            setBackfillProgress(entry, { state: "running", processed, total });
            await yieldToEventLoop();
          }
        }

        if (lastRootType && lastRootType !== "assistant.turn_start") {
          try {
            entry.store.ingestSessionEvent({
              type: "session.idle",
              timestamp: lastRootTimestamp ?? new Date().toISOString(),
              data: { source: "dashboard-backfill" },
            });
          } catch (error) {
            log(`backfill idle normalization failed: ${error?.stack ?? error}`);
          }
        }

        entry.backfilled = true;
        setBackfillProgress(entry, { state: "done", processed, total });
      } catch (error) {
        log(`session.getEvents failed: ${error?.stack ?? error}`);
        setBackfillProgress(entry, {
          state: "error",
          processed,
          total,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (Array.isArray(events)) {
          events.length = 0;
        }
        events = null;
        entry.backfillRunning = false;
        entry.backfillPromise = undefined;
        flushBufferedLiveEvents(entry);
      }
    })();

    entry.backfillPromise.catch(() => {});
    return entry.backfillPromise;
  }

  async function initializeStoreEntry(entry) {
    if (entry.initialized) {
      return;
    }

    if (entry.projectRoot) {
      try {
        const files = await readSquadFiles(entry.projectRoot);
        entry.store.initializeFromFiles(files);
      } catch (error) {
        log(`readSquadFiles failed for ${entry.projectRoot}: ${error?.stack ?? error}`);
      }

      if (!entry.watcher) {
        try {
          entry.watcher = watchSquadFiles(
            entry.projectRoot,
            (fileEvent) => {
              try {
                entry.store.ingestFileEvent(fileEvent);
              } catch (error) {
                log(`ingestFileEvent failed: ${error?.stack ?? error}`);
              }
            },
            {},
          );
          safeWatcherCall(entry.watcher, "pause", log);
        } catch (error) {
          log(`watchSquadFiles failed for ${entry.projectRoot}: ${error?.stack ?? error}`);
        }
      }
    }

    entry.initialized = true;
    startBackfillStoreEntry(entry);
  }

  async function resolveProjectRootForOpen(ctx) {
    const input = asObject(ctx.input);
    const projectPath = typeof input.projectPath === "string" ? input.projectPath : undefined;
    const sessionWorkingDirectory = ctx.session?.workingDirectory;

    try {
      return await resolveProjectRoot({
        projectPath,
        cwd: cwd(),
        sessionWorkingDirectory,
      });
    } catch (error) {
      log(`resolveProjectRoot failed: ${error?.stack ?? error}`);
      return null;
    }
  }

  async function getOrCreateStoreEntry(ctx) {
    const input = asObject(ctx.input);
    const projectPath = typeof input.projectPath === "string" ? input.projectPath : undefined;
    const sessionWorkingDirectory = ctx.session?.workingDirectory;
    const projectRoot = await resolveProjectRootForOpen(ctx);
    const key = projectRoot ?? `no-squad:${projectPath ?? sessionWorkingDirectory ?? cwd()}`;

    let entry = stores.get(key);
    if (!entry) {
      const store = createDashboardStore({
        projectRoot,
        readFiles: projectRoot ? () => readSquadFiles(projectRoot) : undefined,
      });

      entry = {
        key,
        projectRoot,
        store,
        watcher: undefined,
        initialized: false,
        initPromise: undefined,
        backfilled: false,
        backfillPromise: undefined,
        backfillRunning: false,
        liveBuffer: [],
        server: undefined,
        refCount: 0,
        usageCache: { value: undefined, fetchedAt: 0, promise: undefined },
        usagePollTimer: undefined,
      };
      entry.initPromise = initializeStoreEntry(entry).finally(() => {
        entry.initPromise = undefined;
      });
      stores.set(key, entry);
    } else if (!entry.initialized && !entry.initPromise) {
      entry.initPromise = initializeStoreEntry(entry).finally(() => {
        entry.initPromise = undefined;
      });
    }

    if (entry.initPromise) {
      await entry.initPromise;
    }
    return entry;
  }

  async function ensureServer(entry) {
    if (entry.server) {
      return entry.server;
    }

    entry.server = await createDashboardServer({
      store: entry.store,
      uiDir,
      log,
      onActive: () => {
        safeWatcherCall(entry.watcher, "resume", log);
        startUsagePolling(entry);
      },
      onIdle: () => {
        safeWatcherCall(entry.watcher, "pause", log);
        stopUsagePolling(entry);
      },
      getUsage: () => refreshUsageCache(entry),
    });
    return entry.server;
  }

  function getInstanceStore(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (!instance) {
      throw new CanvasError("instance_not_open", "Open the Squad Dashboard canvas before invoking this action.");
    }

    const storeEntry = stores.get(instance.storeKey);
    if (!storeEntry) {
      throw new CanvasError("instance_not_open", "The Squad Dashboard store is no longer available.");
    }

    return storeEntry.store;
  }

  async function openDashboard(ctx) {
    try {
      const existing = instances.get(ctx.instanceId);
      if (existing) {
        const storeEntry = stores.get(existing.storeKey);
        if (!storeEntry) {
          throw new Error("Dashboard server unavailable");
        }
        const server = await ensureServer(storeEntry);
        return {
          url: server.url,
          title: existing.title,
          status: existing.status,
        };
      }

      const storeEntry = await getOrCreateStoreEntry(ctx);
      ensureSessionSubscription();
      const server = await ensureServer(storeEntry);
      const snapshot = storeEntry.store.getSnapshot();
      const status = storeStatus(snapshot);

      storeEntry.refCount += 1;
      instances.set(ctx.instanceId, {
        storeKey: storeEntry.key,
        title: DASHBOARD_TITLE,
        status,
      });

      return {
        url: server.url,
        title: DASHBOARD_TITLE,
        status,
      };
    } catch (error) {
      throw error instanceof CanvasError ? error : canvasError("open_failed", error);
    }
  }

  async function closeDashboard(ctx) {
    const instance = instances.get(ctx.instanceId);
    if (!instance) {
      return;
    }

    instances.delete(ctx.instanceId);
    const storeEntry = stores.get(instance.storeKey);
    if (!storeEntry) {
      return;
    }

    storeEntry.refCount = Math.max(0, storeEntry.refCount - 1);
    if (storeEntry.refCount === 0) {
      stopUsagePolling(storeEntry);
      if (storeEntry.server) {
        try {
          await storeEntry.server.close();
        } catch (error) {
          log(`server close failed for ${ctx.instanceId}: ${error?.stack ?? error}`);
        } finally {
          storeEntry.server = undefined;
          safeWatcherCall(storeEntry.watcher, "pause", log);
        }
      }
      if (instances.size === 0) {
        removeSessionSubscription();
      }
    }
  }

  function createActionHandler(actionName, handler) {
    return async (ctx) => {
      try {
        return await handler(ctx);
      } catch (error) {
        throw error instanceof CanvasError ? error : canvasError(`${actionName}_failed`, error);
      }
    };
  }

  const dashboardCanvas = createCanvas({
    id: "squad-dashboard",
    displayName: DASHBOARD_TITLE,
    description: "Live dashboard for Squad agents, activity, usage, files, and notes.",
    inputSchema,
    actions: [
      {
        name: "get_snapshot",
        description: "Return the current Squad dashboard snapshot.",
        inputSchema: emptyInputSchema,
        handler: createActionHandler("get_snapshot", (ctx) => getInstanceStore(ctx).getSnapshot()),
      },
      {
        name: "refresh",
        description: "Refresh Squad files and return the latest dashboard snapshot.",
        inputSchema: emptyInputSchema,
        handler: createActionHandler("refresh", async (ctx) => getInstanceStore(ctx).refresh()),
      },
      {
        name: "get_usage",
        description: "Return the current Squad dashboard usage summary.",
        inputSchema: emptyInputSchema,
        handler: createActionHandler("get_usage", async (ctx) => {
          const instance = instances.get(ctx.instanceId);
          const storeEntry = instance ? stores.get(instance.storeKey) : null;
          if (!storeEntry) {
            throw new CanvasError("instance_not_open", "Open the Squad Dashboard canvas before invoking this action.");
          }
          return refreshUsageCache(storeEntry);
        }),
      },
      {
        name: "set_note",
        description: "Set an operator note for one Squad agent.",
        inputSchema: noteInputSchema,
        handler: createActionHandler("set_note", (ctx) => {
          const input = asObject(ctx.input);
          return getInstanceStore(ctx).setNote(input.agentId, input.note);
        }),
      },
    ],
    open: openDashboard,
    onClose: closeDashboard,
  });

  session = await joinSession({
    canvases: [dashboardCanvas],
  });

  async function closeAll() {
    removeSessionSubscription();
    for (const entry of stores.values()) {
      stopUsagePolling(entry);
      if (entry.server) {
        try {
          await entry.server.close();
        } catch (error) {
          log(`server close failed: ${error?.stack ?? error}`);
        }
        entry.server = undefined;
      }
      if (entry.watcher && typeof entry.watcher.close === "function") {
        try {
          await entry.watcher.close();
        } catch (error) {
          log(`watcher close failed: ${error?.stack ?? error}`);
        }
      }
    }
    stores.clear();
    instances.clear();
  }

  return {
    canvas: dashboardCanvas,
    session,
    stores,
    instances,
    closeAll,
    _internals: {
      mapLiveUsageMetrics,
      refreshUsageCache,
      shouldTrackSessionEvent,
    },
  };
}
