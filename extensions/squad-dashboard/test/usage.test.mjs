import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDashboardStore } from '../lib/store.mjs';
import { makeScratch } from './helpers/scratch.mjs';

const baseMs = Date.parse('2026-09-30T08:32:12.000+02:00');
const storeModuleUrl = new URL('../lib/store.mjs', import.meta.url);

function iso(offsetMs = 0) {
  return new Date(baseMs + offsetMs).toISOString();
}

function event(id, type, data = {}, { at = 0, agentId, parentId = null } = {}) {
  return { id, timestamp: iso(at), parentId, type, data, ...(agentId ? { agentId } : {}) };
}

function filesSnapshot() {
  return {
    projectRoot: '/project',
    noSquad: false,
    roster: [
      { id: 'frontend', name: 'Frontend', role: 'Frontend Dev', charter: '.squad/agents/frontend/charter.md', badge: '⚛️ Frontend', kind: 'member' },
      { id: 'gameplay', name: 'Gameplay', role: 'Game Logic', charter: '.squad/agents/gameplay/charter.md', badge: '🎮 Game Logic', kind: 'member' },
      { id: 'tester', name: 'Tester', role: 'Tester', charter: '.squad/agents/tester/charter.md', badge: '🧪 Tester', kind: 'member' },
    ],
    codingAgent: { id: 'copilot', name: '@copilot', role: 'Coding Agent', charter: '—', badge: '🤖 Coding Agent', kind: 'coding' },
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    activity: [],
    errors: [],
  };
}

function createInitializedStore(options = {}) {
  const store = createDashboardStore({ projectRoot: '/project', now: () => baseMs, ...options });
  store.initializeFromFiles(filesSnapshot());
  return store;
}

function agentById(store, id) {
  const agent = store.getSnapshot().agents.find((candidate) => candidate.id === id);
  assert.ok(agent, `expected agent ${id} in snapshot`);
  return agent;
}

function spawnAgent(store, {
  agentName = 'Frontend',
  description = `${agentName}: Working`,
  toolCallId = `call-${agentName.toLowerCase()}`,
  runtimeAgentId = `ag-${agentName.toLowerCase()}`,
  at = 0,
  mode = 'background',
  model = 'gpt-5.4',
} = {}) {
  store.ingestSessionEvent(event(`${toolCallId}-task`, 'tool.execution_start', {
    toolName: 'task',
    toolCallId,
    arguments: { name: agentName, description, mode, model },
  }, { at }));
  store.ingestSessionEvent(event(`${toolCallId}-started`, 'subagent.started', {
    toolCallId,
    agentName,
    agentDisplayName: agentName,
    agentDescription: description,
    executionMode: mode,
    model,
  }, { at: at + 1, agentId: runtimeAgentId }));
  return { toolCallId, runtimeAgentId };
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    nanoAiu: 0,
    requests: 0,
  };
}

function assertUsage(actual, expected, message = 'usage totals mismatch') {
  const includePremium = Object.hasOwn(actual, 'premiumRequests') || Object.hasOwn(expected, 'premiumRequests');
  const normalize = (value) => {
    const normalized = { ...zeroUsage(), ...value };
    if (includePremium) {
      normalized.premiumRequests = normalized.premiumRequests ?? 0;
    } else {
      delete normalized.premiumRequests;
    }
    return normalized;
  };
  assert.deepEqual(normalize(actual), normalize(expected), message);
}

async function makeTempProject(prefix) {
  return makeScratch(prefix.replace(/-$/, ''));
}

async function importFreshStoreModule() {
  return import(`${storeModuleUrl.href}?fresh=${Date.now()}-${Math.random()}`);
}

