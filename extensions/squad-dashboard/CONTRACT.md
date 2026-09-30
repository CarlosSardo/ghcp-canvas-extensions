# Squad Dashboard Canvas — Frozen Contract

Scope: extension folder `squad-dashboard/` (user scope `~/.copilot/extensions/squad-dashboard/` or project scope `.github/extensions/squad-dashboard/`); entry is ESM-only `extension.mjs`, no `package.json`, no TypeScript. SDK facts verified: use `joinSession({ canvases })`, `createCanvas`, `CanvasError`; `session.on(...)` streams events; `session.getEvents()` exists for backfill; canvas ctx includes `ctx.session?.workingDirectory`; `process.cwd()` is the extension/session cwd per SDK examples. Never write to stdout.

## Ownership

This contract describes the integrated extension. Phase ownership may vary by squad plan; as of the v2 fix pass the implementation spans:

- SDK/open/backfill: `extension.mjs`, `lib/extension-core.mjs`.
- Server/SSE/security: `lib/server.mjs`.
- Store/files/bench: `lib/store.mjs`, `lib/squad-files.mjs`, `bench/store-bench.mjs`.
- UI/runtime: `ui/index.html`, `ui/app.js`, `ui/styles.css`, `ui/demo-snapshot.json`.
- Tests/helpers: `test/*.test.mjs`, `test/helpers/*.mjs`.

## Public module surface

### `extension.mjs` / `lib/extension-core.mjs` (SDK boundary)

- `extension.mjs` is a thin ESM CLI entry that imports `createSquadDashboardExtension()` from `lib/extension-core.mjs` and passes `CanvasError`, `createCanvas`, `joinSession`, and `extensionRoot`.
- Canvas id: `squad-dashboard`; display name: `Squad Dashboard`; one-sentence description.
- `inputSchema`: `{ type:'object', properties:{ projectPath:{type:'string'} }, additionalProperties:false }`.
- Actions (no `canvas.` prefix):
  - `get_snapshot(input?: {}) -> Snapshot`
  - `get_usage(input?: {}) -> Usage`
  - `refresh(input?: {}) -> Snapshot`
  - `set_note(input:{ agentId:string, note:string }) -> AgentSnapshot|null` (unknown agent id returns `null`)
- Responsibilities: `joinSession`, `createCanvas`, open/backfill, `session.on(...)` live wiring, `session.getEvents()` replay once per store, create/close server, and throw `new CanvasError(code,msg)` only across the SDK boundary.
- Project root resolution order in `open(ctx)`: `ctx.input.projectPath` → `ctx.session?.workingDirectory` → `process.cwd()`, then walk upward for `.squad/team.md`. If none, open with empty `noSquad:true` snapshot.
- `open()` returns after server listen plus `.squad` file initialization; it starts durable event backfill asynchronously and never waits for full history replay. Measured on the real log: open 38.6 ms after the fix, down from about 1243 ms; peak RSS 405 MiB, down from 571 MiB.
- During async backfill, live session events are buffered, then flushed after backfill; store `event.id` dedupe remains the final idempotency guard.
- Usage RPC (`session.rpc.usage.getMetrics()`) is cached per store with single-flight refresh and a 5 s TTL. Polling runs every 10 s only while at least one SSE client is connected. Successful mapped metrics call `store.applyLiveUsageMetrics()`.
- Premium request metrics are dashboard usage metrics and AIU/cost counters, never USD unless pricing is explicitly configured.
- `instanceId` is only panel identity; never durable state key.

### `lib/server.mjs` (no SDK import)

```js
export async function createDashboardServer({ store, uiDir, log, onActive, onIdle, getUsage } = {})
// -> Promise<{ url:string, close():Promise<void> }>
```

