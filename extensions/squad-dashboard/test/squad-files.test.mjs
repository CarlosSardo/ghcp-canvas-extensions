import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  normalizeAgentKey,
  parseTeamMarkdown,
  readSquadFiles,
  resolveProjectRoot,
  watchSquadFiles,
} from '../lib/squad-files.mjs';
import { makeScratch } from './helpers/scratch.mjs';
import { waitFor } from './helpers/wait.mjs';

const FIXTURE_TEAM_MD = `# Squad Team

> 01

## Coordinator

| Name | Role | Notes |
|------|------|-------|
| Squad | Coordinator | Routes work, enforces handoffs and reviewer gates. |

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Lead | Lead | .squad/agents/lead/charter.md | 🏗️ Lead |
| Gameplay | Game Logic | .squad/agents/gameplay/charter.md | 🎮 Game Logic |
| Frontend | Frontend Dev | .squad/agents/frontend/charter.md | ⚛️ Frontend |
| Audio | Audio Dev | .squad/agents/audio/charter.md | 🔊 Audio |
| Tester | Tester | .squad/agents/tester/charter.md | 🧪 Tester |
| Scribe | Session Logger | .squad/agents/scribe/charter.md | 📋 Scribe |
| Ralph | Work Monitor | .squad/agents/ralph/charter.md | 🔄 Monitor |
| Fact Checker | Fact Checker | .squad/agents/fact-checker/charter.md | 🔍 Verifier |
| Carlos Sardo | Dev Lead | — | 👤 Human |

## Coding Agent

<!-- copilot-auto-assign: false -->

| Name | Role | Charter | Status |
|------|------|---------|--------|
| @copilot | Coding Agent | — | 🤖 Coding Agent |

### Capabilities

**🟢 Good fit — auto-route when enabled:**
- Test coverage (adding missing tests, fixing flaky tests)
`;

async function makeTempDir(prefix) {
  const scratch = await makeScratch(prefix.replace(/-$/, ''));
  return scratch;
}

async function pathExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

test('makeScratch cleanup removes per-process subroots and shared root after concurrent cleanup', async () => {
  const first = await makeScratch('concurrent');
  const second = await makeScratch('concurrent');
  const firstSubroot = join(first.dir, '..');
  const secondSubroot = join(second.dir, '..');

  assert.notEqual(firstSubroot, secondSubroot, 'each scratch allocation should get an isolated subroot');
  assert.equal(await pathExists(first.dir), true);
  assert.equal(await pathExists(second.dir), true);

  await Promise.all([first.cleanup(), second.cleanup()]);
  await Promise.all([first.cleanup(), second.cleanup()]);

  assert.equal(await pathExists(first.dir), false);
  assert.equal(await pathExists(second.dir), false);
  assert.equal(await pathExists(firstSubroot), false);
  assert.equal(await pathExists(secondSubroot), false);
});

test('normalizeAgentKey strips symbols, colon tasks, accents, and extra spacing', () => {
  assert.equal(normalizeAgentKey('Fact Checker'), 'fact-checker');
  assert.equal(normalizeAgentKey('⚛️ Frontend: Building UI'), 'frontend');
  assert.equal(normalizeAgentKey('  José   Álvarez  '), 'jose-alvarez');
  assert.equal(normalizeAgentKey('  🔍  Fact   Checker : verifying evidence  '), 'fact-checker');
});

test('parseTeamMarkdown parses members, human roster entries, and the coding agent', () => {
  const parsed = parseTeamMarkdown(FIXTURE_TEAM_MD);
  assert.ok(Array.isArray(parsed.roster));

  const byId = new Map(parsed.roster.map((member) => [member.id, member]));
  assert.deepEqual(
    { name: byId.get('fact-checker')?.name, role: byId.get('fact-checker')?.role, kind: byId.get('fact-checker')?.kind },
    { name: 'Fact Checker', role: 'Fact Checker', kind: 'member' },
  );

  assert.deepEqual(
    { name: byId.get('carlos-sardo')?.name, role: byId.get('carlos-sardo')?.role, kind: byId.get('carlos-sardo')?.kind },
    { name: 'Carlos Sardo', role: 'Dev Lead', kind: 'human' },
  );

  assert.equal(parsed.codingAgent?.id, 'copilot');
  assert.equal(parsed.codingAgent?.name, '@copilot');
  assert.equal(parsed.codingAgent?.kind, 'coding');
});

test('resolveProjectRoot walks upward to .squad/team.md and returns null when absent', async () => {
  const rootScratch = await makeTempDir('root-');
  const absentScratch = await makeTempDir('absent-');
  const root = rootScratch.dir;
  const nested = join(root, 'a/b/c');
  const absent = absentScratch.dir;
  await mkdir(join(root, '.squad'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, '.squad/team.md'), FIXTURE_TEAM_MD);

  try {
    assert.equal(await resolveProjectRoot({ projectPath: nested }), root);
    assert.equal(await resolveProjectRoot({ projectPath: absent }), null);
  } finally {
    await rootScratch.cleanup();
    await absentScratch.cleanup();
  }
});