test('assistant.usage attributes runtime-agent and coordinator usage, with totals math and default pricing', () => {
  const store = createInitializedStore();
  store.ingestSessionEvent(event('prompt-1', 'user.message', {
    content: 'Write the usage dashboard tests and validate attribution.'
  }, { at: 0 }));
  spawnAgent(store, { agentName: 'Frontend', description: 'Frontend: Implementing usage UI', toolCallId: 'call-front', runtimeAgentId: 'ag-front', at: 1, mode: 'background', model: 'gpt-6-sol' });

  store.ingestSessionEvent(event('usage-front', 'assistant.usage', {
    model: 'gpt-6-sol',
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    copilotUsage: { totalNanoAiu: 1200, model: 'gpt-6-sol' },
    apiCallId: 'api-front-1',
  }, { at: 5, agentId: 'ag-front' }));
  store.ingestSessionEvent(event('usage-root', 'assistant.usage', {
    model: 'gpt-6-sol',
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    copilotUsage: { totalNanoAiu: 300, model: 'gpt-6-sol' },
    apiCallId: 'api-root-1',
  }, { at: 6 }));

  const snapshot = store.getSnapshot();
  const prompt = snapshot.usage.prompts[0];
  assert.equal(prompt.active, true);
  assert.equal(snapshot.usage.activePromptId, prompt.id);

  assertUsage(snapshot.usage.session, {
    inputTokens: 13,
    outputTokens: 10,
    cacheReadTokens: 6,
    cacheWriteTokens: 4,
    totalTokens: 23,
    nanoAiu: 1500,
    requests: 2,
  }, 'session totals must include coordinator and agent usage');
  assertUsage(snapshot.usage.byModel['gpt-6-sol'], snapshot.usage.session, 'by-model totals must aggregate live usage');
  assertUsage(prompt.totals, snapshot.usage.session, 'active prompt must accumulate its usage');
  assertUsage(prompt.byAgent.frontend, {
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    totalTokens: 18,
    nanoAiu: 1200,
    requests: 1,
  }, 'prompt usage should attribute runtime agent usage to the correlated roster agent');
  assertUsage(prompt.byAgent.coordinator, {
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 5,
    nanoAiu: 300,
    requests: 1,
  }, 'usage without event.agentId must attribute to the coordinator');
  assertUsage(snapshot.coordinator.usage, prompt.byAgent.coordinator, 'coordinator snapshot must expose coordinator usage totals');

  const frontend = agentById(store, 'frontend');
  assert.equal(frontend.usage.estimated, false);
  assertUsage(frontend.usage.total, prompt.byAgent.frontend, 'agent total usage should match live agent usage');
  assertUsage(frontend.usage.run, prompt.byAgent.frontend, 'agent run usage should track the active/last task run');
  assertUsage(frontend.usage.byModel['gpt-6-sol'], prompt.byAgent.frontend, 'agent by-model totals should be recorded');

  assert.equal(snapshot.usage.meta.partial, false);
  assert.equal(snapshot.usage.pricing.unitLabel, 'AIU');
  assert.equal(snapshot.usage.pricing.nanoPerUnit, 1e9);
  assert.equal(Object.hasOwn(snapshot.usage.pricing, 'usdPerUnit'), false);
});

test('user.message prompts are truncated, newest-first, capped to 30, and active flags flip on the next prompt', () => {
  const store = createInitializedStore();
  const long = 'L'.repeat(140);

  for (let index = 0; index < 32; index += 1) {
    const content = index === 0 ? long : `Prompt ${index}`;
    store.ingestSessionEvent(event(`prompt-${index}`, 'user.message', { content }, { at: index * 10 }));
  }

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.usage.prompts.length, 30, 'only the newest 30 prompts should be retained');
  assert.equal(snapshot.usage.prompts[0].text, 'Prompt 31');
  assert.equal(snapshot.usage.prompts[0].active, true);
  assert.equal(snapshot.usage.activePromptId, snapshot.usage.prompts[0].id);
  assert.equal(snapshot.usage.prompts[1].active, false, 'the prior prompt must become inactive when a new prompt starts');
  assert.equal(snapshot.usage.prompts.at(-1).text, 'Prompt 2', 'oldest retained prompt should be the third prompt after capping');

  const truncationStore = createInitializedStore();
  truncationStore.ingestSessionEvent(event('prompt-long', 'user.message', { content: long }, { at: 0 }));
  const prompt = truncationStore.getSnapshot().usage.prompts[0];
  assert.equal(prompt.text.length, 120, 'prompt text should be capped to 120 characters');
  assert.equal(prompt.text, long.slice(0, 120));
});

