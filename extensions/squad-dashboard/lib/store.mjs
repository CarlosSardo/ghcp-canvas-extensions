import { readFileSync } from 'node:fs';

import { normalizeAgentKey } from './squad-files.mjs';

/**
 * DashboardStore reducer contract:
 * - Emits direct listener messages:
 *   { type:'snapshot', snapshot }
 *   { type:'agent.updated', agent }
 *   { type:'coordinator.updated', coordinator }
 *   { type:'activity.added', item }
 *   { type:'files.changed', files }
 *   { type:'usage.updated', usage:{ session, sessionNanoAiuAuthoritative?, premiumRequests?, byModel, activePrompt?, pricing } }
 *   { type:'prompt.updated', prompt }
 *   { type:'meta.updated', meta:{ backfill:{ state, processed?, total?, error?, updatedAt } } }
 * - Keeps snapshots cheap via dirty flags, per-agent/per-prompt caches, bounded dedupe sets,
 *   numeric timestamps internally, and zero retained raw session event payloads.
 */

const DEFAULTS = {
  maxFeed: 100,
  idleAfterMs: 120_000,
  doneTtlMs: 60_000,
  waitingAfterMs: 300_000,
  dedupeLimit: 5_000,
  promptLimit: 30,
  promptAgentLimit: 12,
};

const LIVE_STATUSES = new Set(['spawning', 'working', 'waiting', 'done', 'failed']);
const RUNNING_STATUSES = new Set(['spawning', 'working']);
const RELEVANT_EVENT_TYPES = new Set([
  'user.message',
  'assistant.message',
  'assistant.turn_start',
  'assistant.turn_end',
  'assistant.usage',
  'session.idle',
  'session.shutdown',
  'session.usage_checkpoint',
  'tool.execution_start',
  'tool.execution_complete',
  'subagent.started',
  'subagent.configured',
  'subagent.completed',
  'subagent.failed',
]);

const SYNTHETIC_PROMPT_ID = 'prompt:before-first';
const AIU_NANO_PER_UNIT = 1_000_000_000;

class BoundedMap {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.map = new Map();
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    if (key == null || key === '') return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  delete(key) {
    return this.map.delete(key);
  }
}

