import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { collectErrors, launchBrowser, serveDir } from './helpers/browser.mjs';

const rootDir = resolve('.');
const uiDir = resolve('ui');

async function readText(path) {
  return readFile(resolve(rootDir, path), 'utf8');
}

function assertTotalsExcludeCache(value, label) {
  if (!value || typeof value !== 'object') return;
  if ('inputTokens' in value || 'outputTokens' in value || 'totalTokens' in value) {
    assert.equal(
      value.totalTokens,
      Number(value.inputTokens || 0) + Number(value.outputTokens || 0),
      `${label}.totalTokens must be input + output only`
    );
  }
}

function assertDemoTotals(snapshot) {
  assertTotalsExcludeCache(snapshot.coordinator?.usage, 'coordinator.usage');
  for (const [agentIndex, agent] of (snapshot.agents || []).entries()) {
    assertTotalsExcludeCache(agent.usage?.total, `agents[${agentIndex}].usage.total`);
    assertTotalsExcludeCache(agent.usage?.run, `agents[${agentIndex}].usage.run`);
    for (const [model, totals] of Object.entries(agent.usage?.byModel || {})) {
      assertTotalsExcludeCache(totals, `agents[${agentIndex}].usage.byModel.${model}`);
    }
  }
  assertTotalsExcludeCache(snapshot.usage?.session, 'usage.session');
  for (const [model, totals] of Object.entries(snapshot.usage?.byModel || {})) {
    assertTotalsExcludeCache(totals, `usage.byModel.${model}`);
  }
  for (const [promptIndex, prompt] of (snapshot.usage?.prompts || []).entries()) {
    assertTotalsExcludeCache(prompt.totals, `usage.prompts[${promptIndex}].totals`);
    for (const [agent, totals] of Object.entries(prompt.byAgent || {})) {
      assertTotalsExcludeCache(totals, `usage.prompts[${promptIndex}].byAgent.${agent}`);
    }
  }
}

async function waitSelected(page, selector) {
  await page.waitForFunction(
    (tabSelector) => document.querySelector(tabSelector)?.getAttribute('aria-selected') === 'true',
    selector
  );
}

test('ui fix contracts are wired statically', async () => {
  const [html, app, css, demoText] = await Promise.all([
    readText('ui/index.html'),
    readText('ui/app.js'),
    readText('ui/styles.css'),
    readText('ui/demo-snapshot.json'),
  ]);

  assert.match(html, /localStorage\.getItem\("squad-dashboard\.theme"\)/, 'index.html must bootstrap persisted theme before app.js');
  assert.ok(
    html.indexOf('localStorage.getItem("squad-dashboard.theme")') < html.indexOf('<link rel="stylesheet" href="/styles.css"'),
    'theme bootstrap must run before stylesheet load'
  );
  assert.match(html, /id="backfill-pill"/, 'index.html must include a backfill status pill');
  assert.match(html, /id="tab-agents"[^>]*tabindex="0"/, 'active tab starts as the only tab stop');
  assert.match(html, /id="tab-prompts"[^>]*tabindex="-1"/, 'inactive tabs start outside the tab order');

  assert.match(app, /event instanceof MessageEvent/, 'SSE error handler must identify server-sent MessageEvents');
  assert.doesNotMatch(app, /source\.onerror\s*=/, 'transport errors must not be handled by a separate catch-all onerror path');
  assert.match(app, /case "meta\.updated":\s*mergeMeta\(delta\.meta \|\| \{\}\);/s, 'meta.updated deltas must be applied');
  assert.match(app, /function renderBackfillPill\(backfill\)/, 'backfill progress must render through a dedicated helper');
  assert.match(app, /setAttribute\("tabindex", active \? "0" : "-1"\)/, 'tabs must implement roving tabindex');
  assert.match(app, /stopDemoTimer\(\);[\s\S]*return;/, 'hidden pages must stop the demo timer');
  assert.match(app, /function normalizeBackfill\(raw\)/, 'backfill meta must be normalized defensively');
  assert.match(app, /totalTokens:\s*raw\?\.totalTokens !== undefined \? numberOrZero\(raw\.totalTokens\) : inputTokens \+ outputTokens/, 'missing totalTokens must synthesize input + output only');
  assert.doesNotMatch(app, /totalTokens:\s*inputTokens \+ outputTokens \+ cacheReadTokens/, 'demo usage must not add cache tokens to totalTokens');
  assert.match(app, /estimatedTokens/, 'app must normalize and render estimated token totals');
  assert.match(app, /estimated from sub-agent completion totals; no in\/out split/, 'estimated-token tooltip must explain the missing split');
  assert.match(app, /case "coordinator\.updated":\s*state\.snapshot\.coordinator = normalizeCoordinator\(delta\.coordinator, state\.snapshot\.coordinator\);/s, 'coordinator.updated deltas must update coordinator state');
  assert.match(app, /Ranked by tokens \(incl\. estimates\)/, 'ranked lists must show a single token basis');
  assert.match(app, /usageShareBasis/, 'ranked lists must choose one share basis for all rows');
  assert.match(app, /calls since dashboard start/, 'observed model calls must be labeled separately from premium request units');
  assert.match(css, /@container\s*\(max-width:\s*520px\)/, 'Insights rows must stack under a container query');
  assert.match(css, /\.usage-row__sub[\s\S]*white-space:\s*nowrap/, 'Insights subtitles must not wrap one character at a time');

  for (const token of [
    '--background-color-default',
    '--text-color-default',
    '--text-color-muted',
    '--border-color-default',
    '--color-focus-outline',
    '--font-sans',
    '--font-mono',
  ]) {
    assert.match(css, new RegExp(token.replaceAll('-', '\\-')), `CSS must map ${token}`);
  }

  assertDemoTotals(JSON.parse(demoText));
  assert.ok(JSON.parse(demoText).agents.some((agent) => agent.usage?.total?.estimatedTokens > 0), 'demo must expose estimated token rendering');
});

