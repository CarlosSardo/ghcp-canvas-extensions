import test from 'node:test';
import assert from 'node:assert/strict';

import { createDashboardStore } from '../lib/store.mjs';

const baseMs = Date.parse('2026-09-30T08:32:12.000+02:00');

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
      { id: 'frontend', name: 'Frontend', role: 'Frontend Dev', badge: '⚛️ Frontend', kind: 'member' },
      { id: 'tester', name: 'Tester', role: 'Tester', badge: '🧪 Tester', kind: 'member' },
    ],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    activity: [],
    errors: [],
  };
}

test('store performance smoke: 50k mixed events fold quickly and snapshot stays cheap', { timeout: 60000 }, (t) => {
  const store = createDashboardStore({ projectRoot: '/project', now: () => baseMs });
  store.initializeFromFiles(filesSnapshot());

  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  for (let index = 0; index < 50_000; index += 5) {
    const batch = index / 5;
    const agentName = batch % 2 === 0 ? 'Frontend' : 'Tester';
    const runtimeAgentId = batch % 2 === 0 ? 'ag-front' : 'ag-tester';
    const toolCallId = `call-${batch}`;
    const at = batch;

    store.ingestSessionEvent(event(`prompt-${batch}`, 'user.message', { content: `Prompt ${batch}` }, { at }));
    store.ingestSessionEvent(event(`task-${batch}`, 'tool.execution_start', {
      toolName: 'task',
      toolCallId,
      arguments: { name: agentName, description: `${agentName}: batch ${batch}`, model: 'gpt-5.4', mode: 'background' },
    }, { at: at + 1 }));
    store.ingestSessionEvent(event(`started-${batch}`, 'subagent.started', {
      toolCallId,
      agentName,
      agentDisplayName: agentName,
      agentDescription: `${agentName}: batch ${batch}`,
      model: 'gpt-5.4',
      executionMode: 'background',
    }, { at: at + 2, agentId: runtimeAgentId }));
    store.ingestSessionEvent(event(`usage-${batch}`, 'assistant.usage', {
      model: 'gpt-5.4',
      inputTokens: 1,
      outputTokens: 2,
      copilotUsage: { totalNanoAiu: 3 },
      apiCallId: `api-${batch}`,
    }, { at: at + 3, agentId: runtimeAgentId }));
    store.ingestSessionEvent(event(`completed-${batch}`, 'subagent.completed', {
      toolCallId,
      agentName,
      agentDisplayName: agentName,
      model: 'gpt-5.4',
      totalTokens: 3,
      totalToolCalls: 1,
    }, { at: at + 4, agentId: runtimeAgentId }));
  }
  const foldMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStartedAt);
  const foldCpuMs = (cpu.user + cpu.system) / 1000;
  const budgetMs = Number(process.env.SQUAD_DASHBOARD_PERF_BUDGET_MS || 30000);
  assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, 'SQUAD_DASHBOARD_PERF_BUDGET_MS must be a positive number when set');
  t.diagnostic(`folded 50k events in ${foldCpuMs.toFixed(1)}ms CPU / ${foldMs.toFixed(1)}ms wall; budget ${budgetMs}ms CPU`);
  assert.ok(foldCpuMs < budgetMs, `folding 50k mixed events should stay under ${budgetMs}ms CPU (cpu ${foldCpuMs.toFixed(1)}ms, wall ${foldMs.toFixed(1)}ms)`);

  const snapshotStartedAt = performance.now();
  const snapshot = store.getSnapshot();
  const snapshotMs = performance.now() - snapshotStartedAt;
  assert.ok(snapshotMs < 50, `snapshot building should stay under 50ms after the fold (took ${snapshotMs.toFixed(1)}ms)`);
  assert.equal(snapshot.schemaVersion, 1);
});
