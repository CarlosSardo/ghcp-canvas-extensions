const STATUS_LABELS = {
  idle: "Idle",
  spawning: "Spawning",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  thinking: "Thinking",
  running: "Running"
};

const STATUS_ORDER = {
  working: 0,
  spawning: 1,
  waiting: 2,
  failed: 3,
  done: 4,
  idle: 5,
  thinking: 1,
  running: 0
};

const MAX_FEED = 60;
const MAX_PROMPTS = 30;
const MAX_AGENT_PROMPT_CHIPS = 3;
const NANO_PER_AIU = 1e9;
const THEME_KEY = "squad-dashboard.theme";
const DEMO_TICK_MS = 2200;
const TAB_ORDER = ["agents", "prompts", "session", "activity"];

const params = new URLSearchParams(window.location.search);
const isDemo = params.get("demo") === "1";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (reducedMotion) {
  document.documentElement.classList.add("reduced-motion");
}

const elements = {
  title: byId("dashboard-title"),
  projectRoot: byId("project-root"),
  refresh: byId("refresh-button"),
  themeBtn: byId("theme-btn"),
  themeIcon: byId("theme-icon"),
  themeLabel: byId("theme-label"),
  totalsPill: byId("session-totals-pill"),
  totalsText: byId("session-totals-text"),
  coordinatorPill: byId("coordinator-pill"),
  connectionPill: byId("connection-pill"),
  usageHint: byId("usage-hint-pill"),
  backfillPill: byId("backfill-pill"),
  sessionExtra: byId("session-extra-pill"),
  generatedAt: byId("generated-at"),
  emptyState: byId("empty-state"),
  emptyTitle: byId("empty-title"),
  emptyMessage: byId("empty-message"),
  agentsGrid: byId("agents-grid"),
  tabBar: byId("tab-bar"),
  usageAgents: byId("usage-agents"),
  prompts: byId("prompts-list"),
  sessionPartial: byId("session-partial-hint"),
  sessionSummary: byId("session-summary"),
  sessionModels: byId("session-models"),
  activity: byId("activity-feed"),
  announcer: byId("announcer")
};

const countNodes = Object.fromEntries(
  Array.from(document.querySelectorAll("[data-count]"), (node) => [node.dataset.count, node])
);
const panelNodes = Object.fromEntries(
  TAB_ORDER.map((view) => [view, byId(`panel-${view}`)])
);

const state = {
  snapshot: createEmptySnapshot(),
  connectionState: isDemo ? "demo" : "connecting",
  connectionLabel: isDemo ? "Demo mode" : "Connecting",
  source: null,
  reconnectTimer: 0,
  reconnectAttempt: 0,
  renderQueued: false,
  hiddenDirty: false,
  activeView: "agents",
  expandedAgentId: "",
  agentNodes: new Map(),
  usageNodes: new Map(),
  promptNodes: new Map(),
  promptPool: [],
  activityNodes: new Map(),
  activityPool: [],
  modelNodes: new Map(),
  summaryTiles: new Map(),
  liveCards: new Set(),
  ticker: 0,
  demoTimer: 0,
  announcements: [],
  announcementTimer: 0
};

init().catch((error) => {
  setConnection("error", "Load failed");
  announce(`Dashboard failed to load: ${error.message}`);
});

async function init() {
  bindEvents();
  applyTheme(resolveTheme(), false);

  if (isDemo) {
    const snapshot = await fetchJson("/demo-snapshot.json");
    snapshot.meta = { ...(snapshot.meta || {}), source: "demo" };
    applySnapshot(snapshot);
    startDemoTimer();
  } else {
    const snapshot = await fetchJson("/api/snapshot");
    applySnapshot(snapshot);
    connectEvents();
  }

  queueRender();
}

function bindEvents() {
  elements.refresh.addEventListener("click", onRefresh);
  elements.themeBtn.addEventListener("click", () => toggleTheme());
  elements.tabBar.addEventListener("click", onTabClick);
  elements.tabBar.addEventListener("keydown", onTabKeyDown);
  elements.agentsGrid.addEventListener("click", onAgentActivate);
  elements.agentsGrid.addEventListener("keydown", onAgentActivate);
  elements.activity.addEventListener("click", onActivityClick);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide, { passive: true });
  window.addEventListener("pageshow", onPageShow, { passive: true });
  window.addEventListener("scroll", syncTicker, { passive: true });
  window.addEventListener("resize", syncTicker, { passive: true });
}

async function onRefresh() {
  elements.refresh.disabled = true;
  elements.refresh.setAttribute("aria-busy", "true");
  try {
    if (isDemo) {
      simulateDemoTick(true);
      announce("Demo snapshot refreshed");
    } else {
      const snapshot = await fetchJson("/api/refresh", { method: "POST" });
      applySnapshot(snapshot);
      announce("Squad snapshot refreshed");
    }
  } catch (error) {
    setConnection("error", "Refresh failed");
    addSystemActivity("error", `Refresh failed: ${error.message}`);
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.removeAttribute("aria-busy");
  }
}

function onTabClick(event) {
  const button = event.target.closest("[data-view]");
  if (!button) {
    return;
  }
  setActiveView(button.dataset.view, true);
}

function onTabKeyDown(event) {
  const currentIndex = TAB_ORDER.indexOf(state.activeView);
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % TAB_ORDER.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = TAB_ORDER.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  setActiveView(TAB_ORDER[nextIndex], true);
  byId(`tab-${TAB_ORDER[nextIndex]}`)?.focus();
}

function onAgentActivate(event) {
  const root = event.target.closest("[data-agent-id]");
  if (!root) {
    return;
  }
  if (root.dataset.kind === "human") {
    return;
  }
  const key = event.type === "keydown" ? event.key : null;
  if (event.type === "keydown" && key !== "Enter" && key !== " ") {
    return;
  }
  if (event.type === "keydown") {
    event.preventDefault();
  }
  const id = root.dataset.agentId;
  state.expandedAgentId = state.expandedAgentId === id ? "" : id;
  queueRender();
}

function onActivityClick(event) {
  const button = event.target.closest("[data-agent-target]");
  if (!button) {
    return;
  }
  highlightAgent(button.dataset.agentTarget);
}

function onVisibilityChange() {
  document.documentElement.classList.toggle("is-hidden", document.hidden);
  if (document.hidden) {
    stopTicker();
    stopDemoTimer();
    return;
  }
  startDemoTimer();
  if (!isDemo && !state.source && !state.reconnectTimer) {
    connectEvents();
  }
  if (state.hiddenDirty) {
    queueRender();
  } else {
    syncTicker();
  }
}

function onPageHide() {
  closeEvents();
  stopDemoTimer();
  window.clearTimeout(state.reconnectTimer);
  state.reconnectTimer = 0;
}

function onPageShow() {
  startDemoTimer();
  if (!isDemo && !state.source && !document.hidden) {
    connectEvents();
  }
}

function connectEvents() {
  if (document.hidden || isDemo) {
    return;
  }
  closeEvents();
  setConnection(state.snapshot.agents.length ? "reconnecting" : "connecting", state.snapshot.agents.length ? "Reconnecting" : "Connecting");
  const source = new EventSource("/events");
  state.source = source;

  source.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    setConnection("connected", "Connected");
  });

  source.addEventListener("snapshot", (event) => {
    applySnapshot(parseJson(event.data));
    setConnection("connected", "Connected");
  });

  source.addEventListener("delta", (event) => {
    ingestDelta(parseJson(event.data));
    setConnection("connected", "Connected");
  });

  source.addEventListener("heartbeat", () => {
    setConnection("connected", "Connected");
  });

  source.addEventListener("error", (event) => {
    if (event instanceof MessageEvent && typeof event.data === "string" && event.data) {
      const payload = parseJson(event.data);
      if (payload?.message) {
        addSystemActivity("error", payload.message);
      }
      return;
    }
    setConnection("reconnecting", "Reconnecting");
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (isDemo || state.reconnectTimer) {
    return;
  }
  closeEvents();
  state.reconnectAttempt += 1;
  const delay = Math.min(30000, 1000 * 2 ** (state.reconnectAttempt - 1));
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = 0;
    if (!document.hidden) {
      connectEvents();
    }
  }, delay);
}

