import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { collectErrors, launchBrowser, serveDir } from './helpers/browser.mjs';
import { waitFor } from './helpers/wait.mjs';

const uiRoot = fileURLToPath(new URL('../ui/', import.meta.url));

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

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: new Date('2026-09-30T08:18:00+02:00').toISOString(),
    projectRoot: '/project',
    noSquad: false,
    coordinator: { status: 'idle', usage: usageTotals() },
    agents: [],
    activity: [],
    files: { decisionsInboxCount: 0, orchestrationLogCount: 0, logCount: 0 },
    usage: {
      session: usageTotals(),
      byModel: {},
      prompts: [],
      pricing: { unitLabel: 'AIU', nanoPerUnit: 1e9 },
      meta: { partial: false },
    },
    meta: { source: 'live', eventBackfill: true, errors: [] },
    ...overrides,
  };
}

test('ui demo runtime renders without page errors, hides human usage, and toggles theme', { timeout: 20000 }, async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;

  let server;
  let context;
  let page;
  try {
    server = await serveDir(uiRoot);
    context = await browser.newContext();
    page = await context.newPage();
    const errors = collectErrors(page);

    await page.goto(`${server.url}/?demo=1`, { waitUntil: 'load' });
    await waitFor(async () => (await page.locator('[data-agent-id]').count()) > 0);

    const cardCount = await page.locator('[data-agent-id]').count();
    assert.ok(cardCount > 0, 'expected at least one rendered agent card');

    const humanCard = page.locator('[data-agent-id="carlos-sardo"]');
    await humanCard.waitFor();
    const humanText = await humanCard.innerText();
    assert.doesNotMatch(humanText, /\b(?:tokens?|AIU)\b/i, 'human card should not show token or AIU usage');

    const html = page.locator('html');
    const initialTheme = await html.getAttribute('data-ui-theme');
    assert.match(initialTheme ?? '', /^(dark|light)$/, 'page should set an initial ui theme');

    await page.click('#theme-btn');
    const toggledTheme = await html.getAttribute('data-ui-theme');
    assert.equal(toggledTheme, initialTheme === 'dark' ? 'light' : 'dark', 'theme button should flip the ui theme');

    await page.click('#theme-btn');
    const restoredTheme = await html.getAttribute('data-ui-theme');
    assert.equal(restoredTheme, initialTheme, 'theme button should toggle back to the starting theme');

    await waitFor(async () => errors.length === 0 && await page.locator('[data-agent-id]').count() === cardCount, { timeout: 1000 });
    assert.deepEqual(errors, [], `expected no browser runtime errors, got: ${errors.join(' | ')}`);
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});