export function createDashboardStore(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = typeof config.now === 'function' ? config.now : () => Date.now();

  let projectRoot = config.projectRoot ?? null;
  let noSquad = !projectRoot;
  let files = {
    decisionsInboxCount: 0,
    orchestrationLogCount: 0,
    logCount: 0,
    lastFileActivityAtMs: null,
  };
  let errors = [];
  let eventBackfill = false;
  let closed = false;

  const listeners = new Set();
  const rosterById = new Map();
  const rosterOrder = new Map();
  const agents = new Map();
  const runtimeToAgent = new Map();
  const pendingTaskByToolCallId = new Map();
  const rootToolByToolCallId = new Map();
  const rootToolInFlight = new Set();
  const inFlightToolByToolCallId = new Map();
  const terminalRuntimeAgents = new Map();
  const countedToolCallIds = new BoundedMap(config.dedupeLimit);
  const processedEventIds = new BoundedMap(config.dedupeLimit);
  // Live assistant.usage safeguard only; never used for persisted assistant.message replay.
  const apiUsageById = new BoundedMap(config.dedupeLimit);
  const activity = [];
  const activityIds = new Set();

  let agentSequence = 0;
  let activitySequence = 0;
  let lastRootEventType = null;
  let derivedTimer = null;

  let snapshotDirty = true;
  let snapshotCache = null;
  let stateVersion = 0;
  let usageVersion = 0;
  let promptSequence = 0;
  let estimatedUsageCount = 0;
  let eventOrder = 0;
  let backfillProgress = null;
  let lastBackfillEmitAtMs = 0;
  const minDerivedDelayMs = Math.max(250, Number(config.minDerivedDelayMs) || 250);
  let pricingUsdPerAiu = readUsdPerAiu(process.env.SQUAD_DASHBOARD_USD_PER_AIU)
    ?? readProjectUsdPerAiu(projectRoot);

  const coordinator = {
    status: 'idle',
    currentTask: undefined,
    model: undefined,
    lastActivityAtMs: null,
    usage: createUsageTotals(),
    _version: 0,
    _cache: null,
  };

  const usageState = {
    session: createUsageTotals(),
    byModel: new Map(),
    prompts: [],
    promptsById: new Map(),
    activePromptId: null,
    liveSinceMs: null,
    sessionNanoAiuAuthoritative: 0,
    premiumRequests: 0,
    _cache: null,
    _deltaCache: null,
  };

  function initializeFromFiles(filesSnapshot = {}) {
    projectRoot = filesSnapshot.projectRoot ?? projectRoot ?? null;
    noSquad = Boolean(filesSnapshot.noSquad ?? !projectRoot);
    files = {
      decisionsInboxCount: Number(filesSnapshot.files?.decisionsInboxCount ?? 0),
      orchestrationLogCount: Number(filesSnapshot.files?.orchestrationLogCount ?? 0),
      logCount: Number(filesSnapshot.files?.logCount ?? 0),
      lastFileActivityAtMs: toTimestampMs(filesSnapshot.files?.lastFileActivityAt) ?? files.lastFileActivityAtMs ?? null,
    };
    errors = Array.isArray(filesSnapshot.errors) ? [...filesSnapshot.errors] : errors;
    pricingUsdPerAiu = readUsdPerAiu(process.env.SQUAD_DASHBOARD_USD_PER_AIU)
      ?? readUsdPerAiu(filesSnapshot.pricingUsdPerAiu)
      ?? readProjectUsdPerAiu(projectRoot)
      ?? null;

    const nextRosterIds = new Set();
    rosterById.clear();
    rosterOrder.clear();

    for (const member of filesSnapshot.roster ?? []) {
      if (!member?.id) continue;
      const rosterMember = {
        id: member.id,
        name: member.name || member.id,
        role: member.role,
        badge: member.badge,
        kind: member.kind || 'member',
        charter: member.charter,
      };
      rosterById.set(member.id, rosterMember);
      rosterOrder.set(member.id, rosterOrder.size);
      nextRosterIds.add(member.id);

      const agent = ensureAgent(member.id, rosterMember);
      agent.name = rosterMember.name;
      agent.role = rosterMember.role;
      agent.badge = rosterMember.badge;
      agent.kind = rosterMember.kind;
      agent.roster = true;
      markAgentDirty(agent);
    }

    for (const agent of agents.values()) {
      if (agent.roster && !nextRosterIds.has(agent.id)) {
        agent.roster = false;
        agent.kind = 'unknown';
        markAgentDirty(agent);
      }
    }

    for (const item of filesSnapshot.activity ?? []) addActivity(item, { notify: false });
    markStateDirty();
    emitSnapshot();
    return getSnapshot();
  }

  function ingestSessionEvent(event = {}) {
    if (closed || !event?.type || !RELEVANT_EVENT_TYPES.has(event.type)) return getSnapshot();
    if (event.id) {
      if (processedEventIds.has(event.id)) return getSnapshot();
      processedEventIds.set(event.id, true);
    }

    const timestampMs = toTimestampMs(event.timestamp) ?? now();
    const currentEventOrder = ++eventOrder;
    if (!backfillProgress) eventBackfill = true;

    switch (event.type) {
      case 'user.message':
        handleUserMessage(event, timestampMs, currentEventOrder);
        break;
      case 'assistant.turn_start':
        handleAssistantTurnStart(event, timestampMs, currentEventOrder);
        break;
      case 'assistant.message':
        handleAssistantMessage(event, timestampMs);
        break;
      case 'assistant.turn_end':
        handleAssistantTurnEnd(event, timestampMs);
        break;
      case 'assistant.usage':
        handleAssistantUsage(event, timestampMs, currentEventOrder);
        break;
      case 'session.idle':
        handleSessionIdle(event, timestampMs);
        break;
      case 'session.shutdown':
        handleSessionShutdown(event);
        break;
      case 'session.usage_checkpoint':
        handleUsageCheckpoint(event);
        break;
      case 'tool.execution_start':
        handleToolStart(event, timestampMs);
        break;
      case 'tool.execution_complete':
        handleToolComplete(event, timestampMs);
        break;
      case 'subagent.started':
        handleSubagentStarted(event, timestampMs, currentEventOrder);
        break;
      case 'subagent.configured':
        handleSubagentConfigured(event, timestampMs, currentEventOrder);
        break;
      case 'subagent.completed':
        handleSubagentCompleted(event, timestampMs, currentEventOrder);
        break;
      case 'subagent.failed':
        handleSubagentFailed(event, timestampMs, currentEventOrder);
        break;
      default:
        break;
    }

    updateDerivedTimer();
    return getSnapshot();
  }

  function ingestFileEvent(fileEvent = {}) {
    if (closed || !fileEvent?.type) return getSnapshot();
    const timestampMs = toTimestampMs(fileEvent.timestamp) ?? now();

    files.lastFileActivityAtMs = timestampMs;
    if (fileEvent.kind === 'decision-inbox') {
      files.decisionsInboxCount = Math.max(0, files.decisionsInboxCount + countDelta(fileEvent.type));
    } else if (fileEvent.kind === 'orchestration-log') {
      files.orchestrationLogCount = Math.max(0, files.orchestrationLogCount + countDelta(fileEvent.type));
    } else if (fileEvent.kind === 'log') {
      files.logCount = Math.max(0, files.logCount + countDelta(fileEvent.type));
    }

    const item = addActivity({
      id: `file-event:${fileEvent.path ?? fileEvent.kind}:${timestampMs}:${fileEvent.type}`,
      timestamp: timestampMs,
      agentId: fileEvent.agentId,
      level: fileEvent.type === 'file.deleted' ? 'warning' : 'info',
      text: describeFileEvent(fileEvent),
      source: 'file',
    });

    if (fileEvent.kind === 'history' && fileEvent.agentId) {
      const agent = ensureAgent(fileEvent.agentId);
      if (!RUNNING_STATUSES.has(agent.status) && agent.status !== 'failed') {
        agent.lastActivityAtMs = timestampMs;
        markAgentDirty(agent);
        emitAgent(agent.id);
      }
    }

    if (item) {
      markStateDirty();
      emitFiles();
      updateDerivedTimer();
    }
    return getSnapshot();
  }

  function refresh() {
    if (!config.readFiles) {
      const snapshot = getSnapshot();
      emitSnapshot(snapshot);
      return snapshot;
    }

    try {
      const result = config.readFiles();
      if (result && typeof result.then === 'function') {
        return result
          .then((filesSnapshot) => initializeFromFiles(filesSnapshot))
          .catch((error) => {
            errors = [...errors, error?.message || String(error)];
            markStateDirty();
            const snapshot = getSnapshot();
            emitSnapshot(snapshot);
            return snapshot;
          });
      }
      return initializeFromFiles(result);
    } catch (error) {
      errors = [...errors, error?.message || String(error)];
      markStateDirty();
      const snapshot = getSnapshot();
      emitSnapshot(snapshot);
      return snapshot;
    }
  }

  function getSnapshot() {
    const currentNow = now();
    if (!snapshotDirty && snapshotCache && (!snapshotCache.nextDueAt || snapshotCache.nextDueAt > currentNow)) {
      return snapshotCache.snapshot;
    }

    let nextDueAt = coordinatorNextDueAt();
    const agentSnapshots = [...agents.values()]
      .map((agent) => {
        const snapshot = snapshotAgent(agent, currentNow);
        if (snapshot._nextDueAt && snapshot._nextDueAt < nextDueAt) nextDueAt = snapshot._nextDueAt;
        return snapshot;
      })
      .sort(compareAgents)
      .map(({ _nextDueAt, ...rest }) => rest);

    const coordinatorSnapshot = snapshotCoordinator(currentNow);
    if (coordinatorSnapshot._nextDueAt && coordinatorSnapshot._nextDueAt < nextDueAt) {
      nextDueAt = coordinatorSnapshot._nextDueAt;
    }

    const snapshot = {
      schemaVersion: 1,
      generatedAt: toIso(currentNow),
      projectRoot,
      noSquad,
      coordinator: stripInternal(coordinatorSnapshot),
      agents: agentSnapshots,
      activity: activity.map(snapshotActivityItem),
      files: snapshotFiles(),
      usage: snapshotUsage(currentNow),
      meta: {
        source: 'live',
        eventBackfill,
        ...(backfillProgress ? { backfill: { ...backfillProgress } } : {}),
        errors: [...errors],
      },
    };

    snapshotDirty = false;
    snapshotCache = {
      snapshot,
      nextDueAt: Number.isFinite(nextDueAt) ? nextDueAt : null,
      version: stateVersion,
    };
    updateDerivedTimer();
    return snapshot;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    updateDerivedTimer();
    return () => {
      listeners.delete(listener);
      updateDerivedTimer();
    };
  }

  function setNote(agentId, note) {
    const id = normalizeAgentKey(agentId) || String(agentId || 'unknown');
    const agent = agents.get(id);
    if (!agent) return null;
    agent.note = String(note ?? '');
    markAgentDirty(agent);
    emitAgent(agent.id);
    updateDerivedTimer();
    return stripInternal(snapshotAgent(agent, now()));
  }

  function close() {
    closed = true;
    if (derivedTimer) clearTimeout(derivedTimer);
    derivedTimer = null;
    listeners.clear();
  }

  function handleUserMessage(event, timestampMs, currentEventOrder) {
    if (event.agentId) {
      const reactivated = reactivateKnownRuntimeAgent(event.agentId, timestampMs, { eventOrder: currentEventOrder });
      if (reactivated) emitAgent(reactivated.id);
    } else {
      lastRootEventType = event.type;
    }
    closeActivePrompt(timestampMs);
    const text = truncatePromptText(event.data?.content);
    const prompt = createPrompt(text || 'Prompt', timestampMs);
    usageState.activePromptId = prompt.id;
    touchPrompt(prompt);
    emitPrompt(prompt);
  }

  function handleAssistantTurnStart(event, timestampMs, currentEventOrder) {
    if (event.agentId) {
      const reactivated = reactivateKnownRuntimeAgent(event.agentId, timestampMs, { model: event.data?.model, eventOrder: currentEventOrder });
      if (reactivated) emitAgent(reactivated.id);
      return;
    }
    lastRootEventType = event.type;
    coordinator.status = 'thinking';
    coordinator.model = event.data?.model ?? coordinator.model;
    coordinator.lastActivityAtMs = timestampMs;
    markCoordinatorDirty();
  }

  function handleAssistantMessage(event, timestampMs) {
    if (!event.agentId) return;
    if (terminalRuntimeAgents.has(event.agentId)) return;
    const reactivated = reactivateKnownRuntimeAgent(event.agentId, timestampMs, { model: event.data?.model });
    if (reactivated) emitAgent(reactivated.id);
  }

  function handleAssistantTurnEnd(event, timestampMs) {
    if (event.agentId) return;
    lastRootEventType = event.type;
    coordinator.lastActivityAtMs = timestampMs;
    if (rootToolInFlight.size === 0) {
      coordinator.status = 'idle';
      coordinator.currentTask = undefined;
    }
    markCoordinatorDirty();
    closeActivePrompt(timestampMs);
  }

  function handleSessionIdle(event, timestampMs) {
    if (event.agentId) return;
    lastRootEventType = event.type;
    coordinator.status = 'idle';
    coordinator.currentTask = undefined;
    coordinator.lastActivityAtMs = timestampMs;
    markCoordinatorDirty();
    closeActivePrompt(timestampMs);
  }

  function handleUsageCheckpoint(event) {
    const totalNanoAiu = finiteNumber(event.data?.totalNanoAiu);
    const totalPremiumRequests = finiteInteger(event.data?.totalPremiumRequests);
    let changed = false;

    if (totalNanoAiu > usageState.sessionNanoAiuAuthoritative) {
      usageState.sessionNanoAiuAuthoritative = totalNanoAiu;
      changed = true;
    }
    if (totalPremiumRequests > usageState.premiumRequests) {
      usageState.premiumRequests = totalPremiumRequests;
      changed = true;
    }

    if (changed) {
      markUsageDirty();
      emitUsageUpdated();
    }
  }

  function handleSessionShutdown(event) {
    const data = event.data ?? {};
    const byModel = metricsByModel(data.modelMetrics);
    applyLiveUsageMetrics({
      totalNanoAiu: data.totalNanoAiu,
      byModel,
      fetchedAt: event.timestamp,
    });
  }

  function applyLiveUsageMetrics({
    totalNanoAiu,
    premiumRequests,
    byModel,
    fetchedAt,
  } = {}) {
    let changed = false;
    const nextNanoAiu = finiteAiuValue(totalNanoAiu);
    if (nextNanoAiu > usageState.sessionNanoAiuAuthoritative) {
      usageState.sessionNanoAiuAuthoritative = nextNanoAiu;
      changed = true;
    }

    const nextPremiumRequests = finiteIntegerOrNull(premiumRequests);
    if (nextPremiumRequests != null && nextPremiumRequests > usageState.premiumRequests) {
      usageState.premiumRequests = nextPremiumRequests;
      changed = true;
    }

    if (byModel && typeof byModel === 'object') {
      for (const [model, metrics] of Object.entries(byModel)) {
        if (!model || !metrics || typeof metrics !== 'object') continue;
        const target = usageState.byModel.get(model) || createUsageTotals();
        const before = cloneUsageTotals(target);
        applyMonotonicUsageField(target, 'requests', metrics.requests);
        applyMonotonicUsageField(target, 'premiumRequests', metrics.premiumRequests);
        applyMonotonicUsageField(target, 'nanoAiu', metrics.nanoAiu);
        applyMonotonicUsageField(target, 'inputTokens', metrics.inputTokens);
        applyMonotonicUsageField(target, 'outputTokens', metrics.outputTokens);
        applyMonotonicUsageField(target, 'cacheReadTokens', metrics.cacheReadTokens);
        applyMonotonicUsageField(target, 'cacheWriteTokens', metrics.cacheWriteTokens);
        const tokenTotal = target.inputTokens + target.outputTokens;
        if (tokenTotal > target.totalTokens) target.totalTokens = tokenTotal;
        if (compareUsageMagnitude(target, before) || target.premiumRequests !== before.premiumRequests) {
          usageState.byModel.set(model, target);
          changed = true;
        }
      }
    }

    const fetchedAtMs = toTimestampMs(fetchedAt);
    if (fetchedAtMs != null && (!usageState.liveSinceMs || fetchedAtMs < usageState.liveSinceMs)) {
      usageState.liveSinceMs = fetchedAtMs;
      changed = true;
    }

    if (changed) {
      markUsageDirty();
      emitUsageUpdated();
    }
    return snapshotUsage(now());
  }

  function setBackfillProgress({
    state,
    processed,
    total,
    error,
  } = {}) {
    const nextState = ['pending', 'running', 'done', 'error'].includes(state) ? state : 'pending';
    const timestampMs = now();
    const previousState = backfillProgress?.state;
    const next = stripUndefined({
      state: nextState,
      processed: finiteIntegerOrNull(processed) ?? backfillProgress?.processed,
      total: finiteIntegerOrNull(total) ?? backfillProgress?.total,
      error: error == null ? undefined : String(error),
      updatedAt: toIso(timestampMs),
    });

    const changed = !backfillProgress || JSON.stringify(next) !== JSON.stringify(backfillProgress);
    backfillProgress = next;
    eventBackfill = nextState === 'done';
    if (changed) markStateDirty();

    const shouldEmit = changed && (previousState !== nextState || timestampMs - lastBackfillEmitAtMs >= 250);
    if (shouldEmit) {
      lastBackfillEmitAtMs = timestampMs;
      emit({ type: 'meta.updated', meta: { backfill: { ...backfillProgress } } });
    }
    return getSnapshot().meta.backfill;
  }

  function handleToolStart(event, timestampMs) {
    const data = event.data ?? {};
    if (!event.agentId) {
      lastRootEventType = event.type;
      if (data.toolCallId) {
        rootToolInFlight.add(data.toolCallId);
        rootToolByToolCallId.set(data.toolCallId, {
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          args: parseArguments(data.arguments),
          model: data.model,
          promptId: currentPromptIdOrSynthetic(timestampMs),
          currentTask: undefined,
          name: undefined,
          mode: undefined,
          timestampMs,
        });
      }

      coordinator.status = 'thinking';
      coordinator.lastActivityAtMs = timestampMs;
      coordinator.model = data.model ?? coordinator.model;
      if (looksLikeSpawnTool(data.toolName, data.arguments)) {
        coordinator.currentTask = 'Spawning squad agent';
        handleTaskToolStart(data, timestampMs);
      }
      markCoordinatorDirty();
      return;
    }

    const terminal = terminalRuntimeAgents.get(event.agentId);
    const agent = ensureAgent(agentIdForRuntime(event.agentId));
    if (terminal) {
      if (data.toolCallId) {
        if (!countedToolCallIds.has(data.toolCallId)) {
          countedToolCallIds.set(data.toolCallId, true);
          agent.counters.toolCalls += 1;
          markAgentDirty(agent);
          emitAgent(agent.id);
        }
      }
      addActivity({
        id: event.id || `tool-start:${data.toolCallId}:${timestampMs}`,
        timestamp: timestampMs,
        agentId: agent.id,
        level: 'info',
        text: `${agent.name} running ${data.toolName || 'tool'}`,
        source: 'session',
      });
      return;
    }

    reactivateKnownRuntimeAgent(event.agentId, timestampMs, { model: data.model });
    agent.status = 'working';
    agent.currentTool = data.toolName;
    agent.lastActivityAtMs = timestampMs;
    if (data.model) agent.model = data.model;

    if (data.toolCallId) {
      inFlightToolByToolCallId.set(data.toolCallId, { agentId: agent.id, toolName: data.toolName });
      if (!countedToolCallIds.has(data.toolCallId)) {
        countedToolCallIds.set(data.toolCallId, true);
        agent.counters.toolCalls += 1;
      }
    }

    markAgentDirty(agent);
    emitAgent(agent.id);
    addActivity({
      id: event.id || `tool-start:${data.toolCallId}:${timestampMs}`,
      timestamp: timestampMs,
      agentId: agent.id,
      level: 'info',
      text: `${agent.name} running ${data.toolName || 'tool'}`,
      source: 'session',
    });
  }

  function handleTaskToolStart(data, timestampMs) {
    const args = parseArguments(data.arguments);
    const label = args.name || args.description || args.agentName || args.agent_type || data.toolCallId;
    const id = normalizeAgentKey(args.name || args.description || args.agentName || label)
      || normalizeAgentKey(data.toolCallId)
      || `agent-${agentSequence + 1}`;
    const display = displayNameForAgent(id, args.description || args.name || label);
    const currentTask = taskText(args.description) || args.prompt || args.name || 'Starting';
    const promptId = currentPromptIdOrSynthetic(timestampMs);
    const agent = ensureAgent(id, { name: display });

    beginAgentRun(agent, {
      toolCallId: data.toolCallId,
      promptId,
      timestampMs,
      model: args.model || data.model,
      mode: args.mode || args.executionMode,
    });

    agent.status = 'spawning';
    agent.currentTask = currentTask;
    agent.taskToolCallId = data.toolCallId;
    agent.lastActivityAtMs = timestampMs;
    agent.error = undefined;
    markAgentDirty(agent);

    const pending = {
      agentId: agent.id,
      currentTask,
      name: display,
      mode: agent.mode,
      model: agent.model,
      promptId,
      timestampMs,
    };
    pendingTaskByToolCallId.set(data.toolCallId, pending);

    const rootTool = rootToolByToolCallId.get(data.toolCallId);
    if (rootTool) Object.assign(rootTool, pending);

    emitAgent(agent.id);
    addActivity({
      id: `task-start:${data.toolCallId}:${timestampMs}`,
      timestamp: timestampMs,
      agentId: agent.id,
      level: 'info',
      text: `${agent.name} spawning${currentTask ? `: ${currentTask}` : ''}`,
      source: 'session',
    });
  }

  function handleToolComplete(event, timestampMs) {
    const data = event.data ?? {};
    const inFlight = data.toolCallId ? inFlightToolByToolCallId.get(data.toolCallId) : null;
    const agent = event.agentId
      ? ensureAgent(agentIdForRuntime(event.agentId))
      : (inFlight ? agents.get(inFlight.agentId) : null);

    if (!event.agentId) {
      lastRootEventType = event.type;
      if (data.toolCallId) {
        rootToolInFlight.delete(data.toolCallId);
        rootToolByToolCallId.delete(data.toolCallId);
      }
      coordinator.lastActivityAtMs = timestampMs;
      if (rootToolInFlight.size === 0 && lastRootEventType !== 'assistant.turn_start') {
        coordinator.status = 'idle';
        coordinator.currentTask = undefined;
      }
      markCoordinatorDirty();
    }

    if (!agent) return;

    if (event.agentId && terminalRuntimeAgents.has(event.agentId)) {
      addActivity({
        id: event.id || `tool-complete:${data.toolCallId}:${timestampMs}`,
        timestamp: timestampMs,
        agentId: agent.id,
        level: data.success ? 'success' : 'error',
        text: `${agent.name} ${data.success ? 'completed' : 'failed'} ${inFlight?.toolName || 'tool'}`,
        source: 'session',
      });
      inFlightToolByToolCallId.delete(data.toolCallId);
      return;
    }

    const toolName = inFlight?.toolName || agent.currentTool || 'tool';
    if (!inFlight || agent.currentTool === inFlight.toolName) agent.currentTool = undefined;
    agent.lastActivityAtMs = timestampMs;
    if (data.model) agent.model = data.model;
    inFlightToolByToolCallId.delete(data.toolCallId);
    markAgentDirty(agent);
    emitAgent(agent.id);

    addActivity({
      id: event.id || `tool-complete:${data.toolCallId}:${timestampMs}`,
      timestamp: timestampMs,
      agentId: agent.id,
      level: data.success ? 'success' : 'error',
      text: `${agent.name} ${data.success ? 'completed' : 'failed'} ${toolName}`,
      source: 'session',
    });
  }

  function handleSubagentStarted(event, timestampMs, currentEventOrder) {
    const data = event.data ?? {};
    if (event.agentId && isTerminalRuntimeStale(event.agentId, timestampMs, currentEventOrder)) return;
    const pending = resolvePendingTask(data.toolCallId);
    const id = pending?.agentId || normalizeAgentKey(data.agentName || data.agentDisplayName || data.agentDescription || event.agentId);
    let agent = ensureAgent(id || `agent-${agentSequence + 1}`, {
      name: data.agentDisplayName || pending?.name || data.agentName,
    });

    if (event.agentId) {
      const existingId = runtimeToAgent.get(event.agentId);
      if (existingId && existingId !== agent.id) agent = mergeAgents(existingId, agent.id);
      runtimeToAgent.set(event.agentId, agent.id);
    }

    if (!agent.run || agent.run.toolCallId !== data.toolCallId) {
      beginAgentRun(agent, {
        toolCallId: data.toolCallId,
        promptId: pending?.promptId ?? currentPromptIdOrSynthetic(timestampMs),
        timestampMs: pending?.timestampMs ?? timestampMs,
        model: data.model || pending?.model,
        mode: data.executionMode || pending?.mode,
      });
    }

    agent.status = 'working';
    agent.runtimeAgentId = event.agentId;
    if (event.agentId) terminalRuntimeAgents.delete(event.agentId);
    agent.taskToolCallId = data.toolCallId || agent.taskToolCallId;
    agent.currentTask = pending?.currentTask || agent.currentTask || data.agentDescription;
    agent.startedAtMs = agent.run?.startedAtMs || agent.startedAtMs || timestampMs;
    agent.lastActivityAtMs = timestampMs;
    agent.model = data.model || pending?.model || agent.model;
    agent.mode = data.executionMode || pending?.mode || agent.mode;
    agent.error = undefined;
    markAgentDirty(agent);

    emitAgent(agent.id);
    addActivity({
      id: event.id || `subagent-start:${event.agentId || data.toolCallId}:${timestampMs}`,
      timestamp: timestampMs,
      agentId: agent.id,
      level: 'info',
      text: `${agent.name} started${agent.currentTask ? `: ${agent.currentTask}` : ''}`,
      source: 'session',
    });
  }

  function handleSubagentConfigured(event, timestampMs, currentEventOrder) {
    if (!event.agentId) return;
    if (isTerminalRuntimeStale(event.agentId, timestampMs, currentEventOrder)) return;
    const agent = ensureAgent(agentIdForRuntime(event.agentId));
    reactivateKnownRuntimeAgent(event.agentId, timestampMs, { model: event.data?.model, eventOrder: currentEventOrder });
    agent.model = event.data?.model || agent.model;
    if (agent.run) agent.run.model = event.data?.model || agent.run.model;
    agent.lastActivityAtMs = timestampMs;
    markAgentDirty(agent);
    emitAgent(agent.id);
  }

  function handleSubagentCompleted(event, timestampMs, currentEventOrder) {
    const data = event.data ?? {};
    const agent = resolveSubagent(event, data, timestampMs);
    if (!agent) return;

    if (finiteInteger(data.totalTokens) > 0) {
      applyEstimatedRunUsage(agent, finiteInteger(data.totalTokens), data.model || data.firstDispatchedModel || agent.model);
    }

    agent.status = 'done';
    agent.currentTool = undefined;
    agent.lastActivityAtMs = timestampMs;
    agent.model = data.model || data.firstDispatchedModel || agent.model;
    agent.counters.completedTasks += 1;
    agent.error = undefined;
    if (event.agentId) recordTerminalRuntime(event.agentId, 'done', timestampMs, currentEventOrder);
    pendingTaskByToolCallId.delete(data.toolCallId);
    rootToolByToolCallId.delete(data.toolCallId);
    rootToolInFlight.delete(data.toolCallId);
    markAgentDirty(agent);
    emitAgent(agent.id);
    emitUsageUpdated();

    addActivity({
      id: event.id || `subagent-complete:${event.agentId || data.toolCallId}:${timestampMs}`,
      timestamp: timestampMs,
      agentId: agent.id,
      level: data.cancelled ? 'warning' : 'success',
      text: `${agent.name} ${data.cancelled ? 'cancelled' : 'completed'}`,
      source: 'session',
    });
  }

  function handleSubagentFailed(event, timestampMs, currentEventOrder) {
    const data = event.data ?? {};
    const agent = resolveSubagent(event, data, timestampMs);
    if (!agent) return;

    if (finiteInteger(data.totalTokens) > 0) {
      applyEstimatedRunUsage(agent, finiteInteger(data.totalTokens), data.model || data.firstDispatchedModel || agent.model);
    }

    agent.status = 'failed';
    agent.currentTool = undefined;
    agent.lastActivityAtMs = timestampMs;
    agent.model = data.model || data.firstDispatchedModel || agent.model;
    agent.error = data.error || 'Sub-agent failed';
    agent.counters.failedTasks += 1;
    if (event.agentId) recordTerminalRuntime(event.agentId, 'failed', timestampMs, currentEventOrder);
    pendingTaskByToolCallId.delete(data.toolCallId);
    rootToolByToolCallId.delete(data.toolCallId);
    rootToolInFlight.delete(data.toolCallId);
    markAgentDirty(agent);
    emitAgent(agent.id);
    emitUsageUpdated();

    addActivity({
      id: event.id || `subagent-failed:${event.agentId || data.toolCallId}:${timestampMs}`,
      timestamp: timestampMs,
      agentId: agent.id,
      level: 'error',
      text: `${agent.name} failed: ${agent.error}`,
      source: 'session',
    });
  }

  function handleAssistantUsage(event, timestampMs, currentEventOrder) {
    const data = event.data ?? {};
    const apiCallId = typeof data.apiCallId === 'string' && data.apiCallId ? data.apiCallId : null;
    const absolute = usageFromAssistantData(data);
    let delta = absolute;

    if (apiCallId) {
      if (apiUsageById.has(apiCallId)) return;
      apiUsageById.set(apiCallId, absolute);
    }

    if (!hasMeaningfulUsage(delta)) return;

    if (!usageState.liveSinceMs || timestampMs < usageState.liveSinceMs) {
      usageState.liveSinceMs = timestampMs;
    }

    let agent = null;
    let contributorKey = 'coordinator';
    let model = typeof data.model === 'string' && data.model ? data.model : undefined;
    let promptId = usageState.activePromptId;

    if (event.agentId) {
      const terminal = terminalRuntimeAgents.get(event.agentId);
      agent = ensureAgent(agentIdForRuntime(event.agentId));
      contributorKey = agent.id;
      model = model || agent.model;
      if (!terminal || !isAfterTerminal(terminal, timestampMs, currentEventOrder)) {
        if (agent.run?.estimatedTokensApplied && !agent.run.actualSeen) {
          removeEstimatedRunUsage(agent);
        }
        if (!agent.run) {
          beginAgentRun(agent, {
            toolCallId: agent.taskToolCallId,
            promptId: currentPromptIdOrSynthetic(timestampMs),
            timestampMs,
            model,
            mode: agent.mode,
          });
        }
        agent.run.actualSeen = true;
        promptId = agent.run.promptId || currentPromptIdOrSynthetic(timestampMs);
        addUsage(agent.totalUsage, delta);
        addUsageToModelMap(agent.byModel, model, delta);
        addUsage(agent.run.usage, delta);
        addUsageToModelMap(agent.run.byModel, model, delta);
        if (model) agent.run.model = model;
        if (model) agent.model = model;
        if (!terminal) agent.lastActivityAtMs = timestampMs;
        markAgentDirty(agent);
        emitAgent(agent.id);
      } else {
        agent = null;
        contributorKey = null;
        promptId = null;
      }
    } else {
      addUsage(coordinator.usage, delta);
      coordinator.lastActivityAtMs = timestampMs;
      if (model) coordinator.model = model;
      markCoordinatorDirty();
      promptId = currentPromptIdOrSynthetic(timestampMs);
    }

    addUsage(usageState.session, delta);
    addUsageToModelMap(usageState.byModel, model, delta);

    const prompt = ensurePromptById(promptId, timestampMs);
    if (prompt) {
      addUsage(prompt.totals, delta);
      if (contributorKey) addUsageToPromptAgent(prompt, contributorKey, delta);
      touchPrompt(prompt);
    }

    markUsageDirty();
    emitUsageUpdated();
  }

  function resolveSubagent(event, data, timestampMs) {
    if (event.agentId && runtimeToAgent.has(event.agentId)) {
      const mapped = agents.get(runtimeToAgent.get(event.agentId));
      if (mapped) {
        if (!mapped.run || mapped.run.toolCallId !== data.toolCallId) {
          beginAgentRun(mapped, {
            toolCallId: data.toolCallId,
            promptId: resolvePendingTask(data.toolCallId)?.promptId ?? currentPromptIdOrSynthetic(timestampMs),
            timestampMs,
            model: data.model || mapped.model,
            mode: mapped.mode,
          });
        }
        return mapped;
      }
    }

    const pending = resolvePendingTask(data.toolCallId);
    if (pending) {
      const agent = ensureAgent(pending.agentId, { name: pending.name });
      if (!agent.run || agent.run.toolCallId !== data.toolCallId) {
        beginAgentRun(agent, {
          toolCallId: data.toolCallId,
          promptId: pending.promptId,
          timestampMs: pending.timestampMs ?? timestampMs,
          model: data.model || pending.model,
          mode: pending.mode,
        });
      }
      return agent;
    }

    const id = normalizeAgentKey(data.agentName || data.agentDisplayName || event.agentId);
    if (!id) return null;
    const agent = ensureAgent(id, { name: data.agentDisplayName || data.agentName });
    if (!agent.run || agent.run.toolCallId !== data.toolCallId) {
      beginAgentRun(agent, {
        toolCallId: data.toolCallId,
        promptId: currentPromptIdOrSynthetic(timestampMs),
        timestampMs,
        model: data.model || agent.model,
        mode: agent.mode,
      });
    }
    return agent;
  }

  function resolvePendingTask(toolCallId) {
    if (!toolCallId) return null;
    const pending = pendingTaskByToolCallId.get(toolCallId);
    if (pending) return pending;

    const rootTool = rootToolByToolCallId.get(toolCallId);
    if (!rootTool) return null;

    const args = rootTool.args ?? {};
    const label = args.name || args.description || args.agentName || args.agent_type || rootTool.toolName || toolCallId;
    const id = normalizeAgentKey(args.name || args.description || args.agentName || label) || normalizeAgentKey(toolCallId);
    const resolved = {
      agentId: id,
      currentTask: taskText(args.description) || args.prompt || args.name || rootTool.toolName || 'Starting',
      name: displayNameForAgent(id, args.description || args.name || label),
      mode: args.mode || args.executionMode,
      model: args.model || rootTool.model,
      promptId: rootTool.promptId || currentPromptIdOrSynthetic(now()),
      timestampMs: rootTool.timestampMs,
    };
    pendingTaskByToolCallId.set(toolCallId, resolved);
    return resolved;
  }

  function ensureAgent(id, seed = {}) {
    const normalized = normalizeAgentKey(id) || String(id || `unknown-${agentSequence + 1}`);
    let agent = agents.get(normalized);
    if (agent) return agent;

    const roster = rosterById.get(normalized);
    agent = {
      id: normalized,
      name: roster?.name || displayNameForAgent(normalized, seed.name || normalized),
      role: roster?.role || seed.role,
      badge: roster?.badge || seed.badge,
      roster: Boolean(roster),
      kind: roster?.kind || seed.kind || 'unknown',
      status: 'idle',
      currentTask: undefined,
      currentTool: undefined,
      model: seed.model,
      mode: seed.mode,
      note: undefined,
      runtimeAgentId: undefined,
      taskToolCallId: undefined,
      startedAtMs: null,
      lastActivityAtMs: null,
      error: undefined,
      counters: {
        toolCalls: 0,
        completedTasks: 0,
        failedTasks: 0,
      },
      totalUsage: createUsageTotals(),
      byModel: new Map(),
      run: null,
      _sequence: agentSequence,
      _version: 0,
      _cache: null,
    };
    agentSequence += 1;
    agents.set(normalized, agent);
    markAgentDirty(agent);
    return agent;
  }

  function agentIdForRuntime(runtimeAgentId) {
    if (runtimeToAgent.has(runtimeAgentId)) return runtimeToAgent.get(runtimeAgentId);
    const id = normalizeAgentKey(runtimeAgentId) || `agent-${agentSequence + 1}`;
    runtimeToAgent.set(runtimeAgentId, id);
    return id;
  }

  function mergeAgents(sourceId, targetId) {
    const source = agents.get(sourceId);
    const target = ensureAgent(targetId);
    if (!source || source === target) return target;

    target.counters.toolCalls += source.counters.toolCalls;
    target.counters.completedTasks += source.counters.completedTasks;
    target.counters.failedTasks += source.counters.failedTasks;
    target.currentTool ??= source.currentTool;
    target.currentTask ??= source.currentTask;
    target.startedAtMs = pickNumber(target.startedAtMs, source.startedAtMs, Math.min);
    target.lastActivityAtMs = pickNumber(target.lastActivityAtMs, source.lastActivityAtMs, Math.max);
    target.model ??= source.model;
    target.mode ??= source.mode;
    target.error ??= source.error;
    target.note ??= source.note;
    target.runtimeAgentId ??= source.runtimeAgentId;
    target.taskToolCallId ??= source.taskToolCallId;

    addUsage(target.totalUsage, source.totalUsage);
    mergeModelMaps(target.byModel, source.byModel);

    if (source.run) {
      if (!target.run) {
        target.run = source.run;
      } else if (target.run.toolCallId === source.run.toolCallId) {
        addUsage(target.run.usage, source.run.usage);
        mergeModelMaps(target.run.byModel, source.run.byModel);
        target.run.promptId ??= source.run.promptId;
        target.run.startedAtMs = pickNumber(target.run.startedAtMs, source.run.startedAtMs, Math.min);
        target.run.model ??= source.run.model;
        target.run.mode ??= source.run.mode;
        target.run.actualSeen ||= source.run.actualSeen;
        target.run.estimatedTokensApplied += source.run.estimatedTokensApplied;
      } else if ((source.run.startedAtMs ?? 0) >= (target.run.startedAtMs ?? 0)) {
        target.run = source.run;
      }
    }

    for (const [toolCallId, inFlight] of inFlightToolByToolCallId.entries()) {
      if (inFlight.agentId === sourceId) inFlightToolByToolCallId.set(toolCallId, { ...inFlight, agentId: target.id });
    }
    for (const [runtimeId, mappedId] of runtimeToAgent.entries()) {
      if (mappedId === sourceId) runtimeToAgent.set(runtimeId, target.id);
    }

    agents.delete(sourceId);
    markAgentDirty(target);
    return target;
  }

  function beginAgentRun(agent, { toolCallId, promptId, timestampMs, model, mode }) {
    agent.run = {
      toolCallId: toolCallId || agent.taskToolCallId || undefined,
      promptId: promptId || currentPromptIdOrSynthetic(timestampMs),
      startedAtMs: timestampMs ?? now(),
      model: model || agent.model,
      mode: mode || agent.mode,
      usage: createUsageTotals(),
      byModel: new Map(),
      estimatedTokensApplied: 0,
      actualSeen: false,
    };
    agent.startedAtMs = agent.run.startedAtMs;
    agent.taskToolCallId = toolCallId || agent.taskToolCallId;
    if (model) agent.model = model;
    if (mode) agent.mode = mode;
    markAgentDirty(agent);
  }

  function recordTerminalRuntime(runtimeAgentId, status, terminalAt, terminalOrder) {
    terminalRuntimeAgents.set(runtimeAgentId, { status, terminalAt, terminalOrder });
  }

  function isAfterTerminal(terminal, timestampMs, currentEventOrder = eventOrder) {
    if (!terminal) return true;
    if (timestampMs > terminal.terminalAt) return true;
    if (timestampMs < terminal.terminalAt) return false;
    return currentEventOrder > terminal.terminalOrder;
  }

  function isTerminalRuntimeStale(runtimeAgentId, timestampMs, currentEventOrder) {
    const terminal = terminalRuntimeAgents.get(runtimeAgentId);
    return Boolean(terminal && !isAfterTerminal(terminal, timestampMs, currentEventOrder));
  }

  function reactivateKnownRuntimeAgent(runtimeAgentId, timestampMs, { model, eventOrder: currentEventOrder } = {}) {
    const mappedAgentId = runtimeToAgent.get(runtimeAgentId);
    if (!mappedAgentId) return null;
    const agent = agents.get(mappedAgentId);
    if (!agent) return null;
    if (!['done', 'idle', 'failed'].includes(agent.status)) return null;
    const terminal = terminalRuntimeAgents.get(runtimeAgentId);
    if (terminal && !isAfterTerminal(terminal, timestampMs, currentEventOrder)) return null;

    beginAgentRun(agent, {
      toolCallId: agent.taskToolCallId,
      promptId: currentPromptIdOrSynthetic(timestampMs),
      timestampMs,
      model: model || agent.model,
      mode: agent.mode,
    });
    agent.status = 'working';
    agent.currentTool = undefined;
    agent.lastActivityAtMs = timestampMs;
    agent.error = undefined;
    if (model) agent.model = model;
    terminalRuntimeAgents.delete(runtimeAgentId);
    markAgentDirty(agent);
    return agent;
  }

  function applyEstimatedRunUsage(agent, totalTokens, model) {
    if (!agent.run || agent.run.estimatedTokensApplied || agent.run.actualSeen || totalTokens <= 0) return;
    const promptId = agent.run.promptId || currentPromptIdOrSynthetic(now());
    const delta = createUsageTotals();
    delta.estimatedTokens = totalTokens;

    addUsage(agent.totalUsage, delta);
    addUsageToModelMap(agent.byModel, model, delta);
    addUsage(agent.run.usage, delta);
    addUsageToModelMap(agent.run.byModel, model, delta);
    addUsage(usageState.session, delta);
    addUsageToModelMap(usageState.byModel, model, delta);

    const prompt = ensurePromptById(promptId, agent.run.startedAtMs ?? now());
    if (prompt) {
      addUsage(prompt.totals, delta);
      addUsageToPromptAgent(prompt, agent.id, delta);
      touchPrompt(prompt);
    }

    agent.run.estimatedTokensApplied = totalTokens;
    estimatedUsageCount += 1;
    markAgentDirty(agent);
    markUsageDirty();
  }

  function removeEstimatedRunUsage(agent) {
    if (!agent.run?.estimatedTokensApplied) return;
    const totalTokens = agent.run.estimatedTokensApplied;
    const model = agent.run.model || agent.model;
    const promptId = agent.run.promptId;
    const delta = createUsageTotals();
    delta.estimatedTokens = totalTokens;

    subtractUsage(agent.totalUsage, delta);
    subtractUsageFromModelMap(agent.byModel, model, delta);
    subtractUsage(agent.run.usage, delta);
    subtractUsageFromModelMap(agent.run.byModel, model, delta);
    subtractUsage(usageState.session, delta);
    subtractUsageFromModelMap(usageState.byModel, model, delta);

    const prompt = promptId ? usageState.promptsById.get(promptId) : null;
    if (prompt) {
      subtractUsage(prompt.totals, delta);
      subtractUsageFromPromptAgent(prompt, agent.id, delta);
      touchPrompt(prompt);
    }

    agent.run.estimatedTokensApplied = 0;
    estimatedUsageCount = Math.max(0, estimatedUsageCount - 1);
    markAgentDirty(agent);
    markUsageDirty();
  }

  function createPrompt(text, timestampMs) {
    const prompt = {
      id: `prompt-${promptSequence + 1}`,
      index: promptSequence + 1,
      startedAtMs: timestampMs,
      endedAtMs: null,
      text,
      active: true,
      totals: createUsageTotals(),
      byAgent: new Map(),
      _version: 0,
      _cache: null,
    };
    promptSequence += 1;
    usageState.prompts.push(prompt.id);
    usageState.promptsById.set(prompt.id, prompt);
    while (usageState.prompts.length > config.promptLimit) {
      const removedId = usageState.prompts.shift();
      if (removedId) usageState.promptsById.delete(removedId);
    }
    markUsageDirty();
    return prompt;
  }

  function ensurePromptById(promptId, timestampMs) {
    if (!promptId) return null;
    const existing = usageState.promptsById.get(promptId);
    if (existing) return existing;
    if (promptId !== SYNTHETIC_PROMPT_ID) return null;

    const synthetic = {
      id: SYNTHETIC_PROMPT_ID,
      index: 0,
      startedAtMs: timestampMs ?? now(),
      endedAtMs: null,
      text: 'Before first prompt',
      active: true,
      totals: createUsageTotals(),
      byAgent: new Map(),
      _version: 0,
      _cache: null,
    };
    usageState.prompts.unshift(SYNTHETIC_PROMPT_ID);
    usageState.promptsById.set(SYNTHETIC_PROMPT_ID, synthetic);
    usageState.activePromptId = SYNTHETIC_PROMPT_ID;
    while (usageState.prompts.length > config.promptLimit) {
      const removedId = usageState.prompts.shift();
      if (removedId && removedId !== SYNTHETIC_PROMPT_ID) usageState.promptsById.delete(removedId);
    }
    markUsageDirty();
    return synthetic;
  }

  function closeActivePrompt(timestampMs) {
    const prompt = usageState.activePromptId ? usageState.promptsById.get(usageState.activePromptId) : null;
    if (!prompt || !prompt.active) return;
    prompt.active = false;
    prompt.endedAtMs = timestampMs;
    usageState.activePromptId = null;
    touchPrompt(prompt);
    emitPrompt(prompt);
  }

  function currentPromptIdOrSynthetic(timestampMs) {
    if (usageState.activePromptId && usageState.promptsById.has(usageState.activePromptId)) {
      return usageState.activePromptId;
    }
    return ensurePromptById(SYNTHETIC_PROMPT_ID, timestampMs)?.id ?? SYNTHETIC_PROMPT_ID;
  }

  function addUsageToPromptAgent(prompt, key, delta) {
    const usage = prompt.byAgent.get(key) || createUsageTotals();
    addUsage(usage, delta);
    prompt.byAgent.set(key, usage);
  }

  function subtractUsageFromPromptAgent(prompt, key, delta) {
    const usage = prompt.byAgent.get(key);
    if (!usage) return;
    subtractUsage(usage, delta);
    if (isZeroUsage(usage)) prompt.byAgent.delete(key);
  }

  function addActivity(item, { notify = true } = {}) {
    if (!item?.id || activityIds.has(item.id)) return null;
    const clean = {
      id: String(item.id),
      timestampMs: typeof item.timestamp === 'number' ? item.timestamp : (toTimestampMs(item.timestamp) ?? now()),
      agentId: item.agentId,
      level: item.level || 'info',
      text: item.text || 'Activity',
      source: item.source || 'system',
      _sequence: activitySequence,
      _cache: null,
    };
    activitySequence += 1;
    activityIds.add(clean.id);
    activity.unshift(clean);
    while (activity.length > config.maxFeed) {
      const removed = activity.pop();
      if (removed) activityIds.delete(removed.id);
    }
    markStateDirty();
    if (notify) emit({ type: 'activity.added', item: snapshotActivityItem(clean) });
    return clean;
  }

  function snapshotActivityItem(item) {
    if (item._cache) return item._cache;
    item._cache = {
      id: item.id,
      timestamp: toIso(item.timestampMs),
      ...(item.agentId ? { agentId: item.agentId } : {}),
      level: item.level,
      text: item.text,
      source: item.source,
    };
    return item._cache;
  }

  function snapshotAgent(agent, currentNow) {
    const nextDueAt = agentNextDueAt(agent);
    if (agent._cache && agent._cache.version === agent._version && (!nextDueAt || nextDueAt > currentNow)) {
      return agent._cache.snapshot;
    }

    const derived = deriveAgentStatus(agent, currentNow);
    const snapshot = {
      id: agent.id,
      name: agent.name,
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.badge ? { badge: agent.badge } : {}),
      roster: agent.roster,
      kind: agent.kind,
      status: derived.status,
      ...(derived.currentTask ? { currentTask: derived.currentTask } : {}),
      ...(derived.currentTool ? { currentTool: derived.currentTool } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.mode ? { mode: agent.mode } : {}),
      ...(agent.note ? { note: agent.note } : {}),
      ...(agent.runtimeAgentId ? { runtimeAgentId: agent.runtimeAgentId } : {}),
      ...(agent.taskToolCallId ? { taskToolCallId: agent.taskToolCallId } : {}),
      ...(agent.startedAtMs ? { startedAt: toIso(agent.startedAtMs) } : {}),
      ...(agent.lastActivityAtMs ? { lastActivityAt: toIso(agent.lastActivityAtMs) } : {}),
      counters: { ...agent.counters },
      ...(agent.error ? { error: agent.error } : {}),
      usage: snapshotAgentUsage(agent),
      _nextDueAt: Number.isFinite(nextDueAt) ? nextDueAt : null,
    };
    agent._cache = {
      version: agent._version,
      snapshot,
    };
    return snapshot;
  }

  function snapshotAgentUsage(agent) {
    const run = agent.run?.usage || createUsageTotals();
    const byModel = snapshotModelMap(agent.byModel);
    return stripUndefined({
      total: cloneUsageTotals(agent.totalUsage),
      run: cloneUsageTotals(run),
      byModel: Object.keys(byModel).length ? byModel : undefined,
      estimated: Boolean(agent.run?.estimatedTokensApplied && !agent.run?.actualSeen),
    });
  }

  function snapshotCoordinator(currentNow) {
    const nextDueAt = coordinatorNextDueAt();
    if (coordinator._cache && coordinator._cache.version === coordinator._version && (!nextDueAt || nextDueAt > currentNow)) {
      return coordinator._cache.snapshot;
    }

    const derivedStatus = deriveCoordinatorStatus(currentNow);
    const snapshot = stripUndefined({
      status: derivedStatus,
      currentTask: derivedStatus === 'thinking' ? coordinator.currentTask : undefined,
      model: coordinator.model,
      lastActivityAt: coordinator.lastActivityAtMs ? toIso(coordinator.lastActivityAtMs) : undefined,
      usage: cloneUsageTotals(coordinator.usage),
      _nextDueAt: Number.isFinite(nextDueAt) ? nextDueAt : null,
    });
    coordinator._cache = {
      version: coordinator._version,
      snapshot,
    };
    return snapshot;
  }

  function snapshotUsage(currentNow) {
    if (usageState._cache && usageState._cache.version === usageVersion) return usageState._cache.snapshot;

    const prompts = [];
    for (let index = usageState.prompts.length - 1; index >= 0; index -= 1) {
      const prompt = usageState.promptsById.get(usageState.prompts[index]);
      if (!prompt) continue;
      prompts.push(snapshotPrompt(prompt));
    }

    const snapshot = stripUndefined({
      session: cloneUsageTotals(usageState.session),
      sessionNanoAiuAuthoritative: usageState.sessionNanoAiuAuthoritative > usageState.session.nanoAiu
        ? usageState.sessionNanoAiuAuthoritative
        : undefined,
      premiumRequests: usageState.premiumRequests || undefined,
      byModel: snapshotModelMap(usageState.byModel),
      prompts,
      activePromptId: usageState.activePromptId || undefined,
      pricing: snapshotPricing(),
      meta: stripUndefined({
        liveSince: usageState.liveSinceMs ? toIso(usageState.liveSinceMs) : undefined,
        partial: Boolean(
          estimatedUsageCount > 0
          || usageState.sessionNanoAiuAuthoritative > usageState.session.nanoAiu,
        ),
      }),
    });

    usageState._cache = {
      version: usageVersion,
      snapshot,
      at: currentNow,
    };
    return snapshot;
  }

  function snapshotPrompt(prompt) {
    if (prompt._cache && prompt._cache.version === prompt._version) return prompt._cache.snapshot;

    const rankedAgents = [...prompt.byAgent.entries()]
      .sort((a, b) => compareUsageMagnitude(b[1], a[1]) || a[0].localeCompare(b[0]))
      .slice(0, config.promptAgentLimit);
    const byAgent = {};
    for (const [agentId, usage] of rankedAgents) {
      byAgent[agentId] = cloneUsageTotals(usage);
    }

    const snapshot = stripUndefined({
      id: prompt.id,
      index: prompt.index,
      startedAt: toIso(prompt.startedAtMs),
      endedAt: prompt.endedAtMs ? toIso(prompt.endedAtMs) : undefined,
      text: prompt.text,
      active: prompt.active,
      totals: cloneUsageTotals(prompt.totals),
      byAgent,
    });
    prompt._cache = {
      version: prompt._version,
      snapshot,
    };
    return snapshot;
  }

  function snapshotFiles() {
    return stripUndefined({
      decisionsInboxCount: files.decisionsInboxCount,
      orchestrationLogCount: files.orchestrationLogCount,
      logCount: files.logCount,
      lastFileActivityAt: files.lastFileActivityAtMs ? toIso(files.lastFileActivityAtMs) : undefined,
    });
  }

  function snapshotPricing() {
    return stripUndefined({
      unitLabel: 'AIU',
      nanoPerUnit: AIU_NANO_PER_UNIT,
      usdPerUnit: pricingUsdPerAiu ?? undefined,
    });
  }

  function snapshotUsageDelta() {
    if (usageState._deltaCache && usageState._deltaCache.version === usageVersion) return usageState._deltaCache.delta;
    const prompt = usageState.activePromptId ? usageState.promptsById.get(usageState.activePromptId) : null;
    const delta = stripUndefined({
      session: cloneUsageTotals(usageState.session),
      sessionNanoAiuAuthoritative: usageState.sessionNanoAiuAuthoritative > usageState.session.nanoAiu
        ? usageState.sessionNanoAiuAuthoritative
        : undefined,
      premiumRequests: usageState.premiumRequests || undefined,
      byModel: snapshotModelMap(usageState.byModel),
      activePrompt: prompt ? snapshotPrompt(prompt) : undefined,
      pricing: snapshotPricing(),
    });
    usageState._deltaCache = {
      version: usageVersion,
      delta,
    };
    return delta;
  }

  function emitAgent(agentId) {
    const agent = agents.get(agentId);
    if (!agent) return;
    emit({ type: 'agent.updated', agent: stripInternal(snapshotAgent(agent, now())) });
  }

  function emitCoordinator() {
    emit({ type: 'coordinator.updated', coordinator: stripInternal(snapshotCoordinator(now())) });
  }

  function emitFiles() {
    emit({ type: 'files.changed', files: snapshotFiles() });
  }

  function emitSnapshot(snapshot = getSnapshot()) {
    emit({ type: 'snapshot', snapshot });
  }

  function emitUsageUpdated() {
    emit({ type: 'usage.updated', usage: snapshotUsageDelta() });
  }

  function emitPrompt(prompt) {
    emit({ type: 'prompt.updated', prompt: snapshotPrompt(prompt) });
    emitUsageUpdated();
  }

  function emit(message) {
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // A subscriber must not break the reducer.
      }
    }
  }

  function deriveAgentStatus(agent, currentNow) {
    let status = agent.status;
    let currentTask = agent.currentTask;
    let currentTool = agent.currentTool;
    const lastMs = agent.lastActivityAtMs ?? agent.startedAtMs;

    if (status === 'done' && lastMs && currentNow - lastMs > config.doneTtlMs) {
      status = 'idle';
      currentTask = undefined;
      currentTool = undefined;
    } else if (RUNNING_STATUSES.has(status) && lastMs && currentNow - lastMs > config.waitingAfterMs) {
      status = 'waiting';
    }

    return { status, currentTask, currentTool };
  }

  function deriveCoordinatorStatus(currentNow) {
    if (
      coordinator.status === 'thinking'
      && lastRootEventType
      && lastRootEventType !== 'assistant.turn_start'
      && rootToolInFlight.size === 0
    ) {
      return 'idle';
    }
    if (
      coordinator.status === 'thinking'
      && coordinator.lastActivityAtMs
      && currentNow - coordinator.lastActivityAtMs > config.idleAfterMs
    ) {
      return 'idle';
    }
    return coordinator.status;
  }

  function agentNextDueAt(agent) {
    const lastMs = agent.lastActivityAtMs ?? agent.startedAtMs;
    if (!lastMs) return Infinity;
    if (agent.status === 'done') return lastMs + config.doneTtlMs;
    if (RUNNING_STATUSES.has(agent.status)) return lastMs + config.waitingAfterMs;
    return Infinity;
  }

  function coordinatorNextDueAt() {
    if (coordinator.status !== 'thinking' || !coordinator.lastActivityAtMs) return Infinity;
    return coordinator.lastActivityAtMs + config.idleAfterMs;
  }

  function compareAgents(a, b) {
    const activeDelta = Number(!LIVE_STATUSES.has(a.status)) - Number(!LIVE_STATUSES.has(b.status));
    if (activeDelta) return activeDelta;
    const aRank = rosterOrder.has(a.id) ? rosterOrder.get(a.id) : 10_000 + (agents.get(a.id)?._sequence ?? 0);
    const bRank = rosterOrder.has(b.id) ? rosterOrder.get(b.id) : 10_000 + (agents.get(b.id)?._sequence ?? 0);
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  }

  function touchPrompt(prompt) {
    prompt._version += 1;
    prompt._cache = null;
    markUsageDirty();
  }

  function markAgentDirty(agent) {
    agent._version += 1;
    agent._cache = null;
    markStateDirty();
  }

  function markCoordinatorDirty() {
    coordinator._version += 1;
    coordinator._cache = null;
    markStateDirty();
  }

  function markUsageDirty() {
    usageVersion += 1;
    usageState._cache = null;
    usageState._deltaCache = null;
    markStateDirty();
  }

  function markStateDirty() {
    snapshotDirty = true;
    snapshotCache = null;
    stateVersion += 1;
  }

  function updateDerivedTimer() {
    if (closed || listeners.size === 0) {
      if (derivedTimer) clearTimeout(derivedTimer);
      derivedTimer = null;
      return;
    }
    if (derivedTimer) return;

    const currentNow = now();
    const dueAt = nextDerivedWakeAt(currentNow);
    if (!Number.isFinite(dueAt)) return;
    const delayMs = Math.max(minDerivedDelayMs, dueAt - currentNow);
    derivedTimer = setTimeout(() => {
      derivedTimer = null;
      if (closed || listeners.size === 0) return;
      applyDerivedTransitions();
      updateDerivedTimer();
    }, delayMs);
    derivedTimer.unref?.();
  }

  function applyDerivedTransitions() {
    const currentNow = now();
    let coordinatorChanged = false;
    const derivedCoordinatorStatus = deriveCoordinatorStatus(currentNow);
    if (derivedCoordinatorStatus !== coordinator.status) {
      coordinator.status = derivedCoordinatorStatus;
      if (derivedCoordinatorStatus === 'idle') coordinator.currentTask = undefined;
      markCoordinatorDirty();
      coordinatorChanged = true;
    }

    const changedAgents = [];
    for (const agent of agents.values()) {
      const derived = deriveAgentStatus(agent, currentNow);
      if (
        derived.status !== agent.status
        || derived.currentTask !== agent.currentTask
        || derived.currentTool !== agent.currentTool
      ) {
        agent.status = derived.status;
        agent.currentTask = derived.currentTask;
        agent.currentTool = derived.currentTool;
        markAgentDirty(agent);
        changedAgents.push(agent.id);
      }
    }

    if (coordinatorChanged) emitCoordinator();
    for (const agentId of changedAgents) emitAgent(agentId);
  }

  function nextDerivedWakeAt(currentNow = now()) {
    let next = coordinatorNextDueAt();
    for (const agent of agents.values()) {
      const due = agentNextDueAt(agent);
      if (due < next) next = due;
    }
    if (!Number.isFinite(next)) return Infinity;
    return next <= currentNow ? currentNow + minDerivedDelayMs : next;
  }

  return {
    initializeFromFiles,
    ingestSessionEvent,
    ingestFileEvent,
    applyLiveUsageMetrics,
    setBackfillProgress,
    refresh,
    getSnapshot,
    subscribe,
    setNote,
    close,
  };
}