function closeEvents() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
}

function setConnection(nextState, label) {
  state.connectionState = nextState;
  state.connectionLabel = label;
  queueRender();
}

function applySnapshot(raw) {
  state.snapshot = normalizeSnapshot(raw);
  if (!state.snapshot.agents.some((agent) => agent.id === state.expandedAgentId)) {
    state.expandedAgentId = "";
  }
  queueRender();
}

function ingestDelta(payload) {
  if (!payload) {
    return;
  }
  if (payload.type === "batch" && Array.isArray(payload.items)) {
    payload.items.forEach(applyDeltaRecord);
  } else if (payload.type) {
    applyDeltaRecord(payload);
  } else if (payload.schemaVersion) {
    applySnapshot(payload);
  }
}

function applyDeltaRecord(delta) {
  const snapshot = state.snapshot;
  snapshot.generatedAt = new Date().toISOString();
  switch (delta.type) {
    case "agent.updated":
      upsertAgent(delta.agent);
      break;
    case "activity.added":
      addActivity(delta.item);
      break;
    case "files.changed":
      snapshot.files = { ...snapshot.files, ...(delta.files || {}) };
      break;
    case "usage.updated":
      mergeUsage(delta.usage || {});
      break;
    case "prompt.updated":
      upsertPrompt(delta.prompt);
      break;
    case "coordinator.updated":
      state.snapshot.coordinator = normalizeCoordinator(delta.coordinator, state.snapshot.coordinator);
      break;
    case "meta.updated":
      mergeMeta(delta.meta || {});
      break;
    default:
      return;
  }
  queueRender();
}

function upsertAgent(rawAgent) {
  if (!rawAgent) {
    return;
  }
  const agents = state.snapshot.agents;
  const currentIndex = agents.findIndex((agent) => agent.id === String(rawAgent.id || rawAgent.name || ""));
  const current = currentIndex >= 0 ? agents[currentIndex] : null;
  const next = normalizeAgent(rawAgent, current?.sortIndex ?? agents.length, current);
  if (currentIndex >= 0) {
    agents[currentIndex] = next;
  } else {
    agents.push(next);
  }
}

function addActivity(rawItem) {
  const item = normalizeActivity(rawItem);
  state.snapshot.activity = [item, ...state.snapshot.activity.filter((entry) => entry.id !== item.id)].slice(0, MAX_FEED);
}

function addSystemActivity(level, text) {
  addActivity({
    id: `system-${Date.now()}`,
    timestamp: new Date().toISOString(),
    level,
    text,
    source: "system"
  });
  queueRender();
}

function mergeUsage(rawUsage) {
  const usage = state.snapshot.usage;
  if (rawUsage.session) {
    usage.session = normalizeTotals(rawUsage.session);
  }
  if (rawUsage.sessionNanoAiuAuthoritative !== undefined) {
    usage.sessionNanoAiuAuthoritative = numberOrZero(rawUsage.sessionNanoAiuAuthoritative);
  }
  if (rawUsage.premiumRequests !== undefined) {
    usage.premiumRequests = numberOrZero(rawUsage.premiumRequests);
  }
  if (rawUsage.userRequests !== undefined) {
    usage.userRequests = numberOrZero(rawUsage.userRequests);
  }
  if (rawUsage.byModel) {
    usage.byModel = normalizeUsageMap(rawUsage.byModel);
  }
  if (rawUsage.pricing) {
    usage.pricing = normalizePricing({ ...usage.pricing, ...rawUsage.pricing });
  }
  if (rawUsage.meta) {
    usage.meta = { ...usage.meta, partial: Boolean(rawUsage.meta.partial), liveSince: rawUsage.meta.liveSince || usage.meta.liveSince || "" };
  }
  if (rawUsage.activePrompt) {
    upsertPrompt(rawUsage.activePrompt);
  }
}

function mergeMeta(rawMeta) {
  if (Object.prototype.hasOwnProperty.call(rawMeta, "backfill")) {
    state.snapshot.meta.backfill = normalizeBackfill(rawMeta.backfill);
  } else {
    state.snapshot.meta.backfill = null;
    state.snapshot.meta.eventBackfill = true;
  }
  if (Object.prototype.hasOwnProperty.call(rawMeta, "eventBackfill")) {
    state.snapshot.meta.eventBackfill = Boolean(rawMeta.eventBackfill);
  }
}

function upsertPrompt(rawPrompt) {
  if (!rawPrompt) {
    return;
  }
  const prompt = normalizePrompt(rawPrompt);
  const prompts = state.snapshot.usage.prompts.filter((item) => item.id !== prompt.id);
  prompts.unshift(prompt);
  state.snapshot.usage.prompts = prompts
    .sort((a, b) => (b.index - a.index) || Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, MAX_PROMPTS);
  if (prompt.active) {
    state.snapshot.usage.activePromptId = prompt.id;
  } else if (state.snapshot.usage.activePromptId === prompt.id) {
    state.snapshot.usage.activePromptId = "";
  }
}

function queueRender() {
  if (document.hidden) {
    state.hiddenDirty = true;
    return;
  }
  if (state.renderQueued) {
    return;
  }
  state.renderQueued = true;
  window.requestAnimationFrame(render);
}

function render() {
  state.renderQueued = false;
  state.hiddenDirty = false;
  renderHeader();
  renderAgents();
  renderUsageAgents();
  renderPrompts();
  renderSession();
  renderActivity();
  renderPanels();
  renderEmptyState();
  syncTicker();
}

function renderHeader() {
  const snapshot = state.snapshot;
  const projectName = snapshot.projectRoot ? snapshot.projectRoot.split("/").filter(Boolean).at(-1) : "No project";
  setText(elements.title, snapshot.noSquad ? "No squad found" : projectName || "Squad");
  setText(
    elements.projectRoot,
    snapshot.noSquad ? "No .squad/ found — open with projectPath" : snapshot.projectRoot || "Project path unavailable"
  );
  setText(elements.generatedAt, `Updated ${relativeTime(snapshot.generatedAt)}`);

  elements.coordinatorPill.dataset.status = snapshot.coordinator.status;
  setText(
    elements.coordinatorPill.lastElementChild,
    `Coordinator ${statusLabel(snapshot.coordinator.status).toLowerCase()}`
  );
  elements.connectionPill.dataset.state = state.connectionState;
  setText(elements.connectionPill.lastElementChild, state.connectionLabel);

  const counts = countStatuses(snapshot.agents.filter((agent) => agent.kind !== "human"));
  if (coordinatorIsActive(snapshot.coordinator.status)) {
    counts.working += 1;
  }
  for (const [status, node] of Object.entries(countNodes)) {
    setText(node, counts[status] || 0);
  }

  const usage = snapshot.usage;
  const sessionTotals = usage.session;
  const aiu = authoritativeAiu(usage);
  const totalText = `${formatTokens(visibleUsageTokens(sessionTotals))} tok · ${formatAiu(aiu)}`;
  const usd = formatUsd(aiu, usage.pricing);
  setText(elements.totalsText, usd ? `${totalText} · ${usd}` : totalText);
  elements.totalsPill.title = sessionTooltip(usage);

  elements.usageHint.hidden = !usage.meta.partial;
  elements.usageHint.title = "History before the dashboard started shows tokens only.";
  renderBackfillPill(snapshot.meta.backfill);

  const requestsText = headerRequestParts(usage).join(" · ");
  elements.sessionExtra.hidden = !requestsText;
  setText(elements.sessionExtra, requestsText);
  elements.sessionExtra.title = requestsText ? headerRequestTitle(usage) : "";
}

