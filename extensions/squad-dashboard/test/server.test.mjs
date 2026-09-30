import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { createDashboardServer } from '../lib/server.mjs';
import { makeScratch } from './helpers/scratch.mjs';
import { waitFor } from './helpers/wait.mjs';

async function makeTempDir(prefix) {
  const scratch = await makeScratch(prefix.replace(/-$/, ''));
  return scratch;
}

function usageTotals(overrides = {}) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    nanoAiu: 0,
    requests: 0,
    ...overrides,
  };
}

function buildSnapshot() {
  return {
    schemaVersion: 1,
    generatedAt: new Date('2026-09-30T06:32:12.000Z').toISOString(),
    projectRoot: '/project',
    noSquad: false,
    coordinator: { status: 'idle', usage: usageTotals({ nanoAiu: 10, requests: 1 }) },
    agents: [],
    activity: [],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    usage: {
      session: usageTotals({ inputTokens: 3, outputTokens: 2, totalTokens: 5, nanoAiu: 10, requests: 1 }),
      byModel: { 'gpt-5.4': usageTotals({ inputTokens: 3, outputTokens: 2, totalTokens: 5, nanoAiu: 10, requests: 1 }) },
      prompts: [],
      pricing: { unitLabel: 'AIU', nanoPerUnit: 1e9 },
      meta: { partial: false },
    },
    meta: { source: 'live', eventBackfill: true, errors: [] },
  };
}

function makeStore() {
  let current = buildSnapshot();
  const listeners = new Set();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let activeCalls = 0;
  let idleCalls = 0;

  return {
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get activeCalls() {
      return activeCalls;
    },
    get idleCalls() {
      return idleCalls;
    },
    getSnapshot() {
      return current;
    },
    refresh() {
      current = { ...current, generatedAt: new Date('2026-09-30T06:40:00.000Z').toISOString() };
      return current;
    },
    setNote(agentId, note) {
      const agent = {
        id: agentId,
        name: agentId,
        roster: false,
        kind: 'unknown',
        status: 'idle',
        note,
        counters: { toolCalls: 0, completedTasks: 0, failedTasks: 0 },
        usage: { total: usageTotals(), run: usageTotals(), estimated: false },
      };
      current = { ...current, agents: [agent] };
      this.emit({ type: 'agent.updated', agent });
      return agent;
    },
    subscribe(listener) {
      subscribeCalls += 1;
      listeners.add(listener);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(listener);
      };
    },
    onActive() {
      activeCalls += 1;
    },
    onIdle() {
      idleCalls += 1;
    },
    emit(message) {
      for (const listener of listeners) {
        listener(message);
      }
    },
  };
}