function usageFromAssistantData(data) {
  const usage = createUsageTotals();
  usage.inputTokens = finiteInteger(data?.inputTokens);
  usage.outputTokens = finiteInteger(data?.outputTokens);
  usage.cacheReadTokens = finiteInteger(data?.cacheReadTokens);
  usage.cacheWriteTokens = finiteInteger(data?.cacheWriteTokens);
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  usage.nanoAiu = finiteNumber(data?.copilotUsage?.totalNanoAiu);
  usage.requests = 1;
  return usage;
}

function createUsageTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedTokens: 0,
    nanoAiu: 0,
    premiumRequests: 0,
    requests: 0,
  };
}

function cloneUsageTotals(usage) {
  const estimatedTokens = usage.estimatedTokens || 0;
  return stripUndefined({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    estimatedTokens: estimatedTokens || undefined,
    nanoAiu: usage.nanoAiu,
    premiumRequests: usage.premiumRequests || 0,
    requests: usage.requests,
    estimated: estimatedTokens > 0 || undefined,
  });
}

function diffUsageTotals(next, previous) {
  return {
    inputTokens: Math.max(0, next.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, next.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, next.cacheWriteTokens - previous.cacheWriteTokens),
    totalTokens: Math.max(0, next.totalTokens - previous.totalTokens),
    estimatedTokens: Math.max(0, (next.estimatedTokens || 0) - (previous.estimatedTokens || 0)),
    nanoAiu: Math.max(0, next.nanoAiu - previous.nanoAiu),
    premiumRequests: Math.max(0, (next.premiumRequests || 0) - (previous.premiumRequests || 0)),
    requests: Math.max(0, next.requests - previous.requests),
  };
}

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens || 0;
  target.outputTokens += delta.outputTokens || 0;
  target.cacheReadTokens += delta.cacheReadTokens || 0;
  target.cacheWriteTokens += delta.cacheWriteTokens || 0;
  target.totalTokens += delta.totalTokens || 0;
  target.estimatedTokens += delta.estimatedTokens || 0;
  target.nanoAiu += delta.nanoAiu || 0;
  target.premiumRequests += delta.premiumRequests || 0;
  target.requests += delta.requests || 0;
}