function renderBackfillPill(backfill) {
  if (!backfill || backfill.state === "done") {
    elements.backfillPill.hidden = true;
    elements.backfillPill.title = "";
    setText(elements.backfillPill, "");
    return;
  }
  elements.backfillPill.hidden = false;
  elements.backfillPill.title = backfill.error || "";
  if (backfill.state === "error") {
    setText(elements.backfillPill, "History unavailable");
    return;
  }
  if (backfill.total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((backfill.processed / backfill.total) * 100)));
    setText(elements.backfillPill, `Loading history… ${pct}%`);
    return;
  }
  setText(elements.backfillPill, `Loading history… ${formatTokens(backfill.processed)} processed`);
}

function renderAgents() {
  const agents = [...state.snapshot.agents].sort(compareAgents);
  const seen = new Set();
  state.liveCards.clear();

  for (const agent of agents) {
    let node = state.agentNodes.get(agent.id);
    if (!node) {
      node = createAgentNode(agent.id);
      state.agentNodes.set(agent.id, node);
    }
    updateAgentNode(node, agent);
    elements.agentsGrid.appendChild(node.root);
    seen.add(agent.id);
    if (agent.kind !== "human" && agent.status === "working") {
      state.liveCards.add(node);
    }
  }

  for (const [id, node] of state.agentNodes) {
    if (seen.has(id)) {
      continue;
    }
    node.root.remove();
    state.agentNodes.delete(id);
  }
}

function createAgentNode(id) {
  const root = make("article", "agent-card");
  root.tabIndex = 0;
  root.setAttribute("role", "button");
  root.dataset.agentId = id;

  const head = make("div", "agent-card__head");
  const badge = make("span", "badge");
  const names = make("div", "agent-card__names");
  const name = make("strong", "agent-card__name");
  const role = make("span", "agent-card__role");
  names.append(name, role);

  const statusWrap = make("div", "agent-card__status");
  const statusChip = make("span", "status-chip");
  const statusDot = make("span", "status-chip__dot");
  const statusText = make("span", "status-chip__text");
  statusChip.append(statusDot, statusText);
  const humanBadge = make("span", "chip chip--human");
  statusWrap.append(statusChip, humanBadge);
  head.append(badge, names, statusWrap);

  const info = make("div", "agent-card__info");
  const task = make("p", "agent-card__task");
  const chips = make("div", "agent-card__chips");
  const tool = make("span", "chip chip--mono");
  const model = make("span", "chip");
  const mode = make("span", "chip");
  chips.append(tool, model, mode);
  info.append(task, chips);

  const meta = make("div", "agent-card__meta");
  const metrics = make("div", "agent-card__metrics");
  const tokens = metricPill("Tokens");
  const aiu = metricPill("AIU");
  const counters = metricPill("Ops");
  metrics.append(tokens.root, aiu.root, counters.root);
  const timing = make("div", "agent-card__timing");
  const elapsed = make("span", "agent-card__elapsed");
  const last = make("span", "agent-card__elapsed");
  timing.append(elapsed, last);
  meta.append(metrics, timing);

  const share = make("div", "share-track");
  const shareFill = make("span", "share-track__fill");
  const shareOverlay = make("span", "share-track__overlay");
  share.append(shareFill, shareOverlay);
  const humanLine = make("p", "agent-card__human-line");

  const detail = make("section", "agent-card__detail");
  detail.id = `agent-detail-${id.replace(/[^a-z0-9_-]/gi, "-")}`;
  root.setAttribute("aria-controls", detail.id);
  const detailGrid = make("div", "detail-grid");
  const total = detailStat("Session total");
  const run = detailStat("Run");
  detailGrid.append(total.root, run.root);
  const detailTask = make("p", "detail-note");
  const detailMeta = make("div", "detail-meta");
  const detailNote = make("p", "detail-note");
  const detailError = make("p", "detail-error");
  const detailModels = make("div", "detail-models");
  detail.append(detailGrid, detailTask, detailMeta, detailNote, detailError, detailModels);

  root.append(head, humanLine, info, meta, share, detail);

  return {
    root,
    badge,
    name,
    role,
    statusText,
    humanBadge,
    elapsed,
    humanLine,
    info,
    task,
    chips,
    tool,
    model,
    mode,
    meta,
    timing,
    tokens,
    aiu,
    counters,
    last,
    share,
    shareFill,
    shareOverlay,
    detail,
    total,
    run,
    detailTask,
    detailMeta,
    detailNote,
    detailError,
    detailModels,
    modelRows: new Map(),
    live: { startedAt: "", lastActivityAt: "" }
  };
}

function updateAgentNode(node, agent) {
  if (agent.kind === "human") {
    updateHumanNode(node, agent);
    return;
  }

  const expanded = state.expandedAgentId === agent.id;
  const usage = agent.usage.total;
  const run = agent.usage.run;
  const sessionTokens = Math.max(1, visibleUsageTokens(state.snapshot.usage.session));
  const sessionAiu = Math.max(1, authoritativeAiu(state.snapshot.usage));
  const tokenShare = percent(visibleUsageTokens(usage), sessionTokens);
  const aiuShare = percent(usage.nanoAiu, sessionAiu);
  const compact = agent.kind === "human" || agent.status === "idle";

  node.root.dataset.status = agent.status;
  node.root.dataset.kind = agent.kind;
  node.root.classList.toggle("is-expanded", expanded);
  node.root.classList.toggle("is-compact", compact);
  node.root.classList.remove("agent-card--human");
  node.root.tabIndex = 0;
  node.root.setAttribute("role", "button");
  node.root.setAttribute("aria-expanded", String(expanded));
  node.root.setAttribute("aria-label", `${agent.name}, ${statusLabel(agent.status)}`);
  node.root.title = agentTitle(agent);

  setText(node.badge, badgeEmoji(agent));
  setText(node.name, agent.name);
  setText(node.role, agent.role || kindLabel(agent.kind));
  setText(node.statusText, statusLabel(agent.status));
  node.statusText.parentElement.hidden = false;
  node.humanBadge.hidden = true;
  node.elapsed.hidden = false;
  node.humanLine.hidden = true;
  updateAgentLiveText(node, agent);
  node.live.startedAt = agent.startedAt;
  node.live.lastActivityAt = agent.lastActivityAt;

  setText(node.task, agent.currentTask || fallbackTask(agent));
  setChip(node.tool, agent.currentTool, "tool:");
  setChip(node.model, agent.model, "");
  setChip(node.mode, agent.mode, "");
  node.chips.hidden = !agent.currentTool && !agent.model && !agent.mode;
  node.info.hidden = compact && !expanded;

  setText(node.tokens.value, formatTokenPair(usage));
  node.tokens.value.classList.toggle("is-estimated", isEstimatedOnly(usage));
  node.tokens.root.title = tokenTooltip(usage);
  setText(node.aiu.value, formatAiu(usage.nanoAiu));
  node.aiu.root.title = formatAiuTooltip(usage.nanoAiu, state.snapshot.usage.pricing);
  setText(node.counters.value, `${agent.counters.toolCalls}·${agent.counters.completedTasks}·${agent.counters.failedTasks}`);
  node.counters.root.title = `Tool calls ${agent.counters.toolCalls}; completed ${agent.counters.completedTasks}; failed ${agent.counters.failedTasks}`;
  setText(node.last, agent.lastActivityAt ? `Last ${relativeTime(agent.lastActivityAt)}` : "No recent activity");

  node.shareFill.style.width = `${tokenShare}%`;
  node.shareOverlay.style.width = `${aiuShare}%`;
  node.share.title = `Share of session · tokens ${tokenShare.toFixed(1)}% · AIU ${aiuShare.toFixed(1)}%`;
  node.share.hidden = compact && !expanded;

  node.meta.hidden = false;
  node.detail.hidden = !expanded;
  setText(node.total.value, `${formatTokenPair(usage)} · ${formatAiu(usage.nanoAiu)}`);
  setText(node.run.value, `${formatTokenPair(run)} · ${formatAiu(run.nanoAiu)}`);
  setText(node.detailTask, agent.currentTask ? `Task: ${agent.currentTask}` : "Task: —");
  node.detailTask.hidden = !expanded;

  replaceMetaChips(node.detailMeta, [
    agent.currentTool ? `Tool ${agent.currentTool}` : "",
    agent.model ? `Model ${agent.model}` : "",
    agent.mode ? `Mode ${agent.mode}` : "",
    agent.usage.estimated ? "Estimated tokens only" : "",
    agent.runtimeAgentId ? `Runtime ${agent.runtimeAgentId}` : ""
  ].filter(Boolean));

  const noteText = [agent.note ? `Note: ${agent.note}` : "", agent.error ? `Error: ${agent.error}` : ""];
  setText(node.detailNote, noteText[0]);
  node.detailNote.hidden = !noteText[0];
  setText(node.detailError, noteText[1]);
  node.detailError.hidden = !noteText[1];
  renderDetailModels(node, agent.usage.byModel);
}

