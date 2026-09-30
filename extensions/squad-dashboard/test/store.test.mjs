import test from 'node:test';
import assert from 'node:assert/strict';

import { createDashboardStore } from '../lib/store.mjs';

const baseMs = Date.parse('2026-09-28T16:19:17.000+02:00');

function iso(offsetMs = 0) {
  return new Date(baseMs + offsetMs).toISOString();
}

function event(id, type, data = {}, { at = 0, agentId, parentId = null } = {}) {
  return { id, timestamp: iso(at), parentId, type, data, ...(agentId ? { agentId } : {}) };
}

function filesSnapshot(overrides = {}) {
  return {
    roster: [
      { id: 'frontend', name: 'Frontend', role: 'Frontend Dev', charter: '.squad/agents/frontend/charter.md', badge: '⚛️ Frontend', kind: 'member' },
      { id: 'tester', name: 'Tester', role: 'Tester', charter: '.squad/agents/tester/charter.md', badge: '🧪 Tester', kind: 'member' },
      { id: 'carlos-sardo', name: 'Carlos Sardo', role: 'Dev Lead', charter: '—', badge: '👤 Human', kind: 'human' },
    ],
    codingAgent: { id: 'copilot', name: '@copilot', role: 'Coding Agent', charter: '—', badge: '🤖 Coding Agent', kind: 'coding' },
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    activity: [],
    ...overrides,
  };
}

function initializedStore(options = {}, initialFiles = filesSnapshot()) {
  const store = createDashboardStore({ projectRoot: '/project', now: () => baseMs, ...options });
  store.initializeFromFiles(initialFiles);
  return store;
}

function agentById(store, id) {
  const agent = store.getSnapshot().agents.find((candidate) => candidate.id === id);
  assert.ok(agent, `expected agent ${id} in snapshot`);
  return agent;
}

test('task and subagent lifecycle tracks status, tools, counters, completion, and TTL idle', () => {
  let now = baseMs;
  const store = createDashboardStore({ projectRoot: '/project', now: () => now, doneTtlMs: 1000, waitingAfterMs: 10_000 });
  store.initializeFromFiles(filesSnapshot());

  store.ingestSessionEvent(event('task-object', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-frontend',
    arguments: { name: 'Frontend', description: 'Frontend: Building UI', prompt: 'Build UI' },
  }));
  assert.equal(agentById(store, 'frontend').status, 'spawning');
  assert.equal(agentById(store, 'frontend').taskToolCallId, 'call-frontend');

  store.ingestSessionEvent(event('task-json', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-tester',
    arguments: JSON.stringify({ name: 'Tester', description: 'Tester: Writing tests', prompt: 'Write tests' }),
  }, { at: 10 }));
  assert.equal(agentById(store, 'tester').status, 'spawning');
  assert.equal(agentById(store, 'tester').taskToolCallId, 'call-tester');

  store.ingestSessionEvent(event('front-started', 'subagent.started', {
    toolCallId: 'call-frontend',
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
    agentDescription: 'Frontend: Building UI',
    agentType: 'task',
    executionMode: 'sync',
    model: 'gpt-5.4',
  }, { at: 20, agentId: 'ag-front' }));
  let frontend = agentById(store, 'frontend');
  assert.equal(frontend.status, 'working');
  assert.equal(frontend.runtimeAgentId, 'ag-front');
  assert.equal(frontend.model, 'gpt-5.4');
  assert.equal(frontend.mode, 'sync');

  const toolStart = event('front-tool-start', 'tool.execution_start', {
    toolName: 'bash',
    toolCallId: 'tool-1',
  }, { at: 30, agentId: 'ag-front' });
  store.ingestSessionEvent(toolStart);
  store.ingestSessionEvent(toolStart);
  store.ingestSessionEvent(event('front-tool-start-duplicate-call', 'tool.execution_start', {
    toolName: 'bash',
    toolCallId: 'tool-1',
  }, { at: 35, agentId: 'ag-front' }));
  frontend = agentById(store, 'frontend');
  assert.equal(frontend.currentTool, 'bash');
  assert.equal(frontend.counters.toolCalls, 1);

  store.ingestSessionEvent(event('front-tool-complete', 'tool.execution_complete', {
    toolCallId: 'tool-1',
    success: true,
  }, { at: 40, agentId: 'ag-front' }));
  frontend = agentById(store, 'frontend');
  assert.equal(frontend.currentTool, undefined);
  assert.equal(frontend.counters.toolCalls, 1);

  store.ingestSessionEvent(event('front-complete', 'subagent.completed', {
    toolCallId: 'call-frontend',
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
    model: 'gpt-5.4',
    totalToolCalls: 1,
  }, { at: 50, agentId: 'ag-front' }));
  frontend = agentById(store, 'frontend');
  assert.equal(frontend.status, 'done');
  assert.equal(frontend.counters.completedTasks, 1);

  store.ingestSessionEvent(event('front-late-tool-start', 'tool.execution_start', {
    toolName: 'view',
    toolCallId: 'tool-late',
  }, { at: 60, agentId: 'ag-front' }));
  frontend = agentById(store, 'frontend');
  assert.equal(frontend.status, 'done');
  assert.equal(frontend.currentTool, undefined);
  assert.equal(frontend.counters.toolCalls, 2);

  store.ingestSessionEvent(event('front-complete-2', 'subagent.completed', {
    toolCallId: 'call-frontend',
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
    model: 'gpt-5.4',
  }, { at: 70, agentId: 'ag-front' }));

  now = baseMs + 70 + 1001;
  assert.equal(agentById(store, 'frontend').status, 'idle');
});

