import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { createDashboardServer } from '../lib/server.mjs';
import { makeScratch } from './helpers/scratch.mjs';
import { waitFor } from './helpers/wait.mjs';

function buildSnapshot() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-30T09:10:00.000Z',
    projectRoot: '/project',
    noSquad: false,
    coordinator: { status: 'idle' },
    agents: [],
    activity: [],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    usage: { session: {}, byModel: {}, prompts: [], pricing: { unitLabel: 'AIU', nanoPerUnit: 1e9 }, meta: {} },
    meta: { source: 'test', eventBackfill: true, errors: [] },
  };
}

function makeStore({ refreshError, unknownNotes = false } = {}) {
  const listeners = new Set();
  let snapshot = buildSnapshot();
  return {
    getSnapshot() {
      return { ...snapshot, generatedAt: new Date().toISOString() };
    },
    refresh() {
      if (refreshError) throw refreshError;
      return this.getSnapshot();
    },
    setNote(agentId, note) {
      if (unknownNotes) return null;
      snapshot = {
        ...snapshot,
        agents: [{ id: agentId, note }],
      };
      return { id: agentId, note };
    },
    setMarker(marker) {
      snapshot = { ...snapshot, marker };
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

async function createServerFixture(store = makeStore()) {
  const scratch = await makeScratch('server-security');
  const uiDir = path.join(scratch.dir, 'ui');
  await mkdir(uiDir, { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><html><body>dashboard</body></html>');
  await writeFile(path.join(uiDir, 'app.js'), 'export const dashboard = true;\n');
  const server = await createDashboardServer({ store, uiDir, log: () => {} });
  return {
    server,
    store,
    port: new URL(server.url).port,
    async cleanup() {
      await server.close();
      await scratch.cleanup();
    },
  };
}

function requestBuffer(baseUrl, requestPath, {
  method = 'GET',
  headers = {},
  body,
  setHost = true,
} = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: requestPath,
      method,
      headers,
      setHost,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestStatus(baseUrl, requestPath, options = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: requestPath,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      setHost: options.setHost ?? true,
    }, (res) => {
      resolve(res.statusCode);
      res.resume();
      req.destroy();
    });
    req.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function openSse(baseUrl, { headers = {} } = {}) {
  const url = new URL(baseUrl);
  const events = [];
  let buffer = '';
  const req = http.get({
    hostname: url.hostname,
    port: url.port,
    path: '/events',
    headers: { Accept: 'text/event-stream', ...headers },
  });
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
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
      resolve(res);
    });
    req.on('error', reject);
  });
  return {
    events,
    ready,
    close() {
      req.destroy();
    },
  };
}

test('SRV-6 accepts only loopback Host headers for every route', async () => {
  const fixture = await createServerFixture();
  try {
    for (const host of [`127.0.0.1:${fixture.port}`, `localhost:${fixture.port}`, `[::1]:${fixture.port}`]) {
      const response = await requestBuffer(fixture.server.url, '/api/snapshot', { headers: { Host: host } });
      assert.equal(response.status, 200, `${host} should be accepted`);
    }

    for (const host of ['example.com', '127.0.0.1', 'localhost:1', `127.0.0.1:${Number(fixture.port) + 1}`]) {
      const response = await requestBuffer(fixture.server.url, '/api/snapshot', { headers: { Host: host } });
      assert.equal(response.status, 421, `${host} should be rejected`);
    }

    const invalidStaticHost = await requestBuffer(fixture.server.url, '/app.js', { headers: { Host: 'example.com' } });
    assert.equal(invalidStaticHost.status, 421, 'invalid Host should be rejected on static routes too');

    const missingHost = await requestBuffer(fixture.server.url, '/api/snapshot', { setHost: false });
    assert.equal(missingHost.status, 421, 'missing Host should be rejected');
  } finally {
    await fixture.cleanup();
  }
});

test('SRV-6 enforces Origin and Sec-Fetch-Site only on protected routes', async () => {
  const fixture = await createServerFixture();
  const sameOrigin = `http://127.0.0.1:${fixture.port}`;
  const foreignOrigin = 'http://example.com';
  try {
    for (const requestPath of ['/api/snapshot', '/events', '/api/usage']) {
      const absent = await requestStatus(fixture.server.url, requestPath);
      assert.equal(absent, 200, `${requestPath} should allow absent Origin`);

      const same = await requestStatus(fixture.server.url, requestPath, { headers: { Origin: sameOrigin } });
      assert.equal(same, 200, `${requestPath} should allow same loopback Origin`);

      const foreign = await requestStatus(fixture.server.url, requestPath, { headers: { Origin: foreignOrigin } });
      assert.equal(foreign, 403, `${requestPath} should reject foreign Origin`);
    }

    for (const headers of [
      {},
      { Origin: sameOrigin },
      { 'Sec-Fetch-Site': 'same-origin' },
      { 'Sec-Fetch-Site': 'none' },
    ]) {
      const response = await requestBuffer(fixture.server.url, '/api/refresh', { method: 'POST', headers });
      assert.equal(response.status, 200, `POST should allow ${JSON.stringify(headers)}`);
    }

    const crossSitePost = await requestBuffer(fixture.server.url, '/api/refresh', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSitePost.status, 403);

    const foreignPost = await requestBuffer(fixture.server.url, '/api/refresh', {
      method: 'POST',
      headers: { Origin: foreignOrigin, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(foreignPost.status, 403);

    const staticCrossSite = await requestBuffer(fixture.server.url, '/app.js', {
      headers: { 'Sec-Fetch-Site': 'cross-site', Origin: foreignOrigin },
    });
    assert.equal(staticCrossSite.status, 200, 'static GET must stay embeddable cross-site');
  } finally {
    await fixture.cleanup();
  }
});

test('SRV-6 error bodies are sanitized', async () => {
  const fixture = await createServerFixture(makeStore({
    refreshError: new Error('boom at /home/you/.copilot/extensions/squad-dashboard/lib/server.mjs\n    at secret stack'),
  }));
  try {
    const response = await requestBuffer(fixture.server.url, '/api/refresh', { method: 'POST' });
    const body = response.body.toString('utf8');
    assert.equal(response.status, 500);
    assert.equal(body, '{"error":"internal_error"}');
    assert.doesNotMatch(body, /\/home\/you|stack|server\.mjs|boom/i);
  } finally {
    await fixture.cleanup();
  }
});

test('SRV-7 supports RFC 7232 If-None-Match weak comparison, lists, wildcard, and mismatch', async () => {
  const fixture = await createServerFixture();
  try {
    const first = await requestBuffer(fixture.server.url, '/app.js');
    assert.equal(first.status, 200);
    const weakEtag = first.headers.etag;
    assert.match(weakEtag, /^W\//);
    const strongEtag = weakEtag.replace(/^W\//, '');

    for (const [label, ifNoneMatch] of [
      ['strong candidate', strongEtag],
      ['weak candidate', weakEtag],
      ['list with whitespace', `"miss",   ${strongEtag}  , "other"`],
      ['wildcard', '*'],
    ]) {
      const response = await requestBuffer(fixture.server.url, '/app.js', {
        headers: { 'If-None-Match': ifNoneMatch },
      });
      assert.equal(response.status, 304, label);
      assert.equal(response.body.length, 0, label);
    }

    const mismatch = await requestBuffer(fixture.server.url, '/app.js', {
      headers: { 'If-None-Match': '"not-current"' },
    });
    assert.equal(mismatch.status, 200);

    const headWildcard = await requestBuffer(fixture.server.url, '/app.js', {
      method: 'HEAD',
      headers: { 'If-None-Match': '*' },
    });
    assert.equal(headWildcard.status, 304);
    assert.equal(headWildcard.headers.vary, 'Accept-Encoding');
  } finally {
    await fixture.cleanup();
  }
});

test('store meta.updated messages are forwarded inside coalesced SSE batches', async () => {
  const fixture = await createServerFixture();
  const client = openSse(fixture.server.url);
  try {
    const ready = await client.ready;
    assert.equal(ready.statusCode, 200);
    await waitFor(() => client.events.find((entry) => entry.event === 'snapshot'));

    const meta = { backfill: { state: 'running', processed: 1, total: 2, updatedAt: '2026-09-30T09:10:00.000Z' } };
    fixture.store.emit({ type: 'meta.updated', meta });

    const delta = await waitFor(
      () => client.events.find((entry) => (
        entry.event === 'delta' &&
        entry.data?.type === 'batch' &&
        entry.data.items.some((item) => item.type === 'meta.updated')
      )),
      { timeout: 2000, interval: 25 },
    );
    assert.deepEqual(delta.data.items.find((item) => item.type === 'meta.updated'), { type: 'meta.updated', meta });
  } finally {
    client.close();
    await fixture.cleanup();
  }
});

test('snapshot ETag ignores generatedAt but changes with store content', async () => {
  const store = makeStore();
  const fixture = await createServerFixture(store);
  try {
    const first = await requestBuffer(fixture.server.url, '/api/snapshot');
    assert.equal(first.status, 200);
    const second = await requestBuffer(fixture.server.url, '/api/snapshot');
    assert.equal(second.status, 200);
    assert.equal(second.headers.etag, first.headers.etag, 'unchanged snapshots should keep a stable ETag');

    const notModified = await requestBuffer(fixture.server.url, '/api/snapshot', {
      headers: { 'If-None-Match': first.headers.etag },
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.body.length, 0);

    store.setMarker('changed');
    const changed = await requestBuffer(fixture.server.url, '/api/snapshot', {
      headers: { 'If-None-Match': first.headers.etag },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, first.headers.etag);
  } finally {
    await fixture.cleanup();
  }
});

test('note for an unknown agent returns sanitized 404', async () => {
  const fixture = await createServerFixture(makeStore({ unknownNotes: true }));
  try {
    const response = await requestBuffer(fixture.server.url, '/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'e2e-note', note: 'hello' }),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.toString('utf8'), '{"error":"unknown agent"}');
    assert.doesNotMatch(response.body.toString('utf8'), /\/home\/|stack|server\.mjs/i);
  } finally {
    await fixture.cleanup();
  }
});