function updateHumanNode(node, agent) {
  const availability = humanAvailability(agent);
  node.root.dataset.status = agent.status;
  node.root.dataset.kind = agent.kind;
  node.root.classList.add("agent-card--human", "is-compact");
  node.root.classList.remove("is-expanded");
  node.root.tabIndex = -1;
  node.root.setAttribute("role", "article");
  node.root.removeAttribute("aria-expanded");
  node.root.setAttribute("aria-label", `${agent.name}, human, ${availability}`);
  node.root.title = `${agent.name}\n${agent.role || "Human"}\n${availability}`;

  setText(node.badge, humanAvatar(agent));
  setText(node.name, agent.name);
  setText(node.role, agent.role || "Human");
  setText(node.humanBadge, "👤 Human");
  node.humanBadge.hidden = false;
  node.statusText.parentElement.hidden = true;
  node.elapsed.hidden = true;
  setText(node.humanLine, availability);
  node.humanLine.hidden = false;
  node.info.hidden = true;
  node.meta.hidden = true;
  node.share.hidden = true;
  node.detail.hidden = true;
}

function renderDetailModels(node, byModel) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].nanoAiu - a[1].nanoAiu || visibleUsageTokens(b[1]) - visibleUsageTokens(a[1]));
  const seen = new Set();
  for (const [name, totals] of entries) {
    let row = node.modelRows.get(name);
    if (!row) {
      row = createDetailModelRow();
      node.modelRows.set(name, row);
    }
    setText(row.name, name);
    setText(row.value, `${formatTokenPair(totals)} · ${formatAiu(totals.nanoAiu)}`);
    node.detailModels.appendChild(row.root);
    seen.add(name);
  }
  for (const [name, row] of node.modelRows) {
    if (seen.has(name)) {
      continue;
    }
    row.root.remove();
    node.modelRows.delete(name);
  }
  node.detailModels.hidden = entries.length === 0;
}

function createDetailModelRow() {
  const root = make("div", "detail-model");
  const name = make("span");
  const value = make("span");
  root.append(name, value);
  return { root, name, value };
}

function renderUsageAgents() {
  const rows = usageRows();
  const basis = usageShareBasis(rows.map((row) => row.usage));
  rows.sort((a, b) => usageBasisValue(b.usage, basis) - usageBasisValue(a.usage, basis));
  const sessionTokens = Math.max(
    1,
    visibleUsageTokens(state.snapshot.usage.session),
    rows.reduce((sum, row) => sum + visibleUsageTokens(row.usage), 0)
  );
  const sessionAiu = Math.max(1, authoritativeAiu(state.snapshot.usage));
  const seen = new Set();
  elements.usageAgents.dataset.basisLabel = basis === "aiu" ? "Ranked by AIU" : "Ranked by tokens (incl. estimates)";

  rows.forEach((rowData, index) => {
    let node = state.usageNodes.get(rowData.id);
    if (!node) {
      node = createUsageRow();
      state.usageNodes.set(rowData.id, node);
    }
    const share = usageShare(rowData.usage, { sessionTokens, sessionAiu, basis });
    setText(node.rank, index + 1);
    setText(node.name, rowData.name);
    setText(node.sub, rowData.sub);
    setText(node.meta, `${formatTokenPair(rowData.usage)} · ${formatAiu(rowData.usage.nanoAiu)} · ${share.percent.toFixed(1)}%`);
    node.bar.style.width = `${share.percent}%`;
    node.root.title = `${rowData.name}\n${tokenTooltip(rowData.usage)}\n${formatAiuTooltip(rowData.usage.nanoAiu, state.snapshot.usage.pricing)}\n${basis === "aiu" ? "share of AIU" : "share of tokens (incl. estimates)"}`;
    elements.usageAgents.appendChild(node.root);
    seen.add(rowData.id);
  });

  for (const [id, node] of state.usageNodes) {
    if (seen.has(id)) {
      continue;
    }
    node.root.remove();
    state.usageNodes.delete(id);
  }
}

function createUsageRow() {
  const root = make("li", "usage-row");
  const head = make("div", "usage-row__head");
  const rank = make("span", "usage-row__rank");
  const identity = make("div", "usage-row__identity");
  const name = make("strong", "usage-row__name");
  const sub = make("span", "usage-row__sub");
  identity.append(name, sub);
  const meta = make("div", "usage-row__meta");
  head.append(rank, identity, meta);
  const barWrap = make("div", "usage-row__bar");
  const bar = make("span");
  barWrap.append(bar);
  root.append(head, barWrap);
  return { root, rank, name, sub, meta, bar };
}

