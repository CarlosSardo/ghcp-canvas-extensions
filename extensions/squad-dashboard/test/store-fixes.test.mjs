import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createDashboardStore } from '../lib/store.mjs';
import { parseTeamMarkdown, readSquadFiles } from '../lib/squad-files.mjs';
import { makeScratch } from './helpers/scratch.mjs';

const baseMs = Date.parse('2026-09-30T08:00:00.000Z');

function iso(offsetMs = 0) {
  return new Date(baseMs + offsetMs).toISOString();
}

function event(id, type, data = {}, { at = 0, agentId } = {}) {
  return { id, type, timestamp: iso(at), data, ...(agentId ? { agentId } : {}) };
}

function storeWithRoster(nowRef = { value: baseMs }) {
  const store = createDashboardStore({ projectRoot: '/project', now: () => nowRef.value, doneTtlMs: 60_000 });
  store.initializeFromFiles({
    projectRoot: '/project',
    noSquad: false,
    roster: [{ id: 'lead', name: 'Lead', role: 'Lead', kind: 'member' }],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    activity: [],
    errors: [],
  });
  return store;
}

function agentById(store, id) {
  const agent = store.getSnapshot().agents.find((candidate) => candidate.id === id);
  assert.ok(agent, `expected agent ${id}`);
  return agent;
}

test('applyLiveUsageMetrics updates usage monotonically and emits only on change', () => {
  const store = storeWithRoster();
  const messages = [];
  store.subscribe((message) => messages.push(message));

  store.applyLiveUsageMetrics({
    totalNanoAiu: '1000',
    premiumRequests: 2,
    byModel: { 'gpt-test': { requests: 2, premiumRequests: 1, nanoAiu: 900n, inputTokens: 10, outputTokens: 4 } },
    fetchedAt: iso(10),
  });
  let usage = store.getSnapshot().usage;
  assert.equal(usage.sessionNanoAiuAuthoritative, 1000);
  assert.equal(usage.premiumRequests, 2);
  assert.equal(usage.byModel['gpt-test'].requests, 2);
  assert.equal(usage.byModel['gpt-test'].premiumRequests, 1);
  assert.equal(usage.byModel['gpt-test'].totalTokens, 14);
  assert.equal(messages.filter((message) => message.type === 'usage.updated').length, 1);

  store.applyLiveUsageMetrics({ totalNanoAiu: 999, premiumRequests: 1, byModel: { 'gpt-test': { requests: 1, nanoAiu: 800 } } });
  usage = store.getSnapshot().usage;
  assert.equal(usage.sessionNanoAiuAuthoritative, 1000);
  assert.equal(usage.premiumRequests, 2);
  assert.equal(usage.byModel['gpt-test'].requests, 2);
  assert.equal(messages.filter((message) => message.type === 'usage.updated').length, 1);
});

test('setBackfillProgress updates snapshot meta, legacy eventBackfill, and meta.updated', () => {
  const nowRef = { value: baseMs };
  const store = storeWithRoster(nowRef);
  const messages = [];
  store.subscribe((message) => messages.push(message));

  store.setBackfillProgress({ state: 'pending', processed: 0, total: 10 });
  assert.equal(store.getSnapshot().meta.backfill.state, 'pending');
  assert.equal(store.getSnapshot().meta.eventBackfill, false);
  assert.equal(messages.at(-1).type, 'meta.updated');

  nowRef.value += 100;
  store.setBackfillProgress({ state: 'running', processed: 1, total: 10 });
  assert.equal(store.getSnapshot().meta.backfill.state, 'running');
  assert.equal(messages.at(-1).meta.backfill.state, 'running');

  nowRef.value += 100;
  store.setBackfillProgress({ state: 'running', processed: 2, total: 10 });
  assert.equal(messages.filter((message) => message.type === 'meta.updated').length, 2);

  nowRef.value += 100;
  store.setBackfillProgress({ state: 'done', processed: 10, total: 10 });
  assert.equal(store.getSnapshot().meta.eventBackfill, true);
  assert.equal(messages.at(-1).meta.backfill.state, 'done');
});

