import { createReadStream, existsSync } from 'node:fs';
import readline from 'node:readline';

import { createDashboardStore } from '../lib/store.mjs';

const REAL_LOG = process.argv[2] || process.env.SQUAD_DASHBOARD_BENCH_LOG || '';
const SYNTHETIC_EVENTS = 50_000;
const baseMs = Date.parse('2026-09-30T08:00:00.000Z');
const roster = [
  { id: 'lead', name: 'Lead', role: 'Lead', badge: '🏗️ Lead', kind: 'member' },
  { id: 'gameplay', name: 'Gameplay', role: 'Game Logic', badge: '🎮 Game Logic', kind: 'member' },
  { id: 'frontend', name: 'Frontend', role: 'Frontend', badge: '⚛️ Frontend', kind: 'member' },
  { id: 'tester', name: 'Tester', role: 'Tester', badge: '🧪 Tester', kind: 'member' },
  { id: 'scribe', name: 'Scribe', role: 'Logger', badge: '📋 Scribe', kind: 'member' },
];
const filesSnapshot = {
  projectRoot: '/project',
  noSquad: false,
  roster,
  pricingUsdPerAiu: 1.5,
  files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
  activity: [],
  errors: [],
};

function makeEvent(id, type, data = {}, extra = {}) {
  return { id, type, timestamp: new Date(baseMs + (extra.at ?? 0)).toISOString(), data, ...(extra.agentId ? { agentId: extra.agentId } : {}) };
}

function buildSyntheticEvents(total = SYNTHETIC_EVENTS) {
  const events = [];
  const agentSpecs = [
    ['frontend', 'Frontend', 'gpt-5.4'],
    ['gameplay', 'Gameplay', 'gpt-5.4-mini'],
    ['tester', 'Tester', 'gpt-5-mini'],
    ['scribe', 'Scribe', 'gpt-5-mini'],
  ];
  let t = 0;
  let prompt = 0;
  while (events.length < total) {
    prompt += 1;
    events.push(makeEvent(`user-${prompt}`, 'user.message', { content: `Prompt ${prompt} ${'x'.repeat(140)}` }, { at: t })); t += 1;
    events.push(makeEvent(`turn-${prompt}`, 'assistant.turn_start', { model: 'gpt-5.4' }, { at: t })); t += 1;
    const [agentId, displayName, model] = agentSpecs[prompt % agentSpecs.length];
    const callId = `call-${prompt}`;
    events.push(makeEvent(`spawn-${prompt}`, 'tool.execution_start', {
      toolName: 'task',
      toolCallId: callId,
      arguments: { name: displayName, description: `${displayName}: Work for prompt ${prompt}`, prompt: `Do work ${prompt}`, mode: prompt % 2 ? 'background' : 'sync', model },
    }, { at: t })); t += 1;
    events.push(makeEvent(`started-${prompt}`, 'subagent.started', {
      toolCallId: callId,
      agentName: displayName,
      agentDisplayName: displayName,
      agentDescription: `${displayName}: Work for prompt ${prompt}`,
      executionMode: prompt % 2 ? 'background' : 'sync',
      model,
    }, { at: t, agentId: `ag-${agentId}-${prompt}` })); t += 1;
    events.push(makeEvent(`tool-${prompt}`, 'tool.execution_start', { toolName: 'bash', toolCallId: `tool-${prompt}` }, { at: t, agentId: `ag-${agentId}-${prompt}` })); t += 1;
    events.push(makeEvent(`toolc-${prompt}`, 'tool.execution_complete', { toolCallId: `tool-${prompt}`, success: true }, { at: t, agentId: `ag-${agentId}-${prompt}` })); t += 1;
    events.push(makeEvent(`usage-coord-${prompt}`, 'assistant.usage', {
      model: 'gpt-5.4',
      inputTokens: 100 + (prompt % 20),
      outputTokens: 40 + (prompt % 10),
      apiCallId: `api-c-${prompt}`,
      copilotUsage: { totalNanoAiu: 1_000_000 + prompt },
    }, { at: t })); t += 1;
    events.push(makeEvent(`usage-agent-${prompt}`, 'assistant.usage', {
      model,
      inputTokens: 80 + (prompt % 10),
      outputTokens: 35 + (prompt % 7),
      apiCallId: `api-a-${prompt}`,
      copilotUsage: { totalNanoAiu: 750_000 + prompt },
    }, { at: t, agentId: `ag-${agentId}-${prompt}` })); t += 1;
    events.push(makeEvent(`complete-${prompt}`, 'subagent.completed', {
      toolCallId: callId,
      agentName: displayName,
      agentDisplayName: displayName,
      model,
      totalToolCalls: 1,
      totalTokens: 150 + (prompt % 13),
    }, { at: t, agentId: `ag-${agentId}-${prompt}` })); t += 1;
    if (prompt % 5 === 0) {
      events.push(makeEvent(`checkpoint-${prompt}`, 'session.usage_checkpoint', {
        totalNanoAiu: prompt * 1_750_000,
        totalPremiumRequests: Math.floor(prompt / 5),
        modelCacheState: new Array(1000).fill({}),
        promptCacheBreakState: new Array(1000).fill({}),
      }, { at: t })); t += 1;
    }
    if (prompt % 7 === 0) {
      events.push(makeEvent(`idle-${prompt}`, 'session.idle', {}, { at: t })); t += 1;
    }
  }
  return events.slice(0, total);
}