function renderPrompts() {
  const prompts = [...state.snapshot.usage.prompts].slice(0, MAX_PROMPTS);
  const basis = usageShareBasis(prompts.map((prompt) => prompt.totals));
  prompts.sort((a, b) => usageBasisValue(b.totals, basis) - usageBasisValue(a.totals, basis) || (b.index - a.index) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const sessionAiu = Math.max(1, authoritativeAiu(state.snapshot.usage));
  const sessionTokens = Math.max(1, visibleUsageTokens(state.snapshot.usage.session), prompts.reduce((sum, prompt) => sum + visibleUsageTokens(prompt.totals), 0));
  const seen = new Set();
  elements.prompts.dataset.basisLabel = basis === "aiu" ? "Ranked by AIU" : "Ranked by tokens (incl. estimates)";

  for (const prompt of prompts) {
    let node = state.promptNodes.get(prompt.id);
    if (!node) {
      node = state.promptPool.pop() || createPromptRow();
      state.promptNodes.set(prompt.id, node);
    }
    const active = prompt.active || state.snapshot.usage.activePromptId === prompt.id;
    node.root.classList.toggle("is-active", active);
    setText(node.title, prompt.text || "Before first prompt");
    setText(node.sub, `${promptDuration(prompt)} · ${formatTokenPair(prompt.totals)} · ${formatAiu(prompt.totals.nanoAiu)}`);
    setText(node.meta, topPromptAgents(prompt));
    node.bar.style.width = `${usageShare(prompt.totals, { sessionTokens, sessionAiu, basis }).percent}%`;
    node.root.title = `${prompt.text}\n${tokenTooltip(prompt.totals)}\n${formatAiuTooltip(prompt.totals.nanoAiu, state.snapshot.usage.pricing)}`;
    replacePromptChips(node.chips, prompt.byAgent);
    elements.prompts.appendChild(node.root);
    seen.add(prompt.id);
  }

  for (const [id, node] of state.promptNodes) {
    if (seen.has(id)) {
      continue;
    }
    node.root.remove();
    state.promptNodes.delete(id);
    state.promptPool.push(node);
  }
}

function createPromptRow() {
  const root = make("li", "prompt-row");
  const head = make("div", "prompt-row__head");
  const text = make("div", "prompt-row__text");
  const title = make("strong");
  const sub = make("span", "prompt-row__sub");
  text.append(title, sub);
  const meta = make("div", "prompt-row__meta");
  const chips = make("div", "prompt-row__chips");
  head.append(text, meta);
  const barWrap = make("div", "prompt-row__bar");
  const bar = make("span");
  barWrap.append(bar);
  root.append(head, chips, barWrap);
  return { root, title, sub, meta, chips, bar };
}

function replacePromptChips(container, byAgent) {
  const top = Object.entries(byAgent)
    .sort((a, b) => b[1].nanoAiu - a[1].nanoAiu || visibleUsageTokens(b[1]) - visibleUsageTokens(a[1]))
    .slice(0, MAX_AGENT_PROMPT_CHIPS)
    .map(([id]) => lookupAgentName(id));
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  top.forEach((label) => {
    const chip = make("span", "chip");
    setText(chip, label);
    container.appendChild(chip);
  });
}

function renderSession() {
  const usage = state.snapshot.usage;
  const aiu = authoritativeAiu(usage);
  const summaryData = [
    ["input", "Input", formatTokens(usage.session.inputTokens)],
    ["output", "Output", formatTokens(usage.session.outputTokens)],
    ["estimated", "Estimated", formatTokens(usage.session.estimatedTokens)],
    ["cache-read", "Cache read", formatTokens(usage.session.cacheReadTokens)],
    ["cache-write", "Cache write", formatTokens(usage.session.cacheWriteTokens)],
    ["aiu", "AIU", formatAiu(aiu)],
    ["requests", "Requests", usage.session.requests],
    ["premium", "Premium", usage.premiumRequests]
  ];

  for (const [key, label, value] of summaryData) {
    if (!state.summaryTiles.has(key)) {
      state.summaryTiles.set(key, createSummaryTile(label));
    }
    const tile = state.summaryTiles.get(key);
    setText(tile.value, value ?? 0);
    elements.sessionSummary.appendChild(tile.root);
  }

  elements.sessionPartial.hidden = !usage.meta.partial;
  renderModelRows(usage.byModel);
}

function createSummaryTile(label) {
  const root = make("div", "summary-tile");
  const labelNode = make("span", "detail-label");
  const value = make("strong");
  setText(labelNode, label);
  root.append(labelNode, value);
  return { root, value };
}

function renderModelRows(byModel) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].nanoAiu - a[1].nanoAiu || visibleUsageTokens(b[1]) - visibleUsageTokens(a[1]));
  const maxAiu = Math.max(1, ...entries.map(([, totals]) => totals.nanoAiu));
  const seen = new Set();

  for (const [model, totals] of entries) {
    let node = state.modelNodes.get(model);
    if (!node) {
      node = createModelRow();
      state.modelNodes.set(model, node);
    }
    setText(node.name, model);
    setText(node.value, `${formatTokenPair(totals)} · ${formatAiu(totals.nanoAiu)}`);
    node.bar.style.width = `${percent(totals.nanoAiu, maxAiu)}%`;
    node.root.title = `${model}\n${tokenTooltip(totals)}\n${formatAiuTooltip(totals.nanoAiu, state.snapshot.usage.pricing)}`;
    elements.sessionModels.appendChild(node.root);
    seen.add(model);
  }

  for (const [model, node] of state.modelNodes) {
    if (seen.has(model)) {
      continue;
    }
    node.root.remove();
    state.modelNodes.delete(model);
  }
}

function createModelRow() {
  const root = make("div", "model-row");
  const copy = make("div", "model-row__copy");
  const name = make("strong");
  const value = make("span", "prompt-row__sub");
  copy.append(name, value);
  const barWrap = make("div", "model-row__bar");
  const bar = make("span");
  barWrap.append(bar);
  root.append(copy, barWrap);
  return { root, name, value, bar };
}

function renderActivity() {
  const items = [...state.snapshot.activity]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_FEED);
  const seen = new Set();

  for (const item of items) {
    let node = state.activityNodes.get(item.id);
    if (!node) {
      node = state.activityPool.pop() || createActivityRow();
      state.activityNodes.set(item.id, node);
    }
    node.root.dataset.level = item.level;
    setText(node.time, relativeTime(item.timestamp));
    node.time.dateTime = item.timestamp;
    setText(node.source, item.source);
    setText(node.text, item.text);
    if (item.agentId) {
      node.agent.hidden = false;
      node.agent.dataset.agentTarget = item.agentId;
      setText(node.agent, lookupAgentName(item.agentId));
    } else {
      node.agent.hidden = true;
      node.agent.dataset.agentTarget = "";
      setText(node.agent, "");
    }
    elements.activity.appendChild(node.root);
    seen.add(item.id);
  }

  for (const [id, node] of state.activityNodes) {
    if (seen.has(id)) {
      continue;
    }
    node.root.remove();
    state.activityNodes.delete(id);
    state.activityPool.push(node);
  }
}

function createActivityRow() {
  const root = make("li", "activity-item");
  const meta = make("div", "activity-meta");
  const time = make("time");
  const source = make("span");
  meta.append(time, source);
  const agent = make("button", "activity-link");
  agent.type = "button";
  agent.hidden = true;
  const text = make("p");
  root.append(meta, agent, text);
  return { root, time, source, agent, text };
}

function renderPanels() {
  TAB_ORDER.forEach((view) => {
    const active = state.activeView === view;
    const tab = byId(`tab-${view}`);
    tab?.setAttribute("aria-selected", String(active));
    tab?.setAttribute("tabindex", active ? "0" : "-1");
    panelNodes[view].hidden = !active;
  });
}

function renderEmptyState() {
  if (state.snapshot.noSquad) {
    elements.emptyState.hidden = false;
    setText(elements.emptyTitle, "No .squad/ found");
    setText(elements.emptyMessage, "Open this canvas with projectPath to point at a Squad project.");
    return;
  }
  const nonHumanAgents = state.snapshot.agents.filter((agent) => agent.kind !== "human");
  const hasSubagentWork = nonHumanAgents.some((agent) => ["working", "waiting", "spawning", "failed"].includes(agent.status));
  const coordinatorActive = coordinatorIsActive(state.snapshot.coordinator.status);
  elements.emptyState.hidden = hasSubagentWork;

  if (coordinatorActive) {
    setText(elements.emptyTitle, "Coordinator is working…");
    setText(elements.emptyMessage, "No sub-agent is active right now, but the coordinator is still processing.");
    return;
  }

  setText(elements.emptyTitle, "All quiet");
  setText(elements.emptyMessage, nonHumanAgents.length ? "No one is actively working right now." : "No agents are active yet.");
}

function setActiveView(view, announceSelection = false) {
  if (!TAB_ORDER.includes(view)) {
    return;
  }
  state.activeView = view;
  if (announceSelection) {
    announce(`${titleCase(view)} view`);
  }
  queueRender();
}

function highlightAgent(id) {
  const node = state.agentNodes.get(id);
  if (!node) {
    return;
  }
  state.expandedAgentId = id;
  queueRender();
  node.root.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  node.root.focus({ preventScroll: true });
}

function syncTicker() {
  if (document.hidden) {
    stopTicker();
    return;
  }
  const hasVisibleWorking = Array.from(state.liveCards).some((node) => isVisible(node.root));
  if (!hasVisibleWorking) {
    stopTicker();
    return;
  }
  if (!state.ticker) {
    state.ticker = window.setInterval(tickLiveCards, 1000);
  }
}

function stopTicker() {
  if (!state.ticker) {
    return;
  }
  window.clearInterval(state.ticker);
  state.ticker = 0;
}

function tickLiveCards() {
  if (document.hidden) {
    stopTicker();
    return;
  }
  let visibleCount = 0;
  for (const node of state.liveCards) {
    if (!isVisible(node.root)) {
      continue;
    }
    visibleCount += 1;
    const id = node.root.dataset.agentId;
    const agent = state.snapshot.agents.find((entry) => entry.id === id);
    if (agent) {
      updateAgentLiveText(node, agent);
    }
  }
  if (!visibleCount) {
    stopTicker();
  }
}

function updateAgentLiveText(node, agent) {
  setText(node.elapsed, agent.startedAt ? `Elapsed ${elapsedText(agent.startedAt)}` : "Elapsed —");
  setText(node.last, agent.lastActivityAt ? `Last ${relativeTime(agent.lastActivityAt)}` : "No recent activity");
}

