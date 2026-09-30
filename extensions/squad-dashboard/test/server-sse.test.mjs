import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { createDashboardServer } from '../lib/server.mjs';
import { createDashboardStore } from '../lib/store.mjs';
import { makeScratch } from './helpers/scratch.mjs';
import { waitFor } from './helpers/wait.mjs';

const QUIET_MARGIN_MS = 100;

async function observeQuietPeriod(assertion, { duration, margin = QUIET_MARGIN_MS, interval = 25 } = {}) {
  const deadline = Date.now() + duration + margin;
  while (Date.now() < deadline) {
    assertion();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  assertion();
}

function largeSnapshot(size = 96 * 1024) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectRoot: '/project',
    noSquad: false,
    coordinator: { status: 'idle' },
    agents: [],
    activity: [],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    usage: { session: {}, byModel: {}, prompts: [], pricing: { unitLabel: 'AIU', nanoPerUnit: 1e9 }, meta: {} },
    meta: { source: 'test', eventBackfill: true, errors: [], padding: 'x'.repeat(size) },
  };
}

function makeStore(snapshot = largeSnapshot()) {
  const listeners = new Set();
  return {
    getSnapshot() {
      return { ...snapshot, generatedAt: new Date().toISOString() };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      for (const listener of listeners) listener(message);
    },
  };
}

async function createFixture({ store = makeStore(), timers } = {}) {
  const scratch = await makeScratch('server-sse');
  const uiDir = path.join(scratch.dir, 'ui');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><html><body>dashboard</body></html>');
  let server;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  if (timers) {
    globalThis.setInterval = timers.setInterval;
    globalThis.clearInterval = timers.clearInterval;
  }
  function restoreTimers() {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  try {
    server = await createDashboardServer({ store, uiDir, log: () => {} });
  } catch (error) {
    restoreTimers();
    await scratch.cleanup();
    throw error;
  }
  return {
    server,
    store,
    async cleanup() {
      try {
        await server?.close();
        await scratch.cleanup();
      } finally {
        restoreTimers();
      }
    },
  };
}

function openSse(baseUrl, { paused = false } = {}) {
  const url = new URL(baseUrl);
  const events = [];
  let buffer = '';
  let response;
  const req = http.get({
    hostname: url.hostname,
    port: url.port,
    path: '/events',
    headers: { Accept: 'text/event-stream' },
  });
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary).replace(/\r/g, '');
          buffer = buffer.slice(boundary + 2);
          const event = block.match(/^event:\s*(.+)$/m)?.[1] ?? 'message';
          const dataText = [...block.matchAll(/^data:\s*(.*)$/gm)].map((match) => match[1]).join('\n');
          events.push({ event, data: dataText ? JSON.parse(dataText) : null });
          boundary = buffer.indexOf('\n\n');
        }
      });
      if (paused) res.pause();
      resolve(res);
    });
    req.on('error', reject);
  });
  return {
    events,
    ready,
    resume() {
      response?.resume();
    },
    pause() {
      response?.pause();
    },
    close() {
      req.destroy();
    },
  };
}

function emitAgentChange(store, id = 'agent-1') {
  store.emit({
    type: 'agent.updated',
    agent: {
      id,
      name: id,
      status: 'working',
      counters: { toolCalls: 1, completedTasks: 0, failedTasks: 0 },
      usage: { total: {}, run: {}, estimated: false },
    },
  });
}

function emitLargeAgentChange(store, id = 'agent-large') {
  store.emit({
    type: 'agent.updated',
    agent: {
      id,
      name: id,
      status: 'working',
      currentTask: 'x'.repeat(512 * 1024),
      counters: { toolCalls: 1, completedTasks: 0, failedTasks: 0 },
      usage: { total: {}, run: {}, estimated: false },
    },
  });
}

function realisticEvent(id, type, data = {}, { at = Date.now(), agentId } = {}) {
  return {
    id,
    type,
    timestamp: new Date(at).toISOString(),
    parentId: null,
    data,
    ...(agentId ? { agentId } : {}),
  };
}

function feedRealisticLiveEvents(store, { count = 200, durationMs = 3_000 } = {}) {
  const started = Date.now();
  for (let index = 0; index < count; index += 1) {
    const agentIndex = index % 5;
    const agentId = `runtime-${agentIndex}`;
    const toolCallId = `tool-${agentIndex}-${Math.floor(index / 5)}`;
    const timestamp = started + Math.floor((index / count) * durationMs);
    const kind = index % 6;
    if (kind === 0) {
      store.ingestSessionEvent(realisticEvent(`sub-${index}`, 'subagent.started', {
        toolCallId: `spawn-${agentIndex}`,
        agentName: `Agent ${agentIndex}`,
        agentDisplayName: `Agent ${agentIndex}`,
        agentDescription: `Agent ${agentIndex}: working`,
        model: 'gpt-5.4',
      }, { at: timestamp, agentId }));
    } else if (kind === 1) {
      store.ingestSessionEvent(realisticEvent(`tool-start-${index}`, 'tool.execution_start', {
        toolCallId,
        toolName: 'bash',
      }, { at: timestamp, agentId }));
    } else if (kind === 2) {
      store.ingestSessionEvent(realisticEvent(`tool-end-${index}`, 'tool.execution_complete', {
        toolCallId,
        success: true,
      }, { at: timestamp, agentId }));
    } else if (kind === 3) {
      store.ingestSessionEvent(realisticEvent(`turn-start-${index}`, 'assistant.turn_start', {}, { at: timestamp, agentId }));
    } else if (kind === 4) {
      store.ingestSessionEvent(realisticEvent(`usage-${index}`, 'assistant.usage', {
        model: 'gpt-5.4',
        inputTokens: 10,
        outputTokens: 5,
        copilotUsage: { totalNanoAiu: 1000 + index },
        apiCallId: `api-${index}`,
      }, { at: timestamp, agentId }));
    } else {
      store.ingestSessionEvent(realisticEvent(`turn-end-${index}`, 'assistant.turn_end', {}, { at: timestamp, agentId }));
    }
  }
}