test('failed, waiting, unknown agents, and coordinator state follow session events', () => {
  let now = baseMs;
  const store = createDashboardStore({ projectRoot: '/project', now: () => now, waitingAfterMs: 1000, doneTtlMs: 60_000 });
  store.initializeFromFiles(filesSnapshot());

  store.ingestSessionEvent(event('unknown-started', 'subagent.started', {
    toolCallId: 'call-scribe',
    agentName: 'scribe',
    agentDisplayName: 'Scribe',
    agentDescription: 'Scribe: Logging',
    executionMode: 'background',
    model: 'gpt-5-mini',
  }, { at: 0, agentId: 'ag-scribe' }));
  const scribe = agentById(store, 'scribe');
  assert.equal(scribe.roster, false);
  assert.equal(scribe.kind, 'unknown');
  assert.equal(scribe.status, 'working');

  store.ingestSessionEvent(event('fail-started', 'subagent.started', {
    toolCallId: 'call-backend',
    agentName: 'Backend',
    agentDisplayName: 'Backend',
    agentDescription: 'Backend: API',
  }, { at: 10, agentId: 'ag-backend' }));
  store.ingestSessionEvent(event('fail-event', 'subagent.failed', {
    toolCallId: 'call-backend',
    agentName: 'Backend',
    agentDisplayName: 'Backend',
    error: 'boom',
  }, { at: 20, agentId: 'ag-backend' }));
  const failed = agentById(store, 'backend');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
  assert.equal(failed.counters.failedTasks, 1);

  store.ingestSessionEvent(event('tester-task', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-tester',
    arguments: { name: 'Tester', description: 'Tester: Waiting check' },
  }, { at: 30 }));
  store.ingestSessionEvent(event('tester-started', 'subagent.started', {
    toolCallId: 'call-tester',
    agentName: 'Tester',
    agentDisplayName: 'Tester',
    agentDescription: 'Tester: Waiting check',
  }, { at: 40, agentId: 'ag-tester' }));
  now = baseMs + 1041;
  assert.equal(agentById(store, 'tester').status, 'waiting');

  store.ingestSessionEvent(event('turn-start', 'assistant.turn_start', { turnId: '1', model: 'gpt-5.4' }, { at: 1100 }));
  assert.equal(store.getSnapshot().coordinator.status, 'thinking');
  assert.equal(store.getSnapshot().coordinator.model, 'gpt-5.4');
  store.ingestSessionEvent(event('idle', 'session.idle', { mode: 'autopilot' }, { at: 1200 }));
  assert.equal(store.getSnapshot().coordinator.status, 'idle');
});