test('readSquadFiles reads a partial .squad fixture, caps summaries, and parses dashboard pricing', async () => {
  const scratch = await makeTempDir('read-');
  const root = scratch.dir;
  try {
    await mkdir(join(root, '.squad/decisions/inbox'), { recursive: true });
    await mkdir(join(root, '.squad/orchestration-log'), { recursive: true });
    await mkdir(join(root, '.squad/log'), { recursive: true });
    await mkdir(join(root, '.squad/agents/tester'), { recursive: true });
    await mkdir(join(root, '.squad/identity'), { recursive: true });
    await writeFile(join(root, '.squad/team.md'), FIXTURE_TEAM_MD);
    await writeFile(join(root, '.squad/dashboard.json'), JSON.stringify({ usdPerAiu: 2.75 }));
    await writeFile(join(root, '.squad/decisions.md'), '# Decisions\n');
    await writeFile(join(root, '.squad/decisions/inbox/test.md'), '### Inbox\n');
    await writeFile(join(root, '.squad/orchestration-log/001.md'), `# Heading\n${'x'.repeat(8_000)}`);
    await writeFile(join(root, '.squad/log/001.md'), 'log\n');
    await writeFile(join(root, '.squad/agents/tester/history.md'), 'history\n');
    await writeFile(join(root, '.squad/identity/now.md'), 'identity\n');

    const full = await readSquadFiles(root, { maxItems: 10 });
    assert.ok(full && typeof full === 'object');
    assert.ok(Array.isArray(full.roster), 'SquadFilesSnapshot includes parsed roster');
    assert.equal(full.roster.some((member) => member.id === 'tester'), true);
    assert.equal(full.pricingUsdPerAiu, 2.75);
    assert.equal(full.activity.some((item) => item.text === 'Heading'), true);

    const partialScratch = await makeTempDir('partial-');
    const partial = partialScratch.dir;
    await mkdir(join(partial, '.squad'), { recursive: true });
    await writeFile(join(partial, '.squad/team.md'), FIXTURE_TEAM_MD);
    const partialSnapshot = await readSquadFiles(partial, { maxItems: 10 });
    assert.ok(partialSnapshot && typeof partialSnapshot === 'object');
    assert.ok(Array.isArray(partialSnapshot.roster));
    await partialScratch.cleanup();
  } finally {
    await scratch.cleanup();
  }
});

test('watchSquadFiles emits classified events, supports pause/resume, and close stops delivery', { timeout: 10000 }, async () => {
  const scratch = await makeTempDir('watch-');
  const root = scratch.dir;
  const events = [];
  let watcher;
  try {
    await mkdir(join(root, '.squad/orchestration-log'), { recursive: true });
    watcher = watchSquadFiles(root, (fileEvent) => events.push(fileEvent));

    await writeFile(join(root, '.squad/orchestration-log/001.md'), 'spawned frontend\n');
    const first = await waitFor(
      () => events.find((fileEvent) => fileEvent.path?.endsWith('.squad/orchestration-log/001.md') || fileEvent.path?.endsWith('orchestration-log/001.md')),
      { timeout: 7000 },
    );
    assert.equal(first.kind, 'orchestration-log');
    assert.match(first.type, /^file\.(created|changed)$/);
    assert.equal(typeof first.timestamp, 'string');

    watcher.pause();
    const countBeforePauseWrite = events.length;
    await writeFile(join(root, '.squad/orchestration-log/002.md'), 'paused\n');
    await assert.rejects(
      waitFor(() => events.length > countBeforePauseWrite, { timeout: 500, interval: 25 }),
      /Timed out/,
    );
    assert.equal(events.length, countBeforePauseWrite);

    watcher.resume();
    await writeFile(join(root, '.squad/orchestration-log/003.md'), 'resumed\n');
    const resumed = await waitFor(
      () => events.find((fileEvent) => fileEvent.path?.endsWith('.squad/orchestration-log/003.md') || fileEvent.path?.endsWith('orchestration-log/003.md')),
      { timeout: 7000 },
    );
    assert.equal(resumed.kind, 'orchestration-log');

    watcher.close();
    const countAfterClose = events.length;
    await writeFile(join(root, '.squad/orchestration-log/004.md'), 'should not be delivered\n');
    await assert.rejects(
      waitFor(() => events.length > countAfterClose, { timeout: 750, interval: 25 }),
      /Timed out/,
    );
    assert.equal(events.length, countAfterClose);
  } finally {
    watcher?.close?.();
    await scratch.cleanup();
  }
});