function subtractUsage(target, delta) {
  target.inputTokens = Math.max(0, target.inputTokens - (delta.inputTokens || 0));
  target.outputTokens = Math.max(0, target.outputTokens - (delta.outputTokens || 0));
  target.cacheReadTokens = Math.max(0, target.cacheReadTokens - (delta.cacheReadTokens || 0));
  target.cacheWriteTokens = Math.max(0, target.cacheWriteTokens - (delta.cacheWriteTokens || 0));
  target.totalTokens = Math.max(0, target.totalTokens - (delta.totalTokens || 0));
  target.estimatedTokens = Math.max(0, (target.estimatedTokens || 0) - (delta.estimatedTokens || 0));
  target.nanoAiu = Math.max(0, target.nanoAiu - (delta.nanoAiu || 0));
  target.premiumRequests = Math.max(0, (target.premiumRequests || 0) - (delta.premiumRequests || 0));
  target.requests = Math.max(0, target.requests - (delta.requests || 0));
}

function isZeroUsage(usage) {
  return !usage.inputTokens
    && !usage.outputTokens
    && !usage.cacheReadTokens
    && !usage.cacheWriteTokens
    && !usage.totalTokens
    && !usage.estimatedTokens
    && !usage.nanoAiu
    && !usage.premiumRequests
    && !usage.requests;
}