test('usage accounting aggregates coordinator and agent usage by prompt and model', () => {
  const store = initializedStore({}, filesSnapshot({ pricingUsdPerAiu: 1.5 }));
  const deltas = [];
  store.subscribe((delta) => deltas.push(delta));

  store.ingestSessionEvent(event('prompt-1', 'user.message', { content: `Ship the dashboard ${'x'.repeat(150)}` }, { at: 1 }));
  store.ingestSessionEvent(event('turn-1', 'assistant.turn_start', { model: 'gpt-5.4' }, { at: 2 }));
  store.ingestSessionEvent(event('spawn-1', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-frontend',
    arguments: { name: 'Frontend', description: 'Frontend: Compact cards', prompt: 'Compact cards', mode: 'background', model: 'gpt-5-mini' },
  }, { at: 3 }));
  store.ingestSessionEvent(event('subagent-1', 'subagent.started', {
    toolCallId: 'call-frontend',
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
    agentDescription: 'Frontend: Compact cards',
    executionMode: 'background',
    model: 'gpt-5-mini',
  }, { at: 4, agentId: 'ag-front' }));

  store.ingestSessionEvent(event('usage-coord-1', 'assistant.usage', {
    model: 'gpt-5.4',
    inputTokens: 100,
    outputTokens: 25,
    apiCallId: 'api-coord-1',
    copilotUsage: { totalNanoAiu: 200 },
  }, { at: 5 }));

  store.ingestSessionEvent(event('usage-agent-1', 'assistant.usage', {
    model: 'gpt-5-mini',
    inputTokens: 80,
    outputTokens: 20,
    apiCallId: 'api-agent-1',
    copilotUsage: { totalNanoAiu: 50 },
  }, { at: 6, agentId: 'ag-front' }));

  store.ingestSessionEvent(event('usage-agent-1b', 'assistant.usage', {
    model: 'gpt-5-mini',
    inputTokens: 110,
    outputTokens: 40,
    apiCallId: 'api-agent-1',
    copilotUsage: { totalNanoAiu: 90 },
  }, { at: 7, agentId: 'ag-front' }));

  store.ingestSessionEvent(event('checkpoint-1', 'session.usage_checkpoint', {
    totalNanoAiu: 500,
    totalPremiumRequests: 2,
    modelCacheState: new Array(100).fill({ nope: true }),
    promptCacheBreakState: new Array(100).fill({ nope: true }),
  }, { at: 8 }));
  store.ingestSessionEvent(event('idle-1', 'session.idle', {}, { at: 9 }));

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.usage.session.inputTokens, 180);
  assert.equal(snapshot.usage.session.outputTokens, 45);
  assert.equal(snapshot.usage.session.totalTokens, 225);
  assert.equal(snapshot.usage.session.nanoAiu, 250);
  assert.equal(snapshot.usage.session.requests, 2);
  assert.equal(snapshot.usage.sessionNanoAiuAuthoritative, 500);
  assert.equal(snapshot.usage.premiumRequests, 2);
  assert.equal(snapshot.usage.pricing.unitLabel, 'AIU');
  assert.equal(snapshot.usage.pricing.nanoPerUnit, 1_000_000_000);
  assert.equal(snapshot.usage.pricing.usdPerUnit, 1.5);
  assert.equal(snapshot.usage.meta.partial, true);
  assert.equal(snapshot.coordinator.usage.totalTokens, 125);
  assert.equal(agentById(store, 'frontend').usage.total.totalTokens, 100);
  assert.equal(agentById(store, 'frontend').usage.run.totalTokens, 100);
  assert.equal(agentById(store, 'frontend').usage.estimated, false);
  assert.equal(snapshot.usage.byModel['gpt-5.4'].totalTokens, 125);
  assert.equal(snapshot.usage.byModel['gpt-5-mini'].totalTokens, 100);
  assert.equal(snapshot.usage.prompts.length, 1);
  assert.equal(snapshot.usage.prompts[0].text.length, 120);
  assert.equal(snapshot.usage.prompts[0].totals.totalTokens, 225);
  assert.equal(snapshot.usage.prompts[0].byAgent.coordinator.totalTokens, 125);
  assert.equal(snapshot.usage.prompts[0].byAgent.frontend.totalTokens, 100);
  assert.equal(snapshot.usage.activePromptId, undefined);
  assert.ok(deltas.some((delta) => delta.type === 'prompt.updated' && delta.prompt?.id === 'prompt-1'));
  assert.ok(deltas.some((delta) => delta.type === 'usage.updated'));
});

test('estimated token backfill is replaced by live assistant usage for the same run', () => {
  const store = initializedStore();
  store.ingestSessionEvent(event('spawn', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-tester',
    arguments: { name: 'Tester', description: 'Tester: Cost view' },
  }, { at: 1 }));
  store.ingestSessionEvent(event('start', 'subagent.started', {
    toolCallId: 'call-tester',
    agentName: 'Tester',
    agentDisplayName: 'Tester',
    agentDescription: 'Tester: Cost view',
  }, { at: 2, agentId: 'ag-tester' }));
  store.ingestSessionEvent(event('complete', 'subagent.completed', {
    toolCallId: 'call-tester',
    agentName: 'Tester',
    agentDisplayName: 'Tester',
    totalTokens: 123,
    model: 'gpt-5-mini',
  }, { at: 3, agentId: 'ag-tester' }));

  let tester = agentById(store, 'tester');
  assert.equal(tester.usage.run.totalTokens, 0);
  assert.equal(tester.usage.run.estimatedTokens, 123);
  assert.equal(tester.usage.run.estimated, true);
  assert.equal(tester.usage.total.totalTokens, 0);
  assert.equal(tester.usage.total.estimatedTokens, 123);
  assert.equal(tester.usage.total.estimated, true);
  assert.equal(tester.usage.estimated, true);
  assert.equal(store.getSnapshot().usage.meta.partial, true);

  store.ingestSessionEvent(event('live-usage', 'assistant.usage', {
    model: 'gpt-5-mini',
    inputTokens: 70,
    outputTokens: 20,
    apiCallId: 'api-late',
    copilotUsage: { totalNanoAiu: 33 },
  }, { at: 2, agentId: 'ag-tester' }));

  tester = agentById(store, 'tester');
  assert.equal(tester.usage.run.totalTokens, 90);
  assert.equal(tester.usage.run.estimatedTokens, undefined);
  assert.equal(tester.usage.run.estimated, undefined);
  assert.equal(tester.usage.total.totalTokens, 90);
  assert.equal(tester.usage.total.estimatedTokens, undefined);
  assert.equal(tester.usage.total.estimated, undefined);
  assert.equal(tester.usage.estimated, false);
});