function createBenchStore(nowRef) {
  const store = createDashboardStore({ projectRoot: '/project', now: () => nowRef.value });
  store.initializeFromFiles(filesSnapshot);
  return store;
}

function report(name, events, ingestNs, snapshotNs, heapBefore, heapAfter, snapshot, extra = {}) {
  const seconds = Number(ingestNs) / 1e9;
  const eps = Math.round(events / Math.max(seconds, 1e-9));
  console.log(JSON.stringify({
    name,
    events,
    seconds: +seconds.toFixed(3),
    eps,
    heapDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(2),
    rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(2),
    snapshotMs: +(Number(snapshotNs) / 1e6).toFixed(3),
    agents: snapshot.agents.length,
    prompts: snapshot.usage.prompts.length,
    activity: snapshot.activity.length,
    ...extra,
  }));
}

async function runSynthetic() {
  global.gc?.();
  const nowRef = { value: baseMs };
  const store = createBenchStore(nowRef);
  const events = buildSyntheticEvents();
  const heapBefore = process.memoryUsage().heapUsed;
  const ingestStart = process.hrtime.bigint();
  for (const evt of events) {
    const ts = Date.parse(evt.timestamp);
    if (!Number.isNaN(ts)) nowRef.value = ts;
    store.ingestSessionEvent(evt);
  }
  const ingestNs = process.hrtime.bigint() - ingestStart;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  const snapshotStart = process.hrtime.bigint();
  const snapshot = store.getSnapshot();
  const snapshotNs = process.hrtime.bigint() - snapshotStart;
  report('synthetic', events.length, ingestNs, snapshotNs, heapBefore, heapAfter, snapshot);
}

async function runRealLog() {
  if (!REAL_LOG || !existsSync(REAL_LOG)) {
    console.log(JSON.stringify({
      name: 'real',
      skipped: true,
      reason: REAL_LOG ? 'log not found' : 'no log path supplied; pass argv[2] or SQUAD_DASHBOARD_BENCH_LOG',
      ...(REAL_LOG ? { logPath: REAL_LOG } : {}),
    }));
    return;
  }
  global.gc?.();
  const nowRef = { value: baseMs };
  const store = createBenchStore(nowRef);
  const heapBefore = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  let count = 0;
  let parseNs = 0n;
  let reducerNs = 0n;
  const ingestStart = process.hrtime.bigint();
  const rl = readline.createInterface({ input: createReadStream(REAL_LOG, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let evt;
    try {
      const parseStart = process.hrtime.bigint();
      evt = JSON.parse(line);
      parseNs += process.hrtime.bigint() - parseStart;
    } catch {
      continue;
    }
    const ts = Date.parse(evt.timestamp);
    if (!Number.isNaN(ts)) nowRef.value = ts;
    const reducerStart = process.hrtime.bigint();
    store.ingestSessionEvent(evt);
    reducerNs += process.hrtime.bigint() - reducerStart;
    count += 1;
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }
  const ingestNs = process.hrtime.bigint() - ingestStart;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  const snapshotStart = process.hrtime.bigint();
  const snapshot = store.getSnapshot();
  const snapshotNs = process.hrtime.bigint() - snapshotStart;
  report('real', count, ingestNs, snapshotNs, heapBefore, heapAfter, snapshot, {
    logPath: REAL_LOG,
    parseMs: +(Number(parseNs) / 1e6).toFixed(3),
    reducerMs: +(Number(reducerNs) / 1e6).toFixed(3),
    peakRssMB: +(peakRss / 1024 / 1024).toFixed(2),
  });
}

if (!global.gc) {
  console.warn('Tip: run with node --expose-gc bench/store-bench.mjs for stable heap measurements.');
}

await runSynthetic();
await runRealLog();