function addUsageToModelMap(map, model, delta) {
  if (!model) return;
  const usage = map.get(model) || createUsageTotals();
  addUsage(usage, delta);
  map.set(model, usage);
}

function subtractUsageFromModelMap(map, model, delta) {
  if (!model) return;
  const usage = map.get(model);
  if (!usage) return;
  subtractUsage(usage, delta);
  if (isZeroUsage(usage)) map.delete(model);
}

function mergeModelMaps(target, source) {
  for (const [model, usage] of source.entries()) {
    addUsageToModelMap(target, model, usage);
  }
}

function snapshotModelMap(map) {
  const object = {};
  for (const [model, usage] of map.entries()) {
    object[model] = cloneUsageTotals(usage);
  }
  return object;
}

function hasMeaningfulUsage(usage) {
  return Boolean(
    usage.inputTokens
    || usage.outputTokens
    || usage.cacheReadTokens
    || usage.cacheWriteTokens
    || usage.totalTokens
    || usage.estimatedTokens
    || usage.nanoAiu
    || usage.requests,
  );
}

function looksLikeSpawnTool(toolName, rawArguments) {
  if (isTaskTool(toolName)) return true;
  const args = parseArguments(rawArguments);
  return Boolean(args.name && (args.prompt || args.description || args.agent_type));
}