test('activity feed is bounded, newest-first, and duplicate event ids are ignored', () => {
  const store = initializedStore({ maxFeed: 3 });
  const duplicate = event('dup-tool', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-dup',
    arguments: { name: 'Frontend', description: 'Frontend: duplicate test' },
  });
  store.ingestSessionEvent(duplicate);
  const afterFirst = store.getSnapshot().activity.length;
  store.ingestSessionEvent(duplicate);
  assert.equal(store.getSnapshot().activity.length, afterFirst);

  for (let i = 0; i < 5; i += 1) {
    store.ingestFileEvent({ type: 'file.created', path: `.squad/log/${i}.md`, kind: 'log', timestamp: iso(1000 + i) });
  }

  const activity = store.getSnapshot().activity;
  assert.equal(activity.length, 3);
  assert.deepEqual(
    activity.map((item) => item.timestamp),
    [...activity.map((item) => item.timestamp)].sort().reverse(),
  );
});

test('subscribe receives deltas, unsubscribe stops them, and setNote persists', () => {
  const store = initializedStore();
  const deltas = [];
  const unsubscribe = store.subscribe((delta) => deltas.push(delta));

  const updated = store.setNote('frontend', 'Needs visual QA');
  assert.equal(updated.note, 'Needs visual QA');
  assert.equal(agentById(store, 'frontend').note, 'Needs visual QA');
  assert.equal(deltas.some((delta) => delta.type === 'agent.updated' && delta.agent?.id === 'frontend'), true);

  const count = deltas.length;
  unsubscribe();
  store.setNote('frontend', 'No listener should receive this');
  assert.equal(deltas.length, count);

  assert.equal(store.setNote('not-a-real-agent', 'No phantom'), null);
  assert.equal(store.getSnapshot().agents.some((agent) => agent.id === 'not-a-real-agent'), false);
});

test('getSnapshot is cached until state or time-based derivation changes', () => {
  let now = baseMs;
  const store = createDashboardStore({ projectRoot: '/project', now: () => now, doneTtlMs: 1000 });
  store.initializeFromFiles(filesSnapshot());
  const snapshotA = store.getSnapshot();
  const snapshotB = store.getSnapshot();
  assert.equal(snapshotA, snapshotB);

  store.ingestSessionEvent(event('spawn', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-frontend',
    arguments: { name: 'Frontend', description: 'Frontend: Cache test' },
  }, { at: 1 }));
  store.ingestSessionEvent(event('start', 'subagent.started', {
    toolCallId: 'call-frontend',
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
    agentDescription: 'Frontend: Cache test',
  }, { at: 2, agentId: 'ag-front' }));
  store.ingestSessionEvent(event('done', 'subagent.completed', {
    toolCallId: 'call-frontend',
    agentName: 'Frontend',
    agentDisplayName: 'Frontend',
  }, { at: 3, agentId: 'ag-front' }));
  const snapshotC = store.getSnapshot();
  const snapshotD = store.getSnapshot();
  assert.equal(snapshotC, snapshotD);

  now = baseMs + 2005;
  const snapshotE = store.getSnapshot();
  assert.notEqual(snapshotD, snapshotE);
  assert.equal(agentById(store, 'frontend').status, 'idle');
});

test('snapshot exposes schemaVersion 1 and required top-level keys', () => {
  const snapshot = initializedStore().getSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  for (const key of ['generatedAt', 'projectRoot', 'noSquad', 'coordinator', 'agents', 'activity', 'files', 'usage', 'meta']) {
    assert.ok(Object.hasOwn(snapshot, key), `missing snapshot key ${key}`);
  }
  assert.equal(snapshot.meta.source, 'live');
  assert.equal(Array.isArray(snapshot.meta.errors), true);
  assert.deepEqual(snapshot.usage.session, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    nanoAiu: 0,
    premiumRequests: 0,
    requests: 0,
  });
});