test('ui runtime keeps tabs accessible, backfill visible, screenshots clean', { timeout: 30000 }, async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;

  const baseSnapshot = JSON.parse(await readText('ui/demo-snapshot.json'));
  const runningSnapshot = {
    ...baseSnapshot,
    meta: {
      ...(baseSnapshot.meta || {}),
      backfill: { state: 'running', processed: 25, total: 100, updatedAt: new Date().toISOString() },
    },
  };

  const server = await serveDir(uiDir, {
    routes: {
      '/demo-snapshot.json': async (_req, res) => {
        const body = JSON.stringify(runningSnapshot);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      },
    },
  });

  try {
    for (const width of [1100, 600, 420]) {
      for (const theme of ['dark', 'light']) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        const errors = collectErrors(page);
        await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['squad-dashboard.theme', theme]);
        try {
          await page.goto(`${server.url}/?demo=1`, { waitUntil: 'load' });
          await page.waitForSelector('[data-agent-id]');
          await page.waitForSelector('#backfill-pill:not([hidden])');

          assert.equal(await page.locator('html').getAttribute('data-ui-theme'), theme, `${theme} theme should win from storage`);
          assert.equal(await page.locator('#backfill-pill').innerText(), 'Loading history… 25%', 'running backfill should show percentage');
          await assert.match(await page.locator('[data-agent-id="lead"] .metric-pill').first().innerText(), /≈.+tok · est\./, 'estimated card tokens should be visible');
          assert.match(await page.locator('[data-agent-id="lead"] .metric-pill').first().getAttribute('title'), /estimated from sub-agent completion totals; no in\/out split/, 'estimated card title should explain the estimate');
          assert.equal(await page.locator('#usage-agents').evaluate((node) => node.dataset.basisLabel), 'Ranked by tokens (incl. estimates)', 'Insights list should show one token basis');
          assert.doesNotMatch(await page.locator('#usage-agents').innerText(), /share of (?:AIU|tokens)/, 'rows should not repeat the share basis');
          assert.match(await page.locator('#session-extra-pill').innerText(), /premium req/, 'header should label premium request units');
          assert.doesNotMatch(await page.locator('#session-extra-pill').innerText(), /\d+ req · \d+ premium/, 'header must not imply premium is a subset of observed requests');

          await page.focus('#tab-agents');
          await page.keyboard.press('ArrowRight');
          await waitSelected(page, '#tab-prompts');
          assert.equal(await page.locator('#tab-prompts').getAttribute('aria-selected'), 'true', 'ArrowRight selects next tab');
          assert.equal(await page.locator('#tab-agents').getAttribute('tabindex'), '-1', 'previous tab leaves tab order');
          assert.equal(await page.locator('#tab-prompts').getAttribute('tabindex'), '0', 'selected tab becomes tab stop');
          await page.keyboard.press('End');
          await waitSelected(page, '#tab-activity');
          assert.equal(await page.locator('#tab-activity').getAttribute('aria-selected'), 'true', 'End selects last tab');
          await page.keyboard.press('Home');
          await waitSelected(page, '#tab-agents');
          assert.equal(await page.locator('#tab-agents').getAttribute('aria-selected'), 'true', 'Home selects first tab');

          await page.evaluate(() => window.scrollTo(0, 0));
          const screenshot = await page.screenshot({ fullPage: true });
          assert.ok(screenshot.length > 0, `expected a rendered screenshot for ${theme}/${width}`);
          assert.deepEqual(errors, [], `expected no browser errors for ${theme}/${width}: ${errors.join(' | ')}`);
        } finally {
          await context.close().catch(() => {});
        }
      }
    }
  } finally {
    await server.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

test('ui applies coordinator.updated deltas to header counts and empty state', { timeout: 20000 }, async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;

  const baseSnapshot = JSON.parse(await readText('ui/demo-snapshot.json'));
  const snapshot = {
    ...baseSnapshot,
    coordinator: { ...baseSnapshot.coordinator, status: 'idle' },
    agents: [],
  };

  const server = await serveDir(uiDir, {
    routes: {
      '/api/snapshot': async (_req, res) => {
        const body = JSON.stringify(snapshot);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      },
      '/events': async (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        setTimeout(() => {
          res.write(`event: delta\ndata: ${JSON.stringify({ type: 'batch', items: [{ type: 'coordinator.updated', coordinator: { ...snapshot.coordinator, status: 'thinking' } }] })}\n\n`);
        }, 50);
      },
    },
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = collectErrors(page);
  try {
    await page.goto(server.url, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#coordinator-pill')?.dataset.status === 'thinking');
    assert.equal(await page.locator('[data-count="working"]').innerText(), '1', 'coordinator.updated should update the working count');
    assert.equal(await page.locator('#empty-title').innerText(), 'Coordinator is working…', 'coordinator.updated should update coordinator-only empty state');
    assert.deepEqual(errors, [], `expected no browser errors: ${errors.join(' | ')}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
});