function isTaskTool(toolName) {
  return toolName === 'task' || String(toolName ?? '').endsWith('.task');
}

function parseArguments(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function taskText(description) {
  if (!description) return '';
  const text = String(description).trim();
  const colon = text.indexOf(':');
  return (colon >= 0 ? text.slice(colon + 1) : text).trim();
}

function truncatePromptText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= 120 ? text : text.slice(0, 120);
}

function displayNameForAgent(id, label) {
  const raw = String(label || id || 'Unknown').trim();
  const left = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : raw;
  const normalizedLeft = left
    .replace(/^[^\p{L}\p{N}@]+/u, '')
    .replace(/^@+/, '')
    .trim();
  if (normalizedLeft && normalizeAgentKey(normalizedLeft) !== id) return titleCase(id);
  return normalizedLeft || titleCase(id);
}

function titleCase(value) {
  return String(value || 'Unknown')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compareUsageMagnitude(a, b) {
  return (a.nanoAiu - b.nanoAiu)
    || (a.totalTokens - b.totalTokens)
    || ((a.estimatedTokens || 0) - (b.estimatedTokens || 0))
    || (a.outputTokens - b.outputTokens)
    || (a.inputTokens - b.inputTokens)
    || (a.cacheReadTokens - b.cacheReadTokens)
    || (a.cacheWriteTokens - b.cacheWriteTokens)
    || ((a.premiumRequests || 0) - (b.premiumRequests || 0))
    || (a.requests - b.requests);
}

function countDelta(type) {
  if (type === 'file.created') return 1;
  if (type === 'file.deleted') return -1;
  return 0;
}

function describeFileEvent(fileEvent) {
  const filePath = fileEvent.path || fileEvent.kind || 'squad file';
  const verb = fileEvent.type === 'file.created'
    ? 'created'
    : fileEvent.type === 'file.deleted'
      ? 'deleted'
      : 'changed';
  return `${filePath} ${verb}`;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function finiteIntegerOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function finiteAiuValue(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'bigint') return Number(value > 0n ? value : 0n);
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function applyMonotonicUsageField(target, field, value) {
  const next = field === 'nanoAiu' ? finiteAiuValue(value) : finiteIntegerOrNull(value);
  if (next == null || next <= (target[field] || 0)) return false;
  target[field] = next;
  return true;
}

function metricsByModel(metrics) {
  const result = {};
  if (!metrics || typeof metrics !== 'object') return result;
  const entries = Array.isArray(metrics)
    ? metrics.map((entry) => [entry?.model || entry?.modelName || entry?.name, entry])
    : Object.entries(metrics);
  for (const [model, value] of entries) {
    if (!model || !value || typeof value !== 'object') continue;
    result[model] = {
      requests: value.requests ?? value.requestCount ?? value.totalRequests ?? value.totalUserRequests,
      premiumRequests: value.premiumRequests ?? value.totalPremiumRequests ?? value.totalPremiumRequestCost,
      nanoAiu: value.nanoAiu ?? value.totalNanoAiu,
      inputTokens: value.inputTokens ?? value.totalInputTokens,
      outputTokens: value.outputTokens ?? value.totalOutputTokens,
      cacheReadTokens: value.cacheReadTokens ?? value.totalCacheReadTokens,
      cacheWriteTokens: value.cacheWriteTokens ?? value.totalCacheWriteTokens,
    };
  }
  return result;
}

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function pickNumber(a, b, chooser) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return chooser(a, b);
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function stripInternal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !key.startsWith('_') && entry !== undefined));
}

function readUsdPerAiu(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readProjectUsdPerAiu(projectRoot) {
  if (!projectRoot) return null;
  try {
    const text = readFileSync(`${projectRoot}/.squad/dashboard.json`, 'utf8');
    const parsed = JSON.parse(text);
    return readUsdPerAiu(parsed?.usdPerAiu);
  } catch {
    return null;
  }
}