test('prompt byAgent maps keep only the top 12 contributors by usage', () => {
  const store = createInitializedStore();
  store.ingestSessionEvent(event('prompt-by-agent', 'user.message', { content: 'Aggregate background agent cost' }, { at: 0 }));

  for (let index = 0; index < 15; index += 1) {
    const agentName = `Agent ${index}`;
    const runtimeAgentId = `ag-${index}`;
    spawnAgent(store, {
      agentName,
      description: `${agentName}: background work`,
      toolCallId: `call-${index}`,
      runtimeAgentId,
      at: index + 1,
      mode: 'background',
      model: 'gpt-5.6-sol',
    });
    store.ingestSessionEvent(event(`usage-${index}`, 'assistant.usage', {
      model: 'gpt-5.6-sol',
      inputTokens: index + 1,
      outputTokens: index + 1,
      copilotUsage: { totalNanoAiu: (index + 1) * 100, model: 'gpt-5.6-sol' },
      apiCallId: `usage-call-${index}`,
    }, { at: 100 + index, agentId: runtimeAgentId }));
  }

  const byAgent = store.getSnapshot().usage.prompts[0].byAgent;
  const keys = Object.keys(byAgent);
  assert.equal(keys.length, 12, 'prompt byAgent maps should be capped to the 12 biggest contributors');
  assert.equal(keys.includes('agent-14'), true);
  assert.equal(keys.includes('agent-13'), true);
  assert.equal(keys.includes('agent-3'), true);
  assert.equal(keys.includes('agent-2'), false, 'lowest-usage agents should be trimmed first');
  assert.equal(keys.includes('agent-0'), false);
});

test('background sub-agent usage after a prompt ended stays attributed to the spawning prompt', () => {
  const store = createInitializedStore();
  store.ingestSessionEvent(event('prompt-1', 'user.message', { content: 'Kick off gameplay benchmarks' }, { at: 0 }));
  spawnAgent(store, {
    agentName: 'Gameplay',
    description: 'Gameplay: Running long background simulation',
    toolCallId: 'call-gameplay',
    runtimeAgentId: 'ag-gameplay',
    at: 1,
    mode: 'background',
    model: 'gpt-5.6-terra',
  });
  store.ingestSessionEvent(event('prompt-1-end', 'session.idle', { mode: 'autopilot' }, { at: 10 }));
  store.ingestSessionEvent(event('prompt-2', 'user.message', { content: 'Now summarize current status' }, { at: 20 }));
  store.ingestSessionEvent(event('usage-late', 'assistant.usage', {
    model: 'gpt-5.6-terra',
    inputTokens: 9,
    outputTokens: 6,
    copilotUsage: { totalNanoAiu: 700, model: 'gpt-5.6-terra' },
    apiCallId: 'late-background-1',
  }, { at: 30, agentId: 'ag-gameplay' }));

  const prompts = store.getSnapshot().usage.prompts;
  assert.equal(prompts[0].text, 'Now summarize current status');
  assert.equal(prompts[0].totals.totalTokens, 0, 'new prompt must stay empty when the background task belongs to an older prompt');
  assert.equal(prompts[1].text, 'Kick off gameplay benchmarks');
  assertUsage(prompts[1].byAgent.gameplay, {
    inputTokens: 9,
    outputTokens: 6,
    totalTokens: 15,
    nanoAiu: 700,
    requests: 1,
  }, 'late background usage should be attributed to the spawning prompt');
});

