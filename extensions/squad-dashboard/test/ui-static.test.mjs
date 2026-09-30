import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const uiDir = resolve('ui');
const htmlPath = join(uiDir, 'index.html');
const appPath = join(uiDir, 'app.js');
const cssPath = join(uiDir, 'styles.css');
const demoPath = join(uiDir, 'demo-snapshot.json');

async function readUiFiles() {
  const names = await readdir(uiDir);
  const files = new Map();
  for (const name of names) {
    const filePath = join(uiDir, name);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) continue;
    files.set(name, {
      path: filePath,
      size: fileStat.size,
      content: await readFile(filePath, 'utf8'),
    });
  }
  return files;
}

function referencedUiFiles(indexHtml) {
  return [...indexHtml.matchAll(/(?:src|href)=['"]\/([^'"?#]+)[^'"]*['"]/g)].map((match) => match[1]);
}

test('ui files stay self-contained, themed, safe, and compact', async () => {
  const files = await readUiFiles();
  const indexHtml = files.get('index.html')?.content;
  const appJs = files.get('app.js')?.content;
  const stylesCss = files.get('styles.css')?.content;
  const demoText = files.get('demo-snapshot.json')?.content;

  assert.ok(indexHtml, 'ui/index.html must exist');
  assert.ok(appJs, 'ui/app.js must exist');
  assert.ok(stylesCss, 'ui/styles.css must exist');
  assert.ok(demoText, 'ui/demo-snapshot.json must exist');

  for (const [name, file] of files.entries()) {
    assert.doesNotMatch(file.content, /https?:\/\//i, `${name} must not reference external URLs`);
  }

  assert.match(indexHtml, /id=['"]theme-btn['"]/i, 'index.html must include #theme-btn');
  assert.match(indexHtml, /id=['"]theme-btn['"][^>]*aria-label=['"][^'"]+['"]/i, '#theme-btn must have an aria-label');
  assert.match(appJs, /data-ui-theme/, 'app code must manage data-ui-theme on <html>');
  assert.match(appJs, /squad-dashboard\.theme/, 'app code must persist the selected theme in localStorage');

  assert.match(stylesCss, /(?::root|\[data-ui-theme=['"]light['"]\])/, 'CSS must define the light theme palette');
  assert.match(stylesCss, /\[data-ui-theme=['"]dark['"]\]/, 'CSS must define the dark theme palette');
  assert.match(stylesCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'CSS must respect prefers-reduced-motion');
  assert.doesNotMatch(stylesCss, /backdrop-filter\s*:/i, 'CSS should avoid backdrop-filter for performance');

  const innerHtmlAssignments = [...appJs.matchAll(/innerHTML\s*=\s*([^;]+);/g)].map((match) => match[1].trim());
  for (const expression of innerHtmlAssignments) {
    assert.match(expression, /^(?:'[^']*'|"[^"]*"|`[^$]*`)$/, `innerHTML assignments must be static strings only: ${expression}`);
  }

  const demo = JSON.parse(demoText);
  assert.ok(demo.usage && typeof demo.usage === 'object', 'demo snapshot must include usage data');
  assert.ok(demo.usage.session && typeof demo.usage.session.totalTokens === 'number', 'demo usage must expose session totals');
  assert.ok(Array.isArray(demo.usage.prompts) && demo.usage.prompts.length > 0, 'demo usage must include prompts');
  assert.ok(demo.usage.prompts[0].byAgent && Object.keys(demo.usage.prompts[0].byAgent).length > 0, 'demo prompt usage must include byAgent totals');
  assert.ok(Array.isArray(demo.agents) && demo.agents.some((agent) => agent.usage?.total?.totalTokens >= 0), 'demo agents must expose per-agent usage');
  assert.ok(demo.agents.some((agent) => agent.usage?.total?.estimatedTokens > 0), 'demo agents must include estimated-token-only cases');
  assert.ok(demo.usage.userRequests > 0, 'demo usage must include userRequests for the header prompt pill');
  assert.match(appJs, /if \(agent\.kind === "human"\)\s*\{\s*updateHumanNode\(node, agent\);/s, 'app.js must render a dedicated human-card branch');
  assert.match(appJs, /filter\(\(agent\) => agent\.kind !== "human" && \(visibleUsageTokens\(agent\.usage\.total\) \|\| agent\.usage\.total\.nanoAiu\)\)/, 'usage rows must exclude human roster members while including estimated tokens');
  assert.match(appJs, /Ranked by tokens \(incl\. estimates\)/, 'usage lists must label estimated-token ranking once');
  assert.match(appJs, /coordinator\.updated/, 'app.js must handle coordinator.updated deltas');
  assert.match(appJs, /premium req/, 'header premium metric must not be rendered as a subset of observed requests');
  assert.match(appJs, /if \(coordinatorIsActive\(snapshot\.coordinator\.status\)\) \{\s*counts\.working \+= 1;/s, 'working counts must include an active coordinator');
  assert.match(appJs, /setText\(elements\.emptyTitle, "Coordinator is working…"\)/, 'empty state must handle coordinator-only activity');
  assert.match(stylesCss, /\.agent-card__head\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/s, 'agent card header must use explicit grid columns');

  for (const referenced of referencedUiFiles(indexHtml)) {
    assert.ok(files.has(referenced), `index.html references missing ui/${referenced}`);
  }

  const totalBytes = [...files.values()].reduce((sum, file) => sum + file.size, 0);
  assert.ok(totalBytes < 150 * 1024, `ui/ should stay small (<150 KB, got ${(totalBytes / 1024).toFixed(1)} KB)`);
});