test('ui runtime renders hostile snapshot and SSE data literally without executing it', { timeout: 20000 }, async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;

  const hostileImg = '<img src=x onerror="window.__squadXssFlag=\'img\'">';
  const hostileScript = '<script>window.__squadXssFlag="script"</script>';
  const hostileUrl = 'javascript:window.__squadXssFlag="url"';
  const hostileAttr = 'quotes "double" \'single\' <angle> & stuff';
  const initial = snapshot({
    agents: [{
      id: 'hostile-agent',
      name: `Agent ${hostileImg}`,
      role: `Role ${hostileScript}`,
      badge: '⚠️ Hostile',
      roster: true,
      kind: 'member',
      status: 'working',
      currentTask: `Task ${hostileUrl}`,
      currentTool: `Tool ${hostileAttr}`,
      model: `Model ${hostileImg}`,
      note: `Note ${hostileScript} ${hostileUrl}`,
      lastActivityAt: new Date().toISOString(),
      counters: { toolCalls: 1, completedTasks: 0, failedTasks: 0 },
      usage: { total: usageTotals({ inputTokens: 1, outputTokens: 1, totalTokens: 2, nanoAiu: 1, requests: 1 }), run: usageTotals(), byModel: { [`model ${hostileAttr}`]: usageTotals({ totalTokens: 2, nanoAiu: 1 }) }, estimated: false },
    }],
    activity: [{ id: 'activity-1', timestamp: new Date().toISOString(), level: 'info', source: `Source ${hostileImg}`, text: `File path ${hostileUrl} /tmp/<nope> ${hostileAttr}`, agentId: 'hostile-agent' }],
    usage: {
      session: usageTotals({ inputTokens: 1, outputTokens: 1, totalTokens: 2, nanoAiu: 1, requests: 1 }),
      byModel: { [`Runtime ${hostileScript}`]: usageTotals({ totalTokens: 2, nanoAiu: 1 }) },
      prompts: [{ id: 'prompt-1', index: 1, text: `Prompt ${hostileImg} ${hostileScript} ${hostileUrl} ${hostileAttr}`, startedAt: new Date().toISOString(), active: true, totals: usageTotals({ totalTokens: 2, nanoAiu: 1 }), byAgent: { 'hostile-agent': usageTotals({ totalTokens: 2, nanoAiu: 1 }) } }],
      activePromptId: 'prompt-1',
      pricing: { unitLabel: 'AIU', nanoPerUnit: 1e9 },
      meta: { partial: false },
    },
  });
  const deltaAgent = {
    id: 'hostile-agent-2',
    name: `Delta ${hostileAttr}`,
    role: `Delta role ${hostileImg}`,
    roster: false,
    kind: 'unknown',
    status: 'done',
    currentTask: `Delta task ${hostileScript}`,
    currentTool: `Delta tool ${hostileUrl}`,
    model: `Delta model ${hostileAttr}`,
    note: `Delta note ${hostileImg}`,
    counters: { toolCalls: 1, completedTasks: 1, failedTasks: 0 },
    usage: { total: usageTotals({ totalTokens: 3, nanoAiu: 2, requests: 1 }), run: usageTotals(), byModel: {}, estimated: false },
  };

  let server;
  let context;
  let page;
  try {
    server = await serveDir(uiRoot, {
      routes: {
        '/favicon.ico': (_req, res) => { res.writeHead(204).end(); },
        '/api/snapshot': (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(initial));
        },
        '/events': (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);
          setImmediate(() => {
            const batch = { type: 'batch', items: [
              { type: 'agent.updated', agent: deltaAgent },
              { type: 'activity.added', item: { id: 'activity-2', timestamp: new Date().toISOString(), level: 'warn', source: `SSE ${hostileScript}`, text: `SSE file ${hostileUrl} ${hostileAttr}`, agentId: deltaAgent.id } },
              { type: 'prompt.updated', prompt: { id: 'prompt-2', index: 2, text: `SSE prompt ${hostileImg}`, startedAt: new Date().toISOString(), active: true, totals: usageTotals({ totalTokens: 3, nanoAiu: 2 }), byAgent: { [deltaAgent.id]: usageTotals({ totalTokens: 3, nanoAiu: 2 }) } } },
              { type: 'usage.updated', usage: { byModel: { [`SSE model ${hostileUrl}`]: usageTotals({ totalTokens: 3, nanoAiu: 2 }) } } },
            ] };
            res.write(`event: delta\ndata: ${JSON.stringify(batch)}\n\n`);
          });
        },
      },
    });
    context = await browser.newContext();
    page = await context.newPage();
    await page.addInitScript(() => { window.__squadXssFlag = 'clean'; });
    const errors = collectErrors(page);

    await page.goto(server.url, { waitUntil: 'load' });
    await waitFor(async () => (await page.locator('[data-agent-id="hostile-agent-2"]').count()) === 1);
    await page.locator('[data-agent-id="hostile-agent"]').click();
    await page.locator('[data-agent-id="hostile-agent-2"]').click();

    await page.click('#tab-prompts');
    await waitFor(async () => (await page.locator('body').innerText()).includes(`SSE prompt ${hostileImg}`));

    const visibleText = [];
    visibleText.push(await page.locator('body').innerText());
    for (const tab of ['#tab-session', '#tab-activity', '#tab-agents', '#tab-prompts']) {
      await page.click(tab);
      visibleText.push(await page.locator('body').innerText());
    }
    const bodyText = visibleText.join('\n---view---\n');
    for (const literal of [hostileImg, hostileScript, hostileUrl, hostileAttr, `Delta note ${hostileImg}`, `SSE prompt ${hostileImg}`]) {
      assert.ok(bodyText.includes(literal), `expected hostile literal to render as text: ${literal}`);
    }
    assert.equal(await page.evaluate(() => window.__squadXssFlag), 'clean', 'hostile markup and javascript URLs must not execute');
    assert.deepEqual(errors, [], `expected no browser runtime errors, got: ${errors.join(' | ')}`);
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    await server?.close().catch(() => {});
  }
});