test('known runtime agent events reopen a completed agent without a new subagent.started event', () => {
  const store = createInitializedStore();
  const { toolCallId, runtimeAgentId } = spawnAgent(store, {
    agentName: 'Frontend',
    description: 'Frontend: Compact cards',
    toolCallId: 'call-front-reactivate',
    runtimeAgentId: '4b446eab-demo',
    at: 0,
    mode: 'background',
    model: 'gpt-5.4',
  });

  store.ingestSessionEvent(event('front-complete-1', 'subagent.completed', {
    toolCallId,
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
    model: 'gpt-5.4',
  }, { at: 10, agentId: runtimeAgentId }));

  const completed = agentById(store, 'frontend');
  assert.equal(completed.status, 'done');
  const firstStartedAt = completed.startedAt;

  store.ingestSessionEvent(event('front-followup-user', 'user.message', {
    content: 'Please keep refining the header state.',
  }, { at: 20, agentId: runtimeAgentId }));
  store.ingestSessionEvent(event('front-followup-turn', 'assistant.turn_start', {
    model: 'gpt-5.4',
  }, { at: 21, agentId: runtimeAgentId }));
  store.ingestSessionEvent(event('front-followup-message', 'assistant.message', {
    model: 'gpt-5.4',
    content: 'Resuming work.',
  }, { at: 22, agentId: runtimeAgentId }));
  store.ingestSessionEvent(event('front-followup-tool', 'tool.execution_start', {
    toolName: 'edit',
    toolCallId: 'followup-tool-1',
    model: 'gpt-5.4',
  }, { at: 23, agentId: runtimeAgentId }));

  const reopened = agentById(store, 'frontend');
  assert.equal(reopened.status, 'working');
  assert.equal(reopened.currentTool, 'edit');
  assert.notEqual(reopened.startedAt, firstStartedAt, 'reactivation should reset the run start timestamp');

  const workingCount = store.getSnapshot().agents.filter((agent) => agent.status === 'working').length;
  assert.equal(workingCount, 1, 'reactivated agents must contribute to working summary counts');

  store.ingestSessionEvent(event('front-complete-2', 'subagent.completed', {
    toolCallId,
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
    model: 'gpt-5.4',
  }, { at: 30, agentId: runtimeAgentId }));

  assert.equal(agentById(store, 'frontend').status, 'done');
});

test('assistant.usage is deduped by event.id and apiCallId', () => {
  const store = createInitializedStore();
  store.ingestSessionEvent(event('prompt-dedupe', 'user.message', { content: 'Deduplicate live usage' }, { at: 0 }));
  spawnAgent(store, { agentName: 'Frontend', toolCallId: 'call-front', runtimeAgentId: 'ag-front', at: 1, mode: 'background' });

  const first = event('usage-1', 'assistant.usage', {
    model: 'gpt-5.4',
    inputTokens: 4,
    outputTokens: 5,
    copilotUsage: { totalNanoAiu: 111 },
    apiCallId: 'api-dup',
  }, { at: 5, agentId: 'ag-front' });
  store.ingestSessionEvent(first);
  store.ingestSessionEvent(first);
  store.ingestSessionEvent(event('usage-2', 'assistant.usage', {
    model: 'gpt-5.4',
    inputTokens: 400,
    outputTokens: 500,
    copilotUsage: { totalNanoAiu: 9999 },
    apiCallId: 'api-dup',
  }, { at: 6, agentId: 'ag-front' }));
  store.ingestSessionEvent(event('usage-3', 'assistant.usage', {
    model: 'gpt-5.4',
    inputTokens: 1,
    outputTokens: 2,
    copilotUsage: { totalNanoAiu: 22 },
    apiCallId: 'api-unique',
  }, { at: 7, agentId: 'ag-front' }));

  assertUsage(store.getSnapshot().usage.session, {
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 12,
    nanoAiu: 133,
    requests: 2,
  }, 'duplicate event ids and apiCallIds must not double-count usage');
});