function simulateDemoTick(force = false) {
  if (document.hidden) {
    return;
  }
  const snapshot = state.snapshot;
  const workers = snapshot.agents.filter((agent) => agent.kind !== "human");
  if (!workers.length) {
    return;
  }
  const active = workers.filter((agent) => agent.status === "working");
  const pool = active.length ? active : workers.slice(0, 3);
  const touched = pool.slice(0, Math.min(pool.length, 3));
  const now = new Date().toISOString();

  touched.forEach((agent, index) => {
    const bump = randomUsage(index + 1);
    agent.lastActivityAt = now;
    if (force || Math.random() > 0.18) {
      agent.status = "working";
      agent.currentTask = demoTask(agent.name, index);
      agent.currentTool = demoTool(index);
      if (!agent.startedAt || agent.status !== "working") {
        agent.startedAt = now;
      }
      agent.counters.toolCalls += 1;
    } else if (Math.random() > 0.5) {
      agent.status = "waiting";
      agent.currentTool = "";
    } else {
      agent.status = "done";
      agent.currentTool = "";
      agent.counters.completedTasks += 1;
    }
    addUsage(agent.usage.total, bump);
    addUsage(agent.usage.run, bump);
    const modelKey = agent.model || "auto";
    addUsage(agent.usage.byModel[modelKey] || (agent.usage.byModel[modelKey] = normalizeTotals({})), bump);
    addUsage(snapshot.usage.session, bump);
    addUsage(snapshot.usage.byModel[modelKey] || (snapshot.usage.byModel[modelKey] = normalizeTotals({})), bump);
  });

  const prompt = snapshot.usage.prompts[0];
  if (prompt) {
    prompt.active = true;
    snapshot.usage.activePromptId = prompt.id;
    prompt.endedAt = "";
    prompt.totals.requests += 1;
    touched.forEach((agent, index) => {
      const bump = randomUsage(index + 2);
      addUsage(prompt.totals, bump);
      const slot = prompt.byAgent[agent.id] || (prompt.byAgent[agent.id] = normalizeTotals({}));
      addUsage(slot, bump);
    });
  }

  snapshot.coordinator.status = Math.random() > 0.35 ? "thinking" : "idle";
  snapshot.generatedAt = now;
  addActivity({
    id: `demo-${Date.now()}`,
    timestamp: now,
    agentId: touched[0]?.id,
    level: "info",
    text: touched[0] ? `${touched[0].name} running ${touched[0].currentTool || "review"}` : "Coordinator updated usage",
    source: "session"
  });
  queueRender();
}

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.totalTokens += delta.totalTokens;
  target.estimatedTokens += delta.estimatedTokens || 0;
  target.nanoAiu += delta.nanoAiu;
  target.premiumRequests += delta.premiumRequests || 0;
  target.requests += delta.requests;
}

function randomUsage(multiplier) {
  const inputTokens = (400 + Math.round(Math.random() * 500)) * multiplier;
  const outputTokens = (180 + Math.round(Math.random() * 260)) * multiplier;
  const cacheReadTokens = Math.round(Math.random() * 250) * multiplier;
  const nanoAiu = Math.round((inputTokens * 180000 + outputTokens * 320000 + cacheReadTokens * 60000) * (1 + Math.random() * 0.12));
  return normalizeTotals({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens,
    nanoAiu,
    requests: 1
  });
}

function startDemoTimer() {
  if (!isDemo || document.hidden || state.demoTimer) {
    return;
  }
  state.demoTimer = window.setInterval(simulateDemoTick, DEMO_TICK_MS);
}

function stopDemoTimer() {
  if (!state.demoTimer) {
    return;
  }
  window.clearInterval(state.demoTimer);
  state.demoTimer = 0;
}

function demoTask(name, index) {
  const tasks = [
    "Compacting agent cards",
    "Folding prompt usage by model",
    "Tuning the activity rail",
    "Checking batch SSE coalescing",
    "Verifying theme contrast",
    "Reviewing session totals"
  ];
  return tasks[(name.length + index) % tasks.length];
}

function demoTool(index) {
  return ["edit", "rg", "node --check", "view", "apply_patch", "refresh"][index % 6];
}

function usageRows() {
  const rows = state.snapshot.agents
    .filter((agent) => agent.kind !== "human" && (visibleUsageTokens(agent.usage.total) || agent.usage.total.nanoAiu))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      sub: `${statusLabel(agent.status)} · ${agent.model || agent.mode || "—"}`,
      usage: agent.usage.total
    }));
  if (visibleUsageTokens(state.snapshot.coordinator.usage) || state.snapshot.coordinator.usage.nanoAiu) {
    rows.unshift({
      id: "coordinator",
      name: "Coordinator",
      sub: `${statusLabel(state.snapshot.coordinator.status)} · ${state.snapshot.coordinator.model || "—"}`,
      usage: state.snapshot.coordinator.usage
    });
  }
  return rows;
}

function countStatuses(agents) {
  return agents.reduce(
    (counts, agent) => {
      if (counts[agent.status] !== undefined) {
        counts[agent.status] += 1;
      }
      return counts;
    },
    { working: 0, waiting: 0, idle: 0, done: 0, failed: 0 }
  );
}

function coordinatorIsActive(status) {
  return ["thinking", "working", "running", "spawning", "waiting"].includes(status);
}

function compareAgents(left, right) {
  const delta = (STATUS_ORDER[left.status] ?? 99) - (STATUS_ORDER[right.status] ?? 99);
  if (delta) {
    return delta;
  }
  if (left.kind === "human" && right.kind !== "human") {
    return 1;
  }
  if (right.kind === "human" && left.kind !== "human") {
    return -1;
  }
  return left.sortIndex - right.sortIndex || left.name.localeCompare(right.name);
}

function createEmptySnapshot() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectRoot: null,
    noSquad: false,
    coordinator: { status: "idle", currentTask: "", model: "", lastActivityAt: "", usage: normalizeTotals({}) },
    agents: [],
    activity: [],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0, lastFileActivityAt: "" },
    usage: normalizeUsage({}),
    meta: { source: isDemo ? "demo" : "live", eventBackfill: false, errors: [] }
  };
}

function normalizeSnapshot(raw) {
  const empty = createEmptySnapshot();
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    schemaVersion: 1,
    generatedAt: safe.generatedAt || empty.generatedAt,
    projectRoot: safe.projectRoot || null,
    noSquad: Boolean(safe.noSquad),
    coordinator: normalizeCoordinator(safe.coordinator, empty.coordinator),
    agents: Array.isArray(safe.agents) ? safe.agents.map((agent, index) => normalizeAgent(agent, index)) : [],
    activity: Array.isArray(safe.activity) ? safe.activity.map(normalizeActivity).slice(0, MAX_FEED) : [],
    files: {
      decisionsInboxCount: numberOrZero(safe.files?.decisionsInboxCount),
      orchestrationLogCount: numberOrZero(safe.files?.orchestrationLogCount),
      logCount: numberOrZero(safe.files?.logCount),
      lastFileActivityAt: safe.files?.lastFileActivityAt || ""
    },
    usage: normalizeUsage(safe.usage || {}),
    meta: {
      source: safe.meta?.source === "demo" ? "demo" : "live",
      eventBackfill: Boolean(safe.meta?.eventBackfill),
      errors: Array.isArray(safe.meta?.errors) ? safe.meta.errors : [],
      backfill: normalizeBackfill(safe.meta?.backfill)
    }
  };
}

function normalizeCoordinator(raw, current = {}) {
  return {
    status: STATUS_LABELS[raw?.status] ? raw.status : current.status || "idle",
    currentTask: readString(raw, "currentTask", current.currentTask || ""),
    model: readString(raw, "model", current.model || ""),
    lastActivityAt: readString(raw, "lastActivityAt", current.lastActivityAt || ""),
    usage: normalizeTotals(raw?.usage || current.usage || {})
  };
}