- Bind `127.0.0.1:0`. Serve only files under `uiDir`.
- Valid `Host` headers are exactly `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`; any other host receives `421 {error:'invalid_host'}`.
- For `POST`, `/events`, and `/api/*`, `Origin` must be absent or match the bound loopback origin; mismatches receive `403`.
- For `POST`, present `Sec-Fetch-Site` must be `same-origin` or `none`; mismatches receive `403`. Static `GET` assets remain embeddable cross-site.
- Error bodies are sanitized JSON error codes and do not expose local paths or stack traces. No CSP is emitted in this pass.
- Routes:
  - `GET /` → `ui/index.html`
  - `GET /app.js`, `/styles.css`, `/demo-snapshot.json` → static assets
  - `GET /api/snapshot` → `Snapshot` JSON
  - `GET /api/usage` → live cached/reducer `Usage` JSON
  - `POST /api/refresh` → calls `store.refresh()`; returns `Snapshot`
  - `POST /api/note` body `{agentId,note}` → `AgentSnapshot`; unknown `agentId` returns `404` once the server observes `store.setNote()` returning `null`
  - `GET /events` → SSE
  - other protected route → `404` JSON `{error:'not_found'}`
- Static/API conditional GET uses RFC 7232 weak ETag comparison for GET/HEAD, including comma-separated lists, optional weak prefixes, and `*`.
- SSE headers: `text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- On connect, immediately send `event: snapshot` with full snapshot. SSE forwards all store message types through delta batches.

### `lib/squad-files.mjs` (pure file IO/parsing, no SDK)

```js
export function normalizeAgentKey(nameOrDescription)
export function parseTeamMarkdown(markdown) // -> { roster: RosterMember[], codingAgent?: RosterMember }
export async function resolveProjectRoot({ projectPath, cwd, sessionWorkingDirectory } = {}) // -> string|null
export async function readSquadFiles(projectRoot, { maxItems = 50 } = {}) // -> SquadFilesSnapshot
export function watchSquadFiles(projectRoot, onFileEvent, { signal } = {}) // -> { close():void }
```

- Parse `.squad/team.md` Members and Coding Agent tables. Roster member shape: `{ id, name, role, charter, badge, kind:'member'|'coding'|'human' }`.
- Read recent activity from `.squad/orchestration-log/*.md`, `.squad/log/*.md`, `.squad/decisions.md`, `.squad/decisions/inbox/*.md`, `.squad/agents/{name}/history.md`, `.squad/identity/now.md`.
- File event shape: `{ type:'file.changed'|'file.created'|'file.deleted', path, kind, agentId?, timestamp }` where `kind` is `team|routing|decision|decision-inbox|orchestration-log|log|history|identity|unknown`.

### `lib/store.mjs` (pure reducer/state, no SDK)

```js
export function createDashboardStore(options)
// options: { projectRoot?:string|null, now?:()=>number, readFiles?:()=>Promise<SquadFilesSnapshot>|SquadFilesSnapshot, maxFeed?:number, idleAfterMs?:number, doneTtlMs?:number, waitingAfterMs?:number }
// -> DashboardStore
```

`DashboardStore` methods:

```js
initializeFromFiles(filesSnapshot)
ingestSessionEvent(event)
ingestFileEvent(fileEvent)
refresh() // rereads files if a reader was provided; returns Snapshot
getSnapshot() // -> Snapshot
subscribe(listener) // listener(StoreMessage); returns unsubscribe
applyLiveUsageMetrics({ totalNanoAiu?, premiumRequests?, byModel?, fetchedAt? } = {}) // -> Usage
setBackfillProgress({ state, processed?, total?, error? } = {}) // -> Snapshot['meta']['backfill']
setNote(agentId, note) // -> AgentSnapshot|null; returns null and does not mutate for unknown agent ids
close()
```

Default timers: `idleAfterMs=120000`, `doneTtlMs=60000`, `waitingAfterMs=300000`, `maxFeed=100`.

Store subscription messages are exactly:

```js
{ type:'snapshot', snapshot }
{ type:'agent.updated', agent }
{ type:'coordinator.updated', coordinator }
{ type:'activity.added', item }
{ type:'files.changed', files }
{ type:'usage.updated', usage }
{ type:'prompt.updated', prompt }
{ type:'meta.updated', meta:{ backfill } }
```

`applyLiveUsageMetrics()` applies monotonic authoritative session/model usage from live RPC or aggregate shutdown data. `byModel` values may include `requests`, `premiumRequests`, `nanoAiu`, `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. `requests` is observed live model-call count; `premiumRequests` is session-wide premium request units and may exceed observed calls. RPC-backed usage responses may also expose `userRequests` as the runtime's total user request count.

`setBackfillProgress()` accepts `state:'pending'|'running'|'done'|'error'` plus optional `processed`, `total`, and `error`; it updates `snapshot.meta.backfill`, maintains legacy `snapshot.meta.eventBackfill = state === 'done'`, and emits throttled `meta.updated` progress, always on state changes.

## Snapshot schema

```js
Snapshot = {
  schemaVersion: 1,
  generatedAt: 'ISO-8601',
  projectRoot: string|null,
  noSquad: boolean,
  coordinator: { status:'thinking'|'idle', currentTask?:string, model?:string, lastActivityAt?:string },
  agents: AgentSnapshot[],
  activity: ActivityItem[],
  files: { decisionsInboxCount:number, orchestrationLogCount:number, logCount:number, lastFileActivityAt?:string },
  usage: Usage,
  meta: { source:'live'|'demo', eventBackfill:boolean, backfill?:BackfillProgress, errors:string[] }
}
AgentSnapshot = {
  id:string, name:string, role?:string, badge?:string, roster:boolean, kind:'member'|'coding'|'human'|'unknown',
  status:'idle'|'spawning'|'working'|'waiting'|'done'|'failed',
  currentTask?:string, currentTool?:string, model?:string, mode?:string, note?:string,
  runtimeAgentId?:string, taskToolCallId?:string, startedAt?:string, lastActivityAt?:string,
  counters:{ toolCalls:number, completedTasks:number, failedTasks:number }, error?:string
}
ActivityItem = { id:string, timestamp:string, agentId?:string, level:'info'|'success'|'warning'|'error', text:string, source:'session'|'file'|'system' }
```

Example:

```json
{
  "schemaVersion":1,
  "generatedAt":"2026-09-28T16:19:17+02:00",
  "projectRoot":"/home/you/projects/demo",
  "noSquad":false,
  "coordinator":{"status":"thinking","model":"gpt-5.4","lastActivityAt":"2026-09-28T16:19:30+02:00"},
  "agents":[{"id":"frontend","name":"Frontend","role":"Frontend Dev","badge":"⚛️ Frontend","roster":true,"kind":"member","status":"working","currentTask":"Building UI","currentTool":"edit","runtimeAgentId":"ag_123","taskToolCallId":"call_1","startedAt":"2026-09-28T16:20:00+02:00","lastActivityAt":"2026-09-28T16:20:12+02:00","counters":{"toolCalls":3,"completedTasks":0,"failedTasks":0}}],
  "activity":[{"id":"evt-1","timestamp":"2026-09-28T16:20:12+02:00","agentId":"frontend","level":"info","text":"Frontend running edit","source":"session"}],
  "files":{"decisionsInboxCount":0,"orchestrationLogCount":5,"logCount":3},
  "meta":{"source":"live","eventBackfill":true,"backfill":{"state":"done","processed":18567,"total":18567,"updatedAt":"2026-09-30T09:10:00.000Z"},"errors":[]}
}
```

## SSE contract

- `event: snapshot`, data `Snapshot`: initial connect, refresh, roster reload.
- `event: delta`, data usually `{ type:'batch', items:StoreMessage[] }`; legacy single `StoreMessage` payloads may still be tolerated by the UI. `StoreMessage` is one of:
  - `{ type:'agent.updated', agent:AgentSnapshot }`
  - `{ type:'coordinator.updated', coordinator:Snapshot['coordinator'] }`
  - `{ type:'activity.added', item:ActivityItem }`
  - `{ type:'files.changed', files:Snapshot['files'] }`
  - `{ type:'usage.updated', usage:UsageDelta }`
  - `{ type:'prompt.updated', prompt:PromptSnapshot }`
  - `{ type:'meta.updated', meta:{ backfill:BackfillProgress } }`
- `event: heartbeat`, data `{ timestamp:string }` every 15s.
- `event: error`, data `{ code:string, message:string }` for recoverable server/store errors.

## Event correlation and status rules

- Roster ids use `normalizeAgentKey`: lowercase, strip leading emoji/symbols, for colon labels keep the left side, remove accents, collapse non-alphanumerics to `-`, trim `-`. `Fact Checker` → `fact-checker`; `⚛️ Frontend: Building UI` → `frontend`.
- Root `tool.execution_start` with task tool (`data.toolName === 'task'` or suffix `.task`): parse `data.arguments` object or JSON string; use `name` first, else stripped `description` before `:`. Create/update agent as `spawning`; store `pendingTaskByToolCallId`.
- `subagent.started`: match `data.toolCallId` to pending task; else use `data.agentName`/`agentDisplayName`. Set `runtimeAgentId=event.agentId`, `status='working'`, copy `agentDescription`, `agentType`, `executionMode`, `model`.
- `subagent.configured`: update agent matched by `event.agentId`; copy resolved `model`.
- Sub-agent `tool.execution_start` (`event.agentId` present): ensure unknown agent if needed, set `currentTool=data.toolName`, `status='working'`, increment `toolCalls` once per `toolCallId`.
- Matching `tool.execution_complete`: clear `currentTool` if it is the in-flight tool; record success/failure activity.
- `subagent.completed`: match by `event.agentId` or `data.toolCallId`; set `done`, increment `completedTasks`, clear current tool; if `cancelled`, activity level `warning`.
- `subagent.failed`: set `failed`, increment `failedTasks`, store `error`.
- Terminal transitions record `{status:'done'|'failed', terminalAt, terminalOrder}` by runtime agent. Durable/live child tool and usage events after a matching `subagent.completed`/`subagent.failed` may update deduped counters or session/model totals, but never change that terminal runtime back to `working` or charge the old terminal run. A completed/failed runtime reopens only on an agent-scoped `user.message`, `assistant.turn_start`, `subagent.started`, or `subagent.configured` newer than the terminal transition.
- Root `assistant.turn_start` (no `event.agentId`) sets coordinator `thinking`; root `session.idle` sets coordinator `idle`.
- Derived status timers emit targeted `agent.updated` and `coordinator.updated` deltas only; they must not emit full `snapshot` messages. Full store `snapshot` messages are reserved for genuine resets such as file initialization and refresh.
- Derived timeouts during `getSnapshot()`: `done` older than `doneTtlMs` → `idle`; `spawning|working` with no activity older than `waitingAfterMs` → `waiting`; touched `history.md` may set idle roster agents to `waiting`/recently active via activity feed, but must not override a live running/failed state.
- Unknown spawned agents must remain visible even if absent from roster.

## UI/theming contract

- Use host tokens: `--background-color-default`, `--border-color-default`, `--text-color-default`, `--text-color-muted`, `--color-focus-outline`, `--true-color-green|blue|yellow|red` and `-muted`, `--font-sans`, `--font-mono`, `--font-weight-semibold`, `--text-body-medium`, `--leading-body-medium`.
- Status color semantics: idle muted, spawning blue, working green with subtle pulse, waiting yellow, done green check, failed red.
- Respect `prefers-reduced-motion: reduce` by disabling pulses/transitions.
- Layout: clean dashboard cards + compact activity rail; demo mode `?demo=1` loads `ui/demo-snapshot.json` and simulates deltas without SDK/server changes.
- Inline pre-paint bootstrap applies persisted `data-ui-theme` before CSS loads. Host theme tokens have local fallbacks in CSS.
- The history/backfill pill renders `snapshot.meta.backfill` progress and hides when done.
- Tabs use WAI-ARIA roles with roving `tabindex`; ArrowLeft/ArrowRight/Home/End move selection.
- Demo ticks and elapsed-time updates pause while `document.hidden`.
- Usage `totalTokens` is input + output only; cache-read/cache-write tokens stay separate.
- Recoverable SSE `event: error` messages are rendered as activity and do not force reconnect.

## Amendments

### 2026-09-28T16:32:03+02:00: SDK verification corrections

- `session.getEvents()` is async (`Promise<SessionEvent[]>`) and durable-history backfill may omit ephemeral events such as `session.idle`; live updates must still come from `session.on(...)`. Extension backfill normalizes the coordinator to idle after replay when the last durable root event is not `assistant.turn_start`.
- `ctx.session?.workingDirectory` is valid and remains the primary canvas-open working directory. `process.cwd()` is only a launch/process fallback, not a reliable active session cwd after host cwd changes.
- Installed `CanvasProviderOpenRequest` has no `ctx.reason`; open must be idempotent without branching on a reason field.
- There is no SDK API to push canvas title/status after open; host chrome metadata is returned from `open()`, while live dashboard state updates through the iframe server/SSE.
- `tool.execution_complete` has `toolCallId`, `success`, optional `error`, and optional `result`; it does not carry `toolName`. Reducers must correlate completion by `toolCallId`.
- `tool.execution_start.data.arguments` is arbitrary `JsonValue`; object and JSON-string arguments are only common cases, not the full shape.

## v2 Amendments

- `Snapshot.usage` is additive and schemaVersion stays `1`: session totals, optional authoritative `sessionNanoAiuAuthoritative`, `premiumRequests`, `byModel`, newest-first `prompts` (max 30), `pricing { unitLabel:'AIU', nanoPerUnit:1e9, usdPerUnit? }`, and `meta { liveSince?, partial }`. Agent/coordinator usage blocks use the shared `UsageTotals` shape (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `estimatedTokens?`, `estimated?`, `nanoAiu`, `premiumRequests`, `requests`). `totalTokens` is always `inputTokens + outputTokens`; durable `subagent.completed.totalTokens` backfill that lacks input/output is stored separately as `estimatedTokens` with `estimated:true` on affected usage totals (agent total/run, session/model/prompt totals, and prompt `byAgent`). The AIU label and `nanoPerUnit:1e9` are dashboard display conventions; USD appears only when explicitly configured. `snapshot.usage.session.requests` counts observed live `assistant.usage` model calls since the dashboard started; `usage.premiumRequests` is session-wide premium request units from checkpoints/RPC and can be larger; RPC usage may include `userRequests` for total user requests.
- Usage attribution rules: `assistant.usage` is live-only/ephemeral; per SDK 1.0.90, `data.model` is optional and model attribution is best-effort. Top-level `event.agentId` is the live sub-agent attribution key when present. `subagent.completed|failed` provide durable token totals only; `session.usage_checkpoint.totalNanoAiu` is cumulative/session-wide and authoritative when larger than summed live AIU. Prompt attribution starts at `user.message`; background sub-agent usage stays attached to the spawning prompt/tool call.
- Runtime `session.usage_checkpoint` payloads may include undeclared extras such as `totalPremiumRequests` and cache-state arrays; parse defensively and ignore the large arrays. `session.shutdown` metrics are ingested only as monotonic aggregate/session and per-model totals via `applyLiveUsageMetrics()`; they are not assigned to per-agent runs to avoid double counting or misattribution.
- Replay/idempotency guidance: dedupe persisted history by `event.id`. Treat `apiCallId` as correlation metadata; use it as a live `assistant.usage` safeguard only when independently verified.
- SSE keeps `snapshot`, `heartbeat`, and `error`; `delta` now prefers `{ type:'batch', items:[...] }` batches flushed at most every 250 ms. Merge last-wins for `agent.updated`, `coordinator.updated`, `usage.updated`, and `files.changed`; append `activity.added` / `prompt.updated` in order; overflow falls back to a fresh `snapshot`. UI must still tolerate legacy single-delta payloads.
- `lib/server.mjs` adds `GET /api/usage`, shared store subscription/heartbeat timers, per-server client counting, static asset ETag + lazy gzip/brotli caching, compressed `/api/snapshot` and `/api/usage`, and backpressure recovery via client-specific snapshot resync. When live RPC is available, usage reads should prefer `session.rpc.usage.getMetrics()` for authoritative session/model totals and use replay/reducer state mainly for prompt history and older persisted sessions.
- Performance rules remain contractual: idle-cheap server/UI behavior, no per-client timers, pause file watching / SSE-heavy work when nobody is listening, batch DOM writes, cap feed/rendered lists, and prefer CSS/layout containment over heavy effects.