test('subagent.completed totals mark usage as estimated and make usage.meta.partial true when live AIU is missing', () => {
  const store = createInitializedStore();
  store.ingestSessionEvent(event('prompt-estimated', 'user.message', { content: 'Backfill completed task usage' }, { at: 0 }));
  spawnAgent(store, { agentName: 'Tester', toolCallId: 'call-tester', runtimeAgentId: 'ag-tester', at: 1, mode: 'background', model: 'gpt-5.5' });
  store.ingestSessionEvent(event('tester-complete', 'subagent.completed', {
    toolCallId: 'call-tester',
    agentName: 'Tester',
    agentDisplayName: 'Tester',
    model: 'gpt-5.5',
    totalTokens: 42,
    totalToolCalls: 3,
  }, { at: 10, agentId: 'ag-tester' }));

  const snapshot = store.getSnapshot();
  const tester = agentById(store, 'tester');
  assert.equal(tester.usage.estimated, true, 'persisted subagent totals should mark agent usage as estimated when no live usage exists');
  assert.equal(tester.usage.total.totalTokens, 0);
  assert.equal(tester.usage.total.estimatedTokens, 42);
  assert.equal(tester.usage.total.estimated, true);
  assert.equal(tester.usage.run.totalTokens, 0);
  assert.equal(tester.usage.run.estimatedTokens, 42);
  assert.equal(tester.usage.run.estimated, true);
  assert.equal(snapshot.usage.meta.partial, true, 'session usage should be marked partial when only estimated tokens are available');
  assert.equal(snapshot.usage.prompts[0].totals.totalTokens, 0);
  assert.equal(snapshot.usage.prompts[0].totals.estimatedTokens, 42);
  assert.equal(snapshot.usage.prompts[0].byAgent.tester.estimatedTokens, 42);
  assert.equal(snapshot.usage.prompts[0].byAgent.tester.estimated, true);
});

test('session.usage_checkpoint keeps authoritative totals and ignores huge cache-state payloads', () => {
  const store = createInitializedStore();
  store.ingestSessionEvent(event('prompt-checkpoint', 'user.message', { content: 'Checkpoint live usage' }, { at: 0 }));
  store.ingestSessionEvent(event('usage-live', 'assistant.usage', {
    model: 'gpt-5.4',
    inputTokens: 3,
    outputTokens: 2,
    copilotUsage: { totalNanoAiu: 100 },
    apiCallId: 'live-before-checkpoint',
  }, { at: 1 }));

  const hugeChunk = 'x'.repeat(1024);
  const hugeArray = Array.from({ length: 2048 }, (_, index) => `${index}:${hugeChunk}`);
  store.ingestSessionEvent(event('checkpoint', 'session.usage_checkpoint', {
    totalNanoAiu: 150,
    totalPremiumRequests: 7,
    modelCacheState: hugeArray,
    agentModelCacheState: hugeArray,
  }, { at: 2 }));

  const snapshot = store.getSnapshot();
  const json = JSON.stringify(snapshot);
  assert.equal(snapshot.usage.session.nanoAiu, 100);
  assert.equal(snapshot.usage.sessionNanoAiuAuthoritative, 150);
  assert.equal(snapshot.usage.premiumRequests, 7);
  assert.equal(json.includes('modelCacheState'), false, 'checkpoint cache-state arrays must never be retained in the snapshot');
  assert.ok(Buffer.byteLength(json, 'utf8') < 50 * 1024, 'snapshot JSON should stay compact after a huge checkpoint event');
});