function normalizeAgent(raw, sortIndex, current = {}) {
  current = current || {};
  const counters = raw?.counters || current.counters || {};
  return {
    id: valueOr(raw?.id, raw?.name, current.id, "unknown"),
    name: valueOr(raw?.name, current.name, "Unknown agent"),
    role: readString(raw, "role", current.role || ""),
    badge: readString(raw, "badge", current.badge || ""),
    roster: raw?.roster !== undefined ? Boolean(raw.roster) : Boolean(current.roster),
    kind: ["member", "coding", "human", "unknown"].includes(raw?.kind) ? raw.kind : current.kind || "unknown",
    status: STATUS_LABELS[raw?.status] ? raw.status : current.status || "idle",
    currentTask: readString(raw, "currentTask", current.currentTask || ""),
    currentTool: readString(raw, "currentTool", current.currentTool || ""),
    model: readString(raw, "model", current.model || ""),
    mode: readString(raw, "mode", current.mode || ""),
    note: readString(raw, "note", current.note || ""),
    runtimeAgentId: readString(raw, "runtimeAgentId", current.runtimeAgentId || ""),
    taskToolCallId: readString(raw, "taskToolCallId", current.taskToolCallId || ""),
    startedAt: readString(raw, "startedAt", current.startedAt || ""),
    lastActivityAt: readString(raw, "lastActivityAt", current.lastActivityAt || ""),
    error: readString(raw, "error", current.error || ""),
    sortIndex: current.sortIndex ?? sortIndex,
    counters: {
      toolCalls: numberOrZero(counters.toolCalls),
      completedTasks: numberOrZero(counters.completedTasks),
      failedTasks: numberOrZero(counters.failedTasks)
    },
    usage: raw?.usage !== undefined ? normalizeAgentUsage(raw.usage) : current.usage || normalizeAgentUsage({})
  };
}

function normalizeAgentUsage(raw) {
  return {
    total: normalizeTotals(raw?.total || raw || {}),
    run: normalizeTotals(raw?.run || {}),
    byModel: normalizeUsageMap(raw?.byModel || {}),
    estimated: Boolean(raw?.estimated)
  };
}

function normalizeUsage(raw) {
  const pricing = normalizePricing(raw?.pricing || {});
  const usage = {
    session: normalizeTotals(raw?.session || {}),
    sessionNanoAiuAuthoritative: raw?.sessionNanoAiuAuthoritative !== undefined ? numberOrZero(raw.sessionNanoAiuAuthoritative) : undefined,
    premiumRequests: raw?.premiumRequests !== undefined ? numberOrZero(raw.premiumRequests) : 0,
    userRequests: raw?.userRequests !== undefined ? numberOrZero(raw.userRequests) : 0,
    byModel: normalizeUsageMap(raw?.byModel || {}),
    prompts: Array.isArray(raw?.prompts) ? raw.prompts.map(normalizePrompt).slice(0, MAX_PROMPTS) : [],
    activePromptId: raw?.activePromptId || "",
    pricing,
    meta: {
      liveSince: raw?.meta?.liveSince || "",
      partial: Boolean(raw?.meta?.partial)
    }
  };
  usage.prompts.forEach((prompt) => {
    if (prompt.active) {
      usage.activePromptId = prompt.id;
    }
  });
  return usage;
}

function normalizePrompt(raw) {
  return {
    id: valueOr(raw?.id, `prompt-${Math.random().toString(16).slice(2)}`),
    index: numberOrZero(raw?.index),
    startedAt: raw?.startedAt || new Date().toISOString(),
    endedAt: raw?.endedAt || "",
    text: String(raw?.text || "Before first prompt").slice(0, 120),
    active: Boolean(raw?.active),
    totals: normalizeTotals(raw?.totals || {}),
    byAgent: normalizeUsageMap(raw?.byAgent || {})
  };
}

function normalizeUsageMap(raw) {
  const result = {};
  if (!raw || typeof raw !== "object") {
    return result;
  }
  for (const [key, value] of Object.entries(raw)) {
    result[key] = normalizeTotals(value || {});
  }
  return result;
}

function normalizePricing(raw) {
  const usdPerUnit = Number(raw?.usdPerUnit);
  return {
    unitLabel: raw?.unitLabel || "AIU",
    nanoPerUnit: numberOrZero(raw?.nanoPerUnit || NANO_PER_AIU) || NANO_PER_AIU,
    usdPerUnit: Number.isFinite(usdPerUnit) ? usdPerUnit : undefined
  };
}

function normalizeTotals(raw) {
  const inputTokens = numberOrZero(raw?.inputTokens);
  const outputTokens = numberOrZero(raw?.outputTokens);
  const cacheReadTokens = numberOrZero(raw?.cacheReadTokens);
  const cacheWriteTokens = numberOrZero(raw?.cacheWriteTokens);
  const estimatedTokens = numberOrZero(raw?.estimatedTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: raw?.totalTokens !== undefined ? numberOrZero(raw.totalTokens) : inputTokens + outputTokens,
    estimatedTokens,
    nanoAiu: numberOrZero(raw?.nanoAiu),
    premiumRequests: numberOrZero(raw?.premiumRequests),
    requests: numberOrZero(raw?.requests)
  };
}

function normalizeBackfill(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const stateValue = ["pending", "running", "done", "error"].includes(raw.state) ? raw.state : "done";
  if (stateValue === "done") {
    return null;
  }
  return {
    state: stateValue,
    processed: numberOrZero(raw.processed),
    total: raw.total === undefined || raw.total === null ? 0 : numberOrZero(raw.total),
    error: raw.error ? String(raw.error) : "",
    updatedAt: raw.updatedAt || ""
  };
}

function normalizeActivity(raw) {
  return {
    id: valueOr(raw?.id, `evt-${Math.random().toString(16).slice(2)}`),
    timestamp: raw?.timestamp || new Date().toISOString(),
    agentId: raw?.agentId || "",
    level: ["info", "success", "warning", "error"].includes(raw?.level) ? raw.level : "info",
    text: String(raw?.text || ""),
    source: ["session", "file", "system"].includes(raw?.source) ? raw.source : "system"
  };
}

function authoritativeAiu(usage) {
  return Math.max(numberOrZero(usage.session.nanoAiu), numberOrZero(usage.sessionNanoAiuAuthoritative));
}

function percent(value, total) {
  return total > 0 ? Math.min(100, (value / total) * 100) : 0;
}

function visibleUsageTokens(totals) {
  return numberOrZero(totals?.totalTokens) + numberOrZero(totals?.estimatedTokens);
}

function isEstimatedOnly(totals) {
  return !numberOrZero(totals?.inputTokens) && !numberOrZero(totals?.outputTokens) && numberOrZero(totals?.estimatedTokens) > 0;
}

function usageShareBasis(items) {
  return items.length > 0 && items.every((totals) => numberOrZero(totals?.nanoAiu) > 0) ? "aiu" : "tokens";
}

function usageBasisValue(totals, basis) {
  return basis === "aiu" ? numberOrZero(totals?.nanoAiu) : visibleUsageTokens(totals);
}

function usageShare(totals, { sessionTokens, sessionAiu, basis }) {
  return {
    percent: basis === "aiu"
      ? percent(numberOrZero(totals.nanoAiu), sessionAiu)
      : percent(visibleUsageTokens(totals), sessionTokens)
  };
}

function headerRequestParts(usage) {
  return [
    usage.premiumRequests ? `${usage.premiumRequests} premium req` : "",
    usage.userRequests ? `${usage.userRequests} prompts` : "",
    usage.session.requests ? `${usage.session.requests} calls since dashboard start` : ""
  ].filter(Boolean);
}

function headerRequestTitle(usage) {
  return [
    usage.premiumRequests ? `${usage.premiumRequests} premium req: session-wide premium request units (from Copilot usage metrics)` : "",
    usage.userRequests ? `${usage.userRequests} prompts from Copilot usage metrics` : "",
    usage.session.requests ? `${usage.session.requests} model calls observed since the dashboard started` : ""
  ].filter(Boolean).join("; ");
}