function requestBuffer(baseUrl, path, { method = 'GET', body, headers = {} } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveRequest({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', rejectRequest);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(baseUrl, path, options) {
  const response = await requestBuffer(baseUrl, path, options);
  return {
    ...response,
    json: response.body.length ? JSON.parse(response.body.toString('utf8')) : null,
  };
}

function decodeBody(response) {
  if (response.headers['content-encoding'] === 'gzip') {
    return gunzipSync(response.body).toString('utf8');
  }
  return response.body.toString('utf8');
}

function openSse(baseUrl) {
  const url = new URL(baseUrl);
  const events = [];
  let buffer = '';
  let responseRef;
  let closed = false;
  const waiters = [];

  function notifyWaiters() {
    for (const waiter of [...waiters]) {
      const match = events.find(waiter.predicate);
      if (match) {
        waiter.resolve(match);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  }

  const req = http.get({
    hostname: url.hostname,
    port: url.port,
    path: '/events',
    headers: { Accept: 'text/event-stream' },
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    req.on('response', (res) => {
      responseRef = res;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let splitIndex = buffer.indexOf('\n\n');
        while (splitIndex !== -1) {
          const block = buffer.slice(0, splitIndex).replace(/\r/g, '');
          buffer = buffer.slice(splitIndex + 2);
          const eventName = block.match(/^event:\s*(.+)$/m)?.[1] ?? 'message';
          const dataLines = [...block.matchAll(/^data:\s*(.*)$/gm)].map((match) => match[1]);
          const rawData = dataLines.join('\n');
          let data;
          try {
            data = rawData ? JSON.parse(rawData) : null;
          } catch {
            data = rawData;
          }
          events.push({ event: eventName, data, raw: block });
          notifyWaiters();
          splitIndex = buffer.indexOf('\n\n');
        }
      });
      resolveReady(res);
    });
    req.on('error', rejectReady);
  });

  return {
    ready,
    events,
    async waitForEvent(predicate, timeoutMs = 4000) {
      const match = events.find(predicate);
      if (match) return match;
      return new Promise((resolveWait, rejectWait) => {
        const waiter = { predicate, resolve: resolveWait };
        waiters.push(waiter);
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          rejectWait(new Error(`timed out waiting for SSE event; saw ${events.length} events`));
        }, timeoutMs);
        timeout.unref?.();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      req.destroy();
      await new Promise((resolve) => setImmediate(resolve));
    },
    response() {
      return responseRef;
    },
  };
}

test('createDashboardServer serves usage, gzip + ETag, rejects traversal, reports clientCount, and closes promptly with open SSE clients', { timeout: 10000 }, async () => {
  const scratch = await makeTempDir('ui-static-');
  const uiDir = scratch.dir;
  const store = makeStore();
  let server;
  let client;
  try {
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><body><button id="theme-btn" aria-label="Toggle theme"></button><script type="module" src="/app.js"></script></body></html>');
    await writeFile(join(uiDir, 'app.js'), 'console.log?.("not in production");\nexport const loaded = true;\n');
    await writeFile(join(uiDir, 'styles.css'), 'body { color: red; }\n');
    await writeFile(join(uiDir, 'demo-snapshot.json'), JSON.stringify(store.getSnapshot()));

    server = await createDashboardServer({ store, uiDir, log: () => {} });
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(typeof server.clientCount, 'function', 'server should expose clientCount()');
    assert.equal(server.clientCount(), 0);

    const usageResponse = await requestJson(server.url, '/api/usage');
    assert.equal(usageResponse.status, 200);
    assert.deepEqual(usageResponse.json, store.getSnapshot().usage);

    const plainStatic = await requestBuffer(server.url, '/app.js');
    const gzipStatic = await requestBuffer(server.url, '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(gzipStatic.status, 200);
    assert.equal(gzipStatic.headers['content-encoding'], 'gzip');
    assert.equal(decodeBody(gzipStatic), plainStatic.body.toString('utf8'));
    assert.ok(gzipStatic.headers.etag, 'static assets should include an ETag');

    const static304 = await requestBuffer(server.url, '/app.js', {
      headers: { 'If-None-Match': gzipStatic.headers.etag },
    });
    assert.equal(static304.status, 304);
    assert.equal(static304.body.length, 0);

    const plainSnapshot = await requestBuffer(server.url, '/api/snapshot');
    const gzipSnapshot = await requestBuffer(server.url, '/api/snapshot', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(gzipSnapshot.status, 200);
    assert.equal(gzipSnapshot.headers['content-encoding'], 'gzip');
    assert.equal(decodeBody(gzipSnapshot), plainSnapshot.body.toString('utf8'));
    assert.ok(gzipSnapshot.headers.etag, 'snapshot responses should include an ETag');

    const snapshot304 = await requestBuffer(server.url, '/api/snapshot', {
      headers: { 'If-None-Match': gzipSnapshot.headers.etag },
    });
    assert.equal(snapshot304.status, 304);
    assert.equal(snapshot304.body.length, 0);

    for (const traversalPath of ['/../extension.mjs', '/%2e%2e/extension.mjs']) {
      const traversal = await requestBuffer(server.url, traversalPath);
      assert.notEqual(traversal.status, 200, `${traversalPath} must not be served`);
      assert.doesNotMatch(decodeBody(traversal), /joinSession|createCanvas|CONTRACT/i);
    }

    const missing = await requestJson(server.url, '/missing-route');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'not_found' });

    client = openSse(server.url);
    const ready = await client.ready;
    assert.equal(ready.statusCode, 200);
    assert.match(ready.headers['content-type'] ?? '', /text\/event-stream/);
    const firstEvent = await client.waitForEvent(() => true);
    assert.equal(firstEvent.event, 'snapshot', 'a new SSE client must receive a snapshot first');
    assert.equal(server.clientCount(), 1);

    await Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('server.close() did not resolve promptly')), 1500)),
    ]);
    server = undefined;
  } finally {
    await client?.close();
    await server?.close?.();
    await scratch.cleanup();
  }
});