test('terminal runtime guard keeps late tool and usage events from reopening or charging old runs', () => {
  const store = storeWithRoster();
  store.ingestSessionEvent(event('task', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-lead',
    arguments: { name: 'Lead', description: 'Lead: design' },
  }));
  store.ingestSessionEvent(event('started', 'subagent.started', {
    toolCallId: 'call-lead',
    agentName: 'Lead',
    agentDisplayName: 'Lead',
  }, { at: 10, agentId: 'runtime-lead' }));
  store.ingestSessionEvent(event('completed', 'subagent.completed', {
    toolCallId: 'call-lead',
    agentName: 'Lead',
    agentDisplayName: 'Lead',
  }, { at: 20, agentId: 'runtime-lead' }));

  store.ingestSessionEvent(event('late-tool', 'tool.execution_start', { toolName: 'bash', toolCallId: 'late-tool' }, { at: 30, agentId: 'runtime-lead' }));
  store.ingestSessionEvent(event('late-usage', 'assistant.usage', {
    model: 'gpt-test',
    inputTokens: 8,
    outputTokens: 2,
    apiCallId: 'usage-after-terminal',
  }, { at: 40, agentId: 'runtime-lead' }));

  let lead = agentById(store, 'lead');
  assert.equal(lead.status, 'done');
  assert.equal(lead.currentTool, undefined);
  assert.equal(lead.counters.toolCalls, 1);
  assert.equal(lead.usage.total.totalTokens, 0);
  assert.equal(store.getSnapshot().usage.session.totalTokens, 10);

  store.ingestSessionEvent(event('wake', 'user.message', { content: 'follow-up' }, { at: 50, agentId: 'runtime-lead' }));
  lead = agentById(store, 'lead');
  assert.equal(lead.status, 'working');
});

test('session.shutdown metrics are ingested as monotonic authoritative totals', () => {
  const store = storeWithRoster();
  store.ingestSessionEvent(event('shutdown-1', 'session.shutdown', {
    totalNanoAiu: '5000',
    modelMetrics: {
      'gpt-test': { totalNanoAiu: 4000, totalInputTokens: 12, totalOutputTokens: 5, totalUserRequests: 3 },
    },
  }));
  store.ingestSessionEvent(event('shutdown-2', 'session.shutdown', {
    totalNanoAiu: 4500,
    modelMetrics: {
      'gpt-test': { totalNanoAiu: 3000, totalInputTokens: 10, totalOutputTokens: 4, totalUserRequests: 2 },
    },
  }));

  const usage = store.getSnapshot().usage;
  assert.equal(usage.sessionNanoAiuAuthoritative, 5000);
  assert.equal(usage.byModel['gpt-test'].nanoAiu, 4000);
  assert.equal(usage.byModel['gpt-test'].requests, 3);
  assert.equal(usage.byModel['gpt-test'].totalTokens, 17);
});

test('estimated completion tokens stay separate from input plus output totals', () => {
  const store = storeWithRoster();
  store.ingestSessionEvent(event('prompt', 'user.message', { content: 'estimate work' }));
  store.ingestSessionEvent(event('task', 'tool.execution_start', {
    toolName: 'task',
    toolCallId: 'call-lead',
    arguments: { name: 'Lead', description: 'Lead: estimate' },
  }, { at: 1 }));
  store.ingestSessionEvent(event('started', 'subagent.started', {
    toolCallId: 'call-lead',
    agentName: 'Lead',
    agentDisplayName: 'Lead',
    model: 'gpt-test',
  }, { at: 2, agentId: 'runtime-lead' }));
  store.ingestSessionEvent(event('completed', 'subagent.completed', {
    toolCallId: 'call-lead',
    agentName: 'Lead',
    agentDisplayName: 'Lead',
    totalTokens: 38131267,
    model: 'gpt-test',
  }, { at: 3, agentId: 'runtime-lead' }));

  const snapshot = store.getSnapshot();
  const lead = agentById(store, 'lead');
  assert.equal(lead.usage.total.inputTokens + lead.usage.total.outputTokens, lead.usage.total.totalTokens);
  assert.equal(lead.usage.run.inputTokens + lead.usage.run.outputTokens, lead.usage.run.totalTokens);
  assert.equal(lead.usage.total.totalTokens, 0);
  assert.equal(lead.usage.run.totalTokens, 0);
  assert.equal(lead.usage.total.estimatedTokens, 38131267);
  assert.equal(lead.usage.run.estimatedTokens, 38131267);
  assert.equal(lead.usage.total.estimated, true);
  assert.equal(lead.usage.run.estimated, true);
  assert.equal(snapshot.usage.session.totalTokens, 0);
  assert.equal(snapshot.usage.session.estimatedTokens, 38131267);
  assert.equal(snapshot.usage.byModel['gpt-test'].totalTokens, 0);
  assert.equal(snapshot.usage.byModel['gpt-test'].estimatedTokens, 38131267);
  assert.equal(snapshot.usage.prompts[0].totals.totalTokens, 0);
  assert.equal(snapshot.usage.prompts[0].totals.estimatedTokens, 38131267);
  assert.equal(snapshot.usage.prompts[0].byAgent.lead.totalTokens, 0);
  assert.equal(snapshot.usage.prompts[0].byAgent.lead.estimatedTokens, 38131267);
  assert.equal(snapshot.usage.prompts[0].byAgent.lead.estimated, true);
});

