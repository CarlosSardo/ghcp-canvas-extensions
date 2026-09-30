import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createSquadDashboardExtension } from '../lib/extension-core.mjs';
import { makeScratch } from './helpers/scratch.mjs';
import { waitFor } from './helpers/wait.mjs';

const baseTime = Date.parse('2026-09-30T09:10:00.000Z');

class FakeCanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function event(id, type, data = {}, at = 0) {
  return { id, type, data, timestamp: new Date(baseTime + at).toISOString() };
}

async function writeSquad(root) {
  const squadRoot = path.join(root, '.squad');
  await mkdir(path.join(squadRoot, 'decisions', 'inbox'), { recursive: true });
  await writeFile(path.join(squadRoot, 'team.md'), `# Team\n\n| Name | Role | Charter | Badge |\n| --- | --- | --- | --- |\n| Gameplay | Game Logic | .squad/agents/gameplay/charter.md | 🎮 Gameplay |\n\n## Coding Agent → Capabilities\n\n- 🟢 Good fit: tests\n`, 'utf8');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness({ getEvents, getMetrics } = {}) {
  const handlers = new Set();
  const canvases = [];
  const session = {
    rpc: { usage: { getMetrics: getMetrics ?? (async () => ({ modelMetrics: {}, totalPremiumRequestCost: 0, totalUserRequests: 0, totalApiDurationMs: 0, sessionStartTime: new Date(baseTime).toISOString(), codeChanges: {} })) } },
    getEvents: getEvents ?? (async () => []),
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(payload) {
      for (const handler of [...handlers]) handler(payload);
    },
    subscriptionCount() {
      return handlers.size;
    },
  };
  return {
    session,
    canvases,
    createCanvas(config) {
      canvases.push(config);
      return config;
    },
    async joinSession({ canvases: registered }) {
      assert.equal(registered.length, 1);
      return session;
    },
  };
}

async function startHarness(t, options = {}) {
  const scratch = await makeScratch('extension');
  t.after(scratch.cleanup);
  await writeSquad(scratch.dir);
  const harness = createHarness(options);
  const controller = await createSquadDashboardExtension({
    CanvasError: FakeCanvasError,
    createCanvas: harness.createCanvas,
    joinSession: harness.joinSession.bind(harness),
    extensionRoot: path.resolve('.'),
    logFile: path.join(scratch.dir, 'extension.log'),
    cwd: () => scratch.dir,
  });
  t.after(() => controller.closeAll());
  return { ...harness, controller, canvas: harness.canvases[0], root: scratch.dir };
}

function openCtx(root, instanceId = 'dashboard-1') {
  return { instanceId, input: { projectPath: root }, session: { workingDirectory: root } };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function openSse(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}/events`, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}

test('open returns before slow backfill, reports progress, buffers live events, dedupes, and is idempotent', async (t) => {
  const backfill = deferred();
  const { controller, canvas, session, root } = await startHarness(t, {
    getEvents: () => backfill.promise,
  });

  const start = performance.now();
  const opened = await canvas.open(openCtx(root));
  const latency = performance.now() - start;
  assert.ok(latency < 500, `open should not await getEvents (${latency.toFixed(1)}ms)`);
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:/);

  const same = await canvas.open(openCtx(root));
  assert.equal(same.url, opened.url, 'same instanceId reuses the existing server');
  const entry = [...controller.stores.values()][0];
  assert.equal(entry.refCount, 1, 'idempotent open must not increment refCount');

  await waitFor(() => entry.store.getSnapshot().meta?.backfill?.state === 'running');
  const ingestedPromptTexts = [];
  const unsubscribe = entry.store.subscribe((message) => {
    if (message.type === 'prompt.updated' && message.prompt?.text) {
      ingestedPromptTexts.push(message.prompt.text);
    }
  });
  t.after(unsubscribe);
  session.emit(event('live-dup', 'user.message', { content: 'live duplicate should be buffered once' }, 30));
  session.emit(event('live-2', 'user.message', { content: 'second live event' }, 40));
  assert.equal(entry.store.getSnapshot().usage.prompts.length, 0, 'live events are buffered while backfill is running');

  backfill.resolve([
    event('hist-1', 'user.message', { content: 'history prompt' }, 10),
    event('live-dup', 'user.message', { content: 'history duplicate of live' }, 20),
  ]);

  await waitFor(() => entry.store.getSnapshot().meta?.backfill?.state === 'done');
  const prompts = entry.store.getSnapshot().usage.prompts.map((prompt) => prompt.text);
  assert.equal(prompts.length, 3, 'duplicate live/history event is deduped by event.id');
  assert.deepEqual([...new Set(ingestedPromptTexts)], ['history prompt', 'history duplicate of live', 'second live event']);
  assert.deepEqual(new Set(prompts), new Set(['history prompt', 'history duplicate of live', 'second live event']));
});

test('onClose closes server resources, clears usage polling, and removes live subscriptions', async (t) => {
  const { canvas, session, root, controller } = await startHarness(t);
  const opened = await canvas.open(openCtx(root));
  const entry = [...controller.stores.values()][0];
  const { req, res } = await openSse(opened.url);
  res.resume();
  await waitFor(() => entry.server.clientCount() === 1);
  assert.ok(entry.usagePollTimer, 'SSE activity starts the usage poll timer');

  req.destroy();
  await canvas.onClose(openCtx(root));
  assert.equal(entry.server, undefined, 'server reference is cleared after close');
  assert.equal(entry.usagePollTimer, undefined, 'usage poll timer is cleared after close');
  assert.equal(session.subscriptionCount(), 0, 'SDK live subscription is removed after the final instance closes');

  await assert.rejects(() => getJson(`${opened.url}/api/snapshot`), /ECONNREFUSED|socket hang up|fetch failed/);
});

test('usage metrics are cached, single-flighted, applied to the real store, and polled only while active', async (t) => {
  let calls = 0;
  const metrics = {
    totalPremiumRequestCost: 2,
    totalUserRequests: 5,
    totalNanoAiu: 9_000,
    totalApiDurationMs: 123,
    sessionStartTime: new Date(baseTime).toISOString(),
    codeChanges: {},
    modelMetrics: {
      'gpt-test': {
        totalNanoAiu: 9_000,
        requests: { count: 5, cost: 2 },
        usage: { inputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 17 },
      },
    },
  };
  const gate = deferred();
  const { canvas, root, controller } = await startHarness(t, {
    getMetrics: async () => {
      calls += 1;
      await gate.promise;
      return metrics;
    },
  });
  const opened = await canvas.open(openCtx(root));
  const entry = [...controller.stores.values()][0];
  assert.equal(typeof entry.store.applyLiveUsageMetrics, 'function');
  assert.equal(typeof entry.store.setBackfillProgress, 'function');
  assert.equal(calls, 0, 'open does not fetch usage before there is demand or an active SSE client');

  const first = getJson(`${opened.url}/api/usage`);
  const second = getJson(`${opened.url}/api/usage`);
  await waitFor(() => calls === 1);
  gate.resolve();
  const [firstUsage, secondUsage] = await Promise.all([first, second]);
  assert.equal(firstUsage.statusCode, 200);
  assert.deepEqual(secondUsage.body, firstUsage.body, 'concurrent reads share one in-flight metrics call');
  assert.equal(calls, 1);

  const third = await getJson(`${opened.url}/api/usage`);
  assert.equal(calls, 1, 'fresh TTL cache prevents repeated SDK RPC calls');
  assert.equal(third.body.session.nanoAiu, 9_000);
  assert.equal(third.body.session.totalTokens, 18, 'totalTokens excludes cache tokens');
  assert.equal(third.body.premiumRequests, 2, 'premium request cost is surfaced as a premium metric, not USD');
  assert.equal(third.body.userRequests, 5);
  assert.equal(third.body.byModel['gpt-test'].premiumRequests, 2);
  assert.equal(third.body.pricing.usdPerUnit, undefined, 'premium metrics are not presented as USD without pricing config');

  await waitFor(() => entry.store.getSnapshot().usage.sessionNanoAiuAuthoritative === 9_000);
  assert.equal(entry.store.getSnapshot().usage.premiumRequests, 2, 'real store receives live premium metrics');

  const active = await openSse(opened.url);
  active.res.resume();
  await waitFor(() => entry.usagePollTimer);
  active.req.destroy();
  await waitFor(() => !entry.usagePollTimer);
});