test('SSE delta delivery is batched/coalesced, keeps activity order, and uses one store subscription for all clients', { timeout: 10000 }, async () => {
  const scratch = await makeTempDir('ui-batch-');
  const uiDir = scratch.dir;
  const store = makeStore();
  let server;
  let firstClient;
  let secondClient;
  try {
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><body><script type="module" src="/app.js"></script></body></html>');
    await writeFile(join(uiDir, 'app.js'), 'export const ui = true;\n');
    await writeFile(join(uiDir, 'styles.css'), 'body { color: red; }\n');
    await writeFile(join(uiDir, 'demo-snapshot.json'), JSON.stringify(store.getSnapshot()));

    server = await createDashboardServer({ store, uiDir, log: () => {} });

    firstClient = openSse(server.url);
    secondClient = openSse(server.url);
    await firstClient.ready;
    await secondClient.ready;
    await firstClient.waitForEvent((entry) => entry.event === 'snapshot');
    await secondClient.waitForEvent((entry) => entry.event === 'snapshot');

    assert.equal(store.subscribeCalls, 1, 'server should fan out from a single store subscription regardless of client count');
    assert.equal(store.activeCalls, 1, 'first live SSE client should transition the server/store to active mode');
    assert.equal(server.clientCount(), 2);

    const latestAgentById = new Map();
    const activityIds = [];
    for (let index = 0; index < 500; index += 1) {
      if (index % 2 === 0) {
        const agent = {
          id: `agent-${index % 3}`,
          name: `Agent ${index % 3}`,
          roster: false,
          kind: 'unknown',
          status: 'working',
          currentTask: `task-${index}`,
          counters: { toolCalls: index, completedTasks: 0, failedTasks: 0 },
          usage: { total: usageTotals({ totalTokens: index }), run: usageTotals({ totalTokens: index }), estimated: false },
        };
        latestAgentById.set(agent.id, agent.currentTask);
        store.emit({ type: 'agent.updated', agent });
      } else {
        const item = { id: `activity-${index}`, timestamp: new Date(1_727_677_920_000 + index).toISOString(), level: 'info', text: `activity-${index}`, source: 'session' };
        activityIds.push(item.id);
        store.emit({ type: 'activity.added', item });
      }
    }

    const batchEvent = await firstClient.waitForEvent((entry) => entry.event === 'delta' && entry.data?.type === 'batch');
    await waitFor(() => firstClient.events.filter((entry) => entry.event === 'delta').length > 0);

    const deltaEvents = firstClient.events.filter((entry) => entry.event === 'delta');
    assert.ok(deltaEvents.length < 50, `500 rapid store events should be coalesced into far fewer SSE writes (saw ${deltaEvents.length})`);

    const batch = batchEvent.data;
    assert.equal(batch.type, 'batch');
    assert.ok(Array.isArray(batch.items));

    const agentUpdates = batch.items.filter((item) => item.type === 'agent.updated');
    assert.equal(new Set(agentUpdates.map((item) => item.agent.id)).size, agentUpdates.length, 'each batch should keep only the last agent.updated per agent id');
    for (const update of agentUpdates) {
      assert.equal(update.agent.currentTask, latestAgentById.get(update.agent.id), `batch should keep the last agent.updated payload for ${update.agent.id}`);
    }

    const activities = batch.items.filter((item) => item.type === 'activity.added');
    assert.deepEqual(activities.map((item) => item.item.id), activityIds, 'activity.added entries must keep the emitted order inside the coalesced batch');

    await firstClient.close();
    await waitFor(() => server.clientCount() === 1);
    assert.equal(server.clientCount(), 1);
    assert.equal(store.unsubscribeCalls, 0, 'subscription should stay active while at least one client remains');

    await secondClient.close();
    await waitFor(() => server.clientCount() === 0);
    assert.equal(server.clientCount(), 0);
    assert.equal(store.unsubscribeCalls, 1, 'store subscription should be released when the last client disconnects');
    assert.equal(store.idleCalls, 1, 'last client leaving should transition the server/store back to idle mode');
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    await server?.close?.();
    await scratch.cleanup();
  }
});