function promptDuration(prompt) {
  return elapsedText(prompt.startedAt, prompt.endedAt || Date.now());
}

function tokenTooltip(totals) {
  const base = `Input ${formatTokens(totals.inputTokens)} · Output ${formatTokens(totals.outputTokens)} · Cache read ${formatTokens(totals.cacheReadTokens)} · Cache write ${formatTokens(totals.cacheWriteTokens)}`;
  return isEstimatedOnly(totals)
    ? `${base}\nestimated from sub-agent completion totals; no in/out split`
    : base;
}

function sessionTooltip(usage) {
  const totals = usage.session;
  const base = `${formatTokens(visibleUsageTokens(totals))} visible tokens · ${formatAiu(authoritativeAiu(usage))}`;
  const usd = formatUsd(authoritativeAiu(usage), usage.pricing);
  return `${base}${usd ? ` · ${usd}` : ""}\n${tokenTooltip(totals)}`;
}

function formatAiuTooltip(nanoAiu, pricing) {
  const base = formatAiu(nanoAiu);
  const usd = formatUsd(nanoAiu, pricing);
  return usd ? `${base} · ${usd}` : base;
}

function formatTokenPair(totals) {
  if (isEstimatedOnly(totals)) {
    return `≈${formatTokens(totals.estimatedTokens)} tok · est.`;
  }
  return `${formatTokens(totals.inputTokens)}↑ ${formatTokens(totals.outputTokens)}↓`;
}

function formatTokens(value) {
  const amount = numberOrZero(value);
  if (amount >= 1000000) {
    return `${(amount / 1000000).toFixed(amount >= 10000000 ? 0 : 1)}m`;
  }
  if (amount >= 1000) {
    return `${(amount / 1000).toFixed(amount >= 100000 ? 0 : 1)}k`;
  }
  return String(amount);
}

function formatAiu(nanoAiu) {
  const amount = numberOrZero(nanoAiu) / NANO_PER_AIU;
  if (!amount) {
    return "0 AIU";
  }
  const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : amount >= 1 ? 2 : 3;
  return `${amount.toFixed(digits)} AIU`;
}

function formatUsd(nanoAiu, pricing) {
  if (!pricing || typeof pricing.usdPerUnit !== "number") {
    return "";
  }
  const usd = (numberOrZero(nanoAiu) / (pricing.nanoPerUnit || NANO_PER_AIU)) * pricing.usdPerUnit;
  const digits = usd >= 10 ? 1 : usd >= 1 ? 2 : 3;
  return `≈$${usd.toFixed(digits)}`;
}

function elapsedText(startValue, endValue = Date.now()) {
  const start = Date.parse(startValue);
  const end = typeof endValue === "string" ? Date.parse(endValue) : Number(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "—";
  }
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes) {
    return `${minutes}m ${remaining}s`;
  }
  return `${remaining}s`;
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "just now";
  }
  const diff = Date.now() - timestamp;
  const abs = Math.abs(diff);
  const units = [
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
    ["second", 1000]
  ];
  for (const [unit, size] of units) {
    if (abs >= size || unit === "second") {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-Math.round(diff / size), unit);
    }
  }
  return "just now";
}

function topPromptAgents(prompt) {
  const names = Object.entries(prompt.byAgent)
    .sort((a, b) => b[1].nanoAiu - a[1].nanoAiu || visibleUsageTokens(b[1]) - visibleUsageTokens(a[1]))
    .slice(0, MAX_AGENT_PROMPT_CHIPS)
    .map(([id]) => lookupAgentName(id));
  return names.length ? names.join(" · ") : "No usage yet";
}

function lookupAgentName(id) {
  if (id === "coordinator") {
    return "Coordinator";
  }
  return state.snapshot.agents.find((agent) => agent.id === id)?.name || id;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || "Unknown";
}

function kindLabel(kind) {
  if (kind === "coding") {
    return "Coding Agent";
  }
  if (kind === "human") {
    return "Human";
  }
  if (kind === "member") {
    return "Squad Member";
  }
  return "Unknown";
}

function humanAvatar(agent) {
  const source = (agent.name || "Human").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "H";
  }
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("");
}

function humanAvailability(agent) {
  if (agent.status === "waiting") {
    return "Awaiting input";
  }
  if (agent.currentTask) {
    return /sign-?off|approve|review/i.test(agent.currentTask) ? "Sign-off lane" : agent.currentTask;
  }
  return "Available";
}

function fallbackTask(agent) {
  if (agent.kind === "human") {
    return "Human sign-off lane.";
  }
  if (agent.status === "idle") {
    return "Ready for the next handoff.";
  }
  if (agent.status === "done") {
    return "Latest task finished.";
  }
  if (agent.status === "waiting") {
    return "Waiting on input or background work.";
  }
  return "Warming up.";
}

function badgeEmoji(agent) {
  if (agent.badge) {
    return agent.badge.split(/\s+/)[0];
  }
  if (agent.kind === "coding") {
    return "🤖";
  }
  if (agent.kind === "human") {
    return "👤";
  }
  if (agent.kind === "member") {
    return "✨";
  }
  return "•";
}

function agentTitle(agent) {
  const lines = [
    agent.name,
    agent.role || kindLabel(agent.kind),
    `Status ${statusLabel(agent.status)}`,
    agent.currentTask ? `Task ${agent.currentTask}` : "",
    agent.currentTool ? `Tool ${agent.currentTool}` : "",
    agent.model ? `Model ${agent.model}` : "",
    agent.mode ? `Mode ${agent.mode}` : "",
    agent.note ? `Note ${agent.note}` : "",
    agent.error ? `Error ${agent.error}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function resolveTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") {
      return stored;
    }
  } catch {}
  const host = document.documentElement.getAttribute("data-color-mode") || document.body?.getAttribute?.("data-color-mode");
  if (host === "dark" || host === "light") {
    return host;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function toggleTheme() {
  applyTheme(document.documentElement.getAttribute("data-ui-theme") === "dark" ? "light" : "dark", true);
}

function applyTheme(theme, persist) {
  document.documentElement.setAttribute("data-ui-theme", theme);
  const dark = theme === "dark";
  elements.themeBtn.setAttribute("aria-pressed", String(dark));
  elements.themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  setText(elements.themeIcon, dark ? "☀️" : "🌙");
  setText(elements.themeLabel, dark ? "Light" : "Dark");
  if (persist) {
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }
}

function announce(text) {
  state.announcements.push(text);
  if (state.announcementTimer) {
    return;
  }
  state.announcementTimer = window.setTimeout(() => {
    setText(elements.announcer, state.announcements.splice(0, 3).join(". "));
    state.announcementTimer = 0;
  }, 800);
}

function metricPill(label) {
  const root = make("span", "metric-pill");
  const prefix = make("span", "metric-pill__label");
  const value = make("strong");
  setText(prefix, label);
  root.append(prefix, value);
  return { root, value };
}

function detailStat(label) {
  const root = make("div", "detail-stat");
  const prefix = make("span", "detail-label");
  const value = make("strong");
  setText(prefix, label);
  root.append(prefix, value);
  return { root, value };
}

function replaceMetaChips(container, labels) {
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  labels.forEach((label) => {
    const chip = make("span", "chip");
    setText(chip, label);
    container.appendChild(chip);
  });
  container.hidden = labels.length === 0;
}

function setChip(node, value, prefix) {
  const text = value ? `${prefix}${value}` : "";
  node.hidden = !text;
  setText(node, text);
}

function setText(node, value) {
  const next = String(value ?? "");
  if (node.textContent !== next) {
    node.textContent = next;
  }
}

function isVisible(node) {
  const rect = node.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

async function fetchJson(url, options) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, ...options });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  return response.json();
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readString(source, key, fallback) {
  return source && key in source ? String(source[key] || "") : fallback;
}

function valueOr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return "";
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function byId(id) {
  return document.getElementById(id);
}

function make(tag, className = "") {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}