test('setNote returns null and does not create an agent for unknown ids', () => {
  const store = storeWithRoster();
  const before = store.getSnapshot().agents.map((agent) => agent.id);
  assert.equal(store.setNote('e2e-note', 'do not create'), null);
  assert.deepEqual(store.getSnapshot().agents.map((agent) => agent.id), before);
});

test('derived timer emits targeted deltas, not snapshot storms or zero-delay loops', async () => {
  const nowRef = { value: baseMs };
  const store = createDashboardStore({
    projectRoot: '/project',
    now: () => nowRef.value,
    idleAfterMs: 10,
    waitingAfterMs: 10,
    doneTtlMs: 10,
  });
  store.initializeFromFiles({
    projectRoot: '/project',
    noSquad: false,
    roster: [
      { id: 'lead', name: 'Lead', role: 'Lead', kind: 'member' },
      { id: 'tester', name: 'Tester', role: 'Tester', kind: 'member' },
    ],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    activity: [],
    errors: [],
  });

  const messages = [];
  store.subscribe((message) => messages.push(message));
  store.ingestSessionEvent(event('turn-start', 'assistant.turn_start', { model: 'gpt-test' }, { at: 0 }));
  for (const [name, runtimeAgentId, at] of [['Lead', 'runtime-lead', 1], ['Tester', 'runtime-tester', 2]]) {
    store.ingestSessionEvent(event(`task-${name}`, 'tool.execution_start', {
      toolName: 'task',
      toolCallId: `call-${name}`,
      arguments: { name, description: `${name}: derived` },
    }, { at }));
    store.ingestSessionEvent(event(`started-${name}`, 'subagent.started', {
      toolCallId: `call-${name}`,
      agentName: name,
      agentDisplayName: name,
    }, { at: at + 1, agentId: runtimeAgentId }));
  }

  for (let index = 0; index < 8; index += 1) {
    nowRef.value = baseMs + 30 + index;
    store.ingestSessionEvent(event(`usage-${index}`, 'assistant.usage', {
      inputTokens: 1,
      outputTokens: 1,
      apiCallId: `api-${index}`,
    }, { at: 3 + index }));
  }

  assert.equal(messages.some((message) => message.type === 'snapshot'), false, 'ingest must not emit snapshots');
  nowRef.value = baseMs + 50;
  await delay(700);

  const snapshots = messages.filter((message) => message.type === 'snapshot');
  const agentUpdates = messages.filter((message) => message.type === 'agent.updated');
  const coordinatorUpdates = messages.filter((message) => message.type === 'coordinator.updated');
  assert.equal(snapshots.length, 0, 'derived timer must not emit full snapshots');
  assert.ok(coordinatorUpdates.some((message) => message.coordinator.status === 'idle'), 'coordinator derived idle should emit coordinator.updated');
  assert.ok(agentUpdates.some((message) => message.agent.id === 'lead' && message.agent.status === 'waiting'), 'lead derived waiting should emit agent.updated');
  assert.ok(agentUpdates.some((message) => message.agent.id === 'tester' && message.agent.status === 'waiting'), 'tester derived waiting should emit agent.updated');
  assert.ok(
    coordinatorUpdates.length + agentUpdates.filter((message) => ['lead', 'tester'].includes(message.agent.id) && message.agent.status === 'waiting').length <= 3,
    'derived timer should apply each transition once without a zero-delay loop',
  );
});

test('parseTeamMarkdown preserves escaped pipes in table cells', () => {
  const parsed = parseTeamMarkdown(`# Team\n\n## Members\n\n| Name | Role | Charter | Status |\n|---|---|---|---|\n| Lead | Lead \\| Architect | .squad/agents/lead/charter.md | 🏗️ Lead |\n`);
  assert.equal(parsed.roster[0].role, 'Lead | Architect');
  assert.equal(parsed.roster[0].charter, '.squad/agents/lead/charter.md');
  assert.equal(parsed.roster[0].badge, '🏗️ Lead');
});

test('readSquadFiles skips symlinked singleton summaries', async () => {
  const scratch = await makeScratch('store-fixes');
  try {
    const root = scratch.dir;
    await mkdir(join(root, '.squad', 'identity'), { recursive: true });
    await writeFile(join(root, '.squad', 'team.md'), `# Team\n\n## Members\n\n| Name | Role | Charter | Status |\n|---|---|---|---|\n| Lead | Lead | .squad/agents/lead/charter.md | 🏗️ Lead |\n`);
    await writeFile(join(root, 'outside.md'), '# Outside singleton heading\n');
    await symlink(join(root, 'outside.md'), join(root, '.squad', 'decisions.md'));
    await symlink(join(root, 'outside.md'), join(root, '.squad', 'identity', 'now.md'));

    const snapshot = await readSquadFiles(root, { maxItems: 10 });
    assert.equal(snapshot.activity.some((item) => item.text === 'Outside singleton heading'), false);
  } finally {
    await scratch.cleanup();
  }
});