test('SSE slow clients are marked for snapshot resync while other clients continue receiving deltas', { timeout: 15000 }, async () => {
  const scratch = await makeTempDir('ui-slow-sse-');
  const uiDir = scratch.dir;
  const store = makeStore();
  let server;
  let slowClient;
  let fastClient;
  try {
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><body><script type="module" src="/app.js"></script></body></html>');
    await writeFile(join(uiDir, 'app.js'), 'export const ui = true;\n');
    await writeFile(join(uiDir, 'styles.css'), 'body { color: red; }\n');
    await writeFile(join(uiDir, 'demo-snapshot.json'), JSON.stringify(store.getSnapshot()));

    server = await createDashboardServer({ store, uiDir, log: () => {} });
    slowClient = openSse(server.url);
    fastClient = openSse(server.url);
    await slowClient.ready;
    await fastClient.ready;
    await slowClient.waitForEvent((entry) => entry.event === 'snapshot');
    await fastClient.waitForEvent((entry) => entry.event === 'snapshot');

    slowClient.response().pause();
    const largeItem = { id: 'slow-client-pressure', timestamp: new Date().toISOString(), level: 'info', text: 'x'.repeat(2_000_000), source: 'pressure' };
    store.emit({ type: 'activity.added', item: largeItem });

    const fastDelta = await fastClient.waitForEvent((entry) => entry.event === 'delta' && JSON.stringify(entry.data).includes('slow-client-pressure'));
    assert.equal(fastDelta.data.type, 'batch', 'healthy clients should keep receiving delta batches');

    slowClient.response().resume();
    const resync = await slowClient.waitForEvent((entry) => entry.event === 'snapshot' && slowClient.events.indexOf(entry) > 0, 8000);
    assert.equal(resync.event, 'snapshot', 'slow clients should receive a fresh snapshot after backpressure drains');
  } finally {
    slowClient?.response()?.resume?.();
    await slowClient?.close();
    await fastClient?.close();
    await server?.close?.();
    await scratch.cleanup();
  }
});

test('SSE oversized pending batches resync clients with a snapshot instead of an unbounded delta', { timeout: 10000 }, async () => {
  const scratch = await makeTempDir('ui-snapshot-resync-');
  const uiDir = scratch.dir;
  const store = makeStore();
  let server;
  let client;
  try {
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><body><script type="module" src="/app.js"></script></body></html>');
    await writeFile(join(uiDir, 'app.js'), 'export const ui = true;\n');
    await writeFile(join(uiDir, 'styles.css'), 'body { color: red; }\n');
    await writeFile(join(uiDir, 'demo-snapshot.json'), JSON.stringify(store.getSnapshot()));

    server = await createDashboardServer({ store, uiDir, log: () => {} });
    client = openSse(server.url);
    await client.ready;
    await client.waitForEvent((entry) => entry.event === 'snapshot');

    for (let index = 0; index < 1500; index += 1) {
      store.emit({ type: 'activity.added', item: { id: `resync-${index}`, timestamp: new Date(1_727_677_920_000 + index).toISOString(), level: 'info', text: `resync-${index}`, source: 'test' } });
    }

    const secondSnapshot = await client.waitForEvent((entry) => entry.event === 'snapshot' && client.events.indexOf(entry) > 0);
    assert.equal(secondSnapshot.event, 'snapshot', 'oversized pending queues should collapse into a snapshot resync');
    assert.equal(client.events.some((entry) => entry.event === 'delta' && entry.data?.items?.length > 1000), false, 'server must not emit unbounded delta batches');
  } finally {
    await client?.close();
    await server?.close?.();
    await scratch.cleanup();
  }
});