test('pricing usdPerUnit is exposed only from env or .squad/dashboard.json', async () => {
  const original = process.env.SQUAD_DASHBOARD_USD_PER_AIU;
  const scratch = await makeTempProject('pricing-');
  const projectRoot = scratch.dir;
  try {
    await mkdir(join(projectRoot, '.squad'), { recursive: true });
    await writeFile(join(projectRoot, '.squad', 'dashboard.json'), JSON.stringify({ usdPerAiu: 0.75 }));

    delete process.env.SQUAD_DASHBOARD_USD_PER_AIU;
    const { createDashboardStore: createStoreFromConfig } = await importFreshStoreModule();
    const configStore = createStoreFromConfig({ projectRoot, now: () => baseMs });
    configStore.initializeFromFiles({ ...filesSnapshot(), projectRoot });
    assert.equal(configStore.getSnapshot().usage.pricing.usdPerUnit, 0.75, 'project dashboard.json should define usdPerUnit when env is unset');

    process.env.SQUAD_DASHBOARD_USD_PER_AIU = '1.25';
    const { createDashboardStore: createStoreFromEnv } = await importFreshStoreModule();
    const envStore = createStoreFromEnv({ projectRoot, now: () => baseMs });
    envStore.initializeFromFiles({ ...filesSnapshot(), projectRoot });
    assert.equal(envStore.getSnapshot().usage.pricing.usdPerUnit, 1.25, 'env pricing should be exposed when configured');
  } finally {
    if (original === undefined) {
      delete process.env.SQUAD_DASHBOARD_USD_PER_AIU;
    } else {
      process.env.SQUAD_DASHBOARD_USD_PER_AIU = original;
    }
    await scratch.cleanup();
  }
});

test('subscribe emits prompt.updated and usage.updated, and getSnapshot stays cheap when nothing changed', () => {
  const store = createInitializedStore();
  const messages = [];
  const unsubscribe = store.subscribe((message) => messages.push(message));

  store.ingestSessionEvent(event('prompt-subscribe', 'user.message', { content: 'Track reducer deltas' }, { at: 0 }));
  spawnAgent(store, { agentName: 'Frontend', toolCallId: 'call-front', runtimeAgentId: 'ag-front', at: 1, mode: 'background' });
  store.ingestSessionEvent(event('usage-subscribe', 'assistant.usage', {
    model: 'gpt-5.4',
    inputTokens: 1,
    outputTokens: 1,
    copilotUsage: { totalNanoAiu: 10 },
    apiCallId: 'subscribe-usage',
  }, { at: 2, agentId: 'ag-front' }));
  unsubscribe();

  assert.equal(messages.some((message) => message.type === 'prompt.updated'), true, 'store subscribers should receive prompt.updated messages directly');
  assert.equal(messages.some((message) => message.type === 'usage.updated'), true, 'store subscribers should receive usage.updated messages directly');

  const first = store.getSnapshot();
  const second = store.getSnapshot();
  if (first !== second) {
    const startedAt = performance.now();
    for (let index = 0; index < 5000; index += 1) {
      store.getSnapshot();
    }
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 250, `getSnapshot() should stay cheap when nothing changed (took ${elapsedMs.toFixed(1)}ms)`);
  }
});

test('dedupe bookkeeping stays bounded enough to avoid retaining raw events after 50k unique events', () => {
  const store = createInitializedStore();
  store.ingestSessionEvent(event('prompt-bounded', 'user.message', { content: 'Stress dedupe sets' }, { at: 0 }));

  const canGc = typeof global.gc === 'function';
  if (canGc) {
    global.gc();
  }
  const before = process.memoryUsage().heapUsed;

  for (let index = 0; index < 50_000; index += 1) {
    store.ingestSessionEvent(event(`usage-stress-${index}`, 'assistant.usage', {
      model: 'gpt-5.4',
      inputTokens: 1,
      outputTokens: 1,
      copilotUsage: { totalNanoAiu: 1 },
      apiCallId: `stress-call-${index}`,
      ignoredBlob: 'payload'.repeat(40),
    }, { at: index + 1 }));
  }

  const snapshot = store.getSnapshot();
  if (canGc) {
    global.gc();
    global.gc();
    const after = process.memoryUsage().heapUsed;
    const growth = after - before;
    assert.ok(growth < 25 * 1024 * 1024, `heap growth should stay modest after 50k unique events (grew ${(growth / (1024 * 1024)).toFixed(1)} MiB)`);
  } else {
    assert.equal(snapshot.activity.length <= 100, true, 'bounded activity should prevent retaining raw event feeds');
    assert.equal(snapshot.usage.prompts.length <= 30, true, 'bounded prompts should prevent retaining full history');
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 200 * 1024, 'snapshot should remain compact without exposing retained raw events');
  }
});