test('large snapshots do not resync-loop and fast clients receive later delta batches', { timeout: 8000 }, async () => {
  const fixture = await createFixture({ store: makeStore(largeSnapshot(128 * 1024)) });
  const client = openSse(fixture.server.url);
  try {
    await client.ready;
    await waitFor(() => client.events.find((entry) => entry.event === 'snapshot'));
    emitAgentChange(fixture.store);
    await waitFor(() => client.events.find((entry) => entry.event === 'delta' && entry.data?.type === 'batch'));
    await observeQuietPeriod(() => {
      assert.ok(client.events.filter((entry) => entry.event === 'snapshot').length <= 2, 'large snapshot should not loop');
    }, { duration: 2000 });
    assert.ok(client.events.some((entry) => entry.event === 'delta'), 'later store changes should arrive as deltas');
  } finally {
    client.close();
    await fixture.cleanup();
  }
});

test('paused clients receive exactly one resync snapshot after drain', { timeout: 12000 }, async () => {
  const fixture = await createFixture({ store: makeStore(largeSnapshot(8 * 1024 * 1024)) });
  const client = openSse(fixture.server.url, { paused: true });
  try {
    await client.ready;
    client.resume();
    await waitFor(() => client.events.filter((entry) => entry.event === 'snapshot').length === 1, { timeout: 8000 });
    client.pause();
    emitLargeAgentChange(fixture.store);
    await observeQuietPeriod(() => {
      assert.equal(client.events.filter((entry) => entry.event === 'snapshot').length, 1);
    }, { duration: 400 });
    client.resume();
    await waitFor(() => client.events.filter((entry) => entry.event === 'snapshot').length >= 2, { timeout: 8000 });
    await observeQuietPeriod(() => {
      assert.equal(client.events.filter((entry) => entry.event === 'snapshot').length, 2);
    }, { duration: 400 });
  } finally {
    client.close();
    await fixture.cleanup();
  }
});

test('heartbeat is skipped while a client is draining', { timeout: 12000 }, async () => {
  let heartbeat;
  const timers = {
    setInterval(fn) {
      heartbeat = fn;
      return { unref() {} };
    },
    clearInterval() {},
  };
  const fixture = await createFixture({ store: makeStore(largeSnapshot(8 * 1024 * 1024)), timers });
  const client = openSse(fixture.server.url, { paused: true });
  try {
    await client.ready;
    emitLargeAgentChange(fixture.store);
    await observeQuietPeriod(() => {
      assert.equal(client.events.filter((entry) => entry.event === 'heartbeat').length, 0);
    }, { duration: 400 });
    assert.equal(typeof heartbeat, 'function');
    heartbeat();
    heartbeat();
    client.resume();
    await waitFor(() => client.events.find((entry) => entry.event === 'snapshot'), { timeout: 4000 });
    assert.equal(client.events.filter((entry) => entry.event === 'heartbeat').length, 0);
  } finally {
    client.close();
    await fixture.cleanup();
  }
});

test('store snapshot messages are throttled while deltas continue', { timeout: 10000 }, async () => {
  const fixture = await createFixture({ store: makeStore() });
  const client = openSse(fixture.server.url);
  try {
    await client.ready;
    await waitFor(() => client.events.filter((entry) => entry.event === 'snapshot').length === 1);
    fixture.store.emit({ type: 'snapshot' });
    await waitFor(() => client.events.filter((entry) => entry.event === 'snapshot').length === 2);
    for (let index = 0; index < 20; index += 1) {
      fixture.store.emit({ type: 'snapshot' });
      emitAgentChange(fixture.store, `agent-${index}`);
    }
    await waitFor(() => client.events.find((entry) => entry.event === 'delta'));
    await observeQuietPeriod(() => {
      assert.equal(client.events.filter((entry) => entry.event === 'snapshot').length, 2);
    }, { duration: 1000 });
    fixture.store.emit({ type: 'snapshot' });
    await waitFor(() => client.events.filter((entry) => entry.event === 'snapshot').length === 3, { timeout: 6000 });
    assert.ok(client.events.filter((entry) => entry.event === 'snapshot').length <= 3);
  } finally {
    client.close();
    await fixture.cleanup();
  }
});

test('real store live events produce deltas without extra snapshots', { timeout: 10000 }, async () => {
  const store = createDashboardStore({ projectRoot: '/project' });
  store.initializeFromFiles({
    roster: [],
    codingAgent: { id: 'copilot', name: '@copilot', role: 'Coding Agent', badge: '🤖 Coding Agent', kind: 'coding' },
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    activity: [],
  });
  const fixture = await createFixture({ store });
  const client = openSse(fixture.server.url);
  try {
    await client.ready;
    await waitFor(() => client.events.filter((entry) => entry.event === 'snapshot').length === 1);
    feedRealisticLiveEvents(store);
    await waitFor(() => client.events.find((entry) => entry.event === 'delta' && entry.data?.type === 'batch'), { timeout: 5000 });
    await observeQuietPeriod(() => {
      assert.equal(client.events.filter((entry) => entry.event === 'snapshot').length, 1);
    }, { duration: 3000 });
    assert.ok(client.events.filter((entry) => entry.event === 'delta').length >= 1);
  } finally {
    client.close();
    await fixture.cleanup();
  }
});
