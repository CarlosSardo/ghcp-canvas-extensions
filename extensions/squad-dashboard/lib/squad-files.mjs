import { promises as fsp, watch as fsWatch } from 'node:fs';
import path from 'node:path';

/**
 * File-side helpers for the dashboard.
 * - readSquadFiles reads only the roster, counts, recent activity metadata, and at most 4 KB per surfaced file.
 * - watchSquadFiles coalesces fs events, emits incremental file deltas, and can pause/resume to go idle with zero SSE clients.
 */

const SQUAD_DIR = '.squad';
const MAX_SUMMARY_BYTES = 4 * 1024;
const TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(Z|[+-]\d{2}:?\d{2})?/;
const TEMP_FILE_RE = /(^|[/\\])(?:\.scratch)(?:[/\\]|$)|(?:^|[/\\])(?:\.#|#)|(?:~$|\.sw[op]$|\.tmp$|\.temp$|\.DS_Store$)/i;

export function normalizeAgentKey(nameOrDescription) {
  let value = String(nameOrDescription ?? '').trim();
  if (!value) return '';

  value = value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();

  const colon = value.indexOf(':');
  if (colon >= 0) value = value.slice(0, colon);

  value = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^[^\p{L}\p{N}@]+/u, '')
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return value;
}

export function parseTeamMarkdown(markdown) {
  const members = parseSectionTable(markdown, 'Members').map((row) => toRosterMember(row, 'member'));
  const codingRows = parseSectionTable(markdown, 'Coding Agent').map((row) => toRosterMember(row, 'coding'));
  const codingAgent = codingRows[0];
  return {
    roster: [...members, ...codingRows],
    ...(codingAgent ? { codingAgent } : {}),
  };
}

export async function resolveProjectRoot({ projectPath, cwd, sessionWorkingDirectory } = {}) {
  const candidates = [projectPath, sessionWorkingDirectory, cwd, process.cwd()].filter(Boolean);
  const seen = new Set();

  for (const candidate of candidates) {
    let current = path.resolve(String(candidate));
    if (seen.has(current)) continue;
    seen.add(current);

    try {
      const stat = await fsp.stat(current);
      if (!stat.isDirectory()) current = path.dirname(current);
    } catch {
      // The candidate may be stale. Still walk its lexical parents.
    }

    const root = await findSquadRoot(current);
    if (root) return root;
  }

  return null;
}

export async function readSquadFiles(projectRoot, { maxItems = 50 } = {}) {
  const snapshot = {
    projectRoot: projectRoot ?? null,
    noSquad: true,
    roster: [],
    files: {
      decisionsInboxCount: 0,
      orchestrationLogCount: 0,
      logCount: 0,
    },
    activity: [],
    errors: [],
  };

  if (!projectRoot) return snapshot;

  const squadRoot = path.join(projectRoot, SQUAD_DIR);
  const canonicalSquadRoot = await canonicalDirectory(squadRoot);
  const teamPath = path.join(squadRoot, 'team.md');
  const teamMarkdown = await readTextIfExists(teamPath, snapshot.errors);
  if (teamMarkdown == null) return snapshot;

  const parsed = parseTeamMarkdown(teamMarkdown);
  snapshot.noSquad = false;
  snapshot.roster = parsed.roster;
  if (parsed.codingAgent) snapshot.codingAgent = parsed.codingAgent;

  const dashboardConfig = await readDashboardConfig(path.join(squadRoot, 'dashboard.json'), snapshot.errors);
  if (dashboardConfig.usdPerAiu != null) snapshot.pricingUsdPerAiu = dashboardConfig.usdPerAiu;

  const orchestrationFiles = await listMarkdownFiles(path.join(squadRoot, 'orchestration-log'), snapshot.errors);
  const logFiles = await listMarkdownFiles(path.join(squadRoot, 'log'), snapshot.errors);
  const inboxFiles = await listMarkdownFiles(path.join(squadRoot, 'decisions', 'inbox'), snapshot.errors);
  const historyFiles = await listAgentHistoryFiles(path.join(squadRoot, 'agents'), snapshot.errors);
  const singletonFiles = [
    path.join(squadRoot, 'decisions.md'),
    path.join(squadRoot, 'identity', 'now.md'),
  ];

  snapshot.files.decisionsInboxCount = inboxFiles.length;
  snapshot.files.orchestrationLogCount = orchestrationFiles.length;
  snapshot.files.logCount = logFiles.length;

  const candidates = [
    ...orchestrationFiles,
    ...logFiles,
    ...inboxFiles,
    ...historyFiles,
    ...singletonFiles,
  ];

  const metas = (await Promise.all(candidates.map((filePath) => fileMetadata(projectRoot, filePath, snapshot.errors, canonicalSquadRoot))))
    .filter(Boolean)
    .sort((a, b) => b.timestampMs - a.timestampMs || a.relative.localeCompare(b.relative))
    .slice(0, maxItems);

  const activity = await Promise.all(metas.map(async (meta) => {
    const title = await readFirstHeading(meta.filePath, snapshot.errors, canonicalSquadRoot);
    return {
      id: `file:${meta.relative}:${meta.timestamp}`,
      timestamp: meta.timestamp,
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
      level: 'info',
      text: title || fileActivityText(meta.kind, meta.relative),
      source: 'file',
      path: meta.relative,
      kind: meta.kind,
    };
  }));

  snapshot.activity = activity;
  if (metas[0]) snapshot.files.lastFileActivityAt = metas[0].timestamp;

  return snapshot;
}

export function watchSquadFiles(projectRoot, onFileEvent, { signal } = {}) {
  const squadRoot = projectRoot ? path.join(projectRoot, SQUAD_DIR) : null;
  const watchers = new Set();
  const watchedDirs = new Set();
  const pending = new Map();
  let timer = null;
  let closed = false;
  let paused = false;
  let recursiveMode = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const stopWatchers = () => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore close failures
      }
    }
    watchers.clear();
    watchedDirs.clear();
    recursiveMode = false;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimer();
    pending.clear();
    stopWatchers();
  };

  if (!squadRoot || signal?.aborted) return { close, pause() {}, resume() {} };
  signal?.addEventListener?.('abort', close, { once: true });

  const emit = (payload) => {
    try {
      onFileEvent(payload);
    } catch {
      // Watchers must not crash the extension.
    }
  };

  const addWatcher = (dir, options = {}) => {
    if (watchedDirs.has(dir)) return true;
    try {
      const watcher = fsWatch(dir, options, (eventType, filename) => {
        if (closed || paused) return;
        const changedPath = filename ? path.join(dir, String(filename)) : dir;
        schedule(changedPath, eventType);
      });
      watcher.on?.('error', () => {});
      watchers.add(watcher);
      watchedDirs.add(dir);
      return true;
    } catch {
      return false;
    }
  };

  const startWatchers = async () => {
    if (closed || paused || !squadRoot) return;
    stopWatchers();
    recursiveMode = addWatcher(squadRoot, { recursive: true });
    if (recursiveMode) return;
    const dirs = await collectWatchDirs(squadRoot);
    if (closed || paused) return;
    for (const dir of dirs) addWatcher(dir);
  };

  const flush = async () => {
    timer = null;
    const entries = [...pending.entries()];
    pending.clear();

    for (const [filePath, fsEventType] of entries) {
      if (closed || paused || shouldIgnorePath(filePath)) continue;

      let stat = null;
      try {
        stat = await fsp.stat(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') continue;
      }

      if (stat?.isDirectory()) {
        if (!recursiveMode) addWatcher(filePath);
        continue;
      }

      const type = fsEventType === 'rename'
        ? (stat ? 'file.created' : 'file.deleted')
        : 'file.changed';
      const classified = classifySquadPath(projectRoot, filePath);
      emit({
        type,
        path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
        kind: classified.kind,
        ...(classified.agentId ? { agentId: classified.agentId } : {}),
        timestamp: new Date().toISOString(),
      });
    }
  };

  const schedule = (changedPath, eventType) => {
    if (closed || paused || !changedPath || shouldIgnorePath(changedPath)) return;
    pending.set(changedPath, eventType);
    clearTimer();
    timer = setTimeout(() => {
      flush().catch(() => {});
    }, 120);
    timer.unref?.();
  };

  const pause = () => {
    if (closed || paused) return;
    paused = true;
    clearTimer();
    pending.clear();
    stopWatchers();
  };

  const resume = () => {
    if (closed || !paused) return;
    paused = false;
    startWatchers().catch(() => {});
  };

  startWatchers().catch(() => {});

  return { close, pause, resume };
}

function parseSectionTable(markdown, heading) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##+\\s+${escapeRegExp(heading)}\\s*$`, 'i').test(line.trim()));
  if (start < 0) return [];

  const section = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    section.push(lines[i]);
  }

  const headerIndex = section.findIndex((line, index) => isTableRow(line) && isSeparatorRow(section[index + 1]));
  if (headerIndex < 0) return [];

  const headers = splitTableRow(section[headerIndex]).map((cell) => normalizeHeader(cell));
  const rows = [];
  for (let i = headerIndex + 2; i < section.length; i += 1) {
    if (!isTableRow(section[i])) break;
    const cells = splitTableRow(section[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cleanCell(cells[index] ?? '');
    });
    rows.push(row);
  }
  return rows;
}

function toRosterMember(row, tableKind) {
  const name = row.name ?? '';
  const badge = row.status || undefined;
  const charter = row.charter && row.charter !== '—' ? row.charter : undefined;
  let kind = tableKind === 'coding' ? 'coding' : 'member';
  if (/👤|human/i.test(badge ?? '')) kind = 'human';
  const id = /^@?copilot$/i.test(name.trim()) ? 'copilot' : normalizeAgentKey(name);
  return {
    id,
    name: cleanCell(name),
    role: row.role || undefined,
    charter,
    badge,
    kind,
  };
}

async function findSquadRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, SQUAD_DIR, 'team.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readTextIfExists(filePath, errors) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') errors?.push?.(`${path.basename(filePath)}: ${error.message}`);
    return null;
  }
}

async function readDashboardConfig(filePath, errors) {
  const text = await readTextIfExists(filePath, errors);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    const usdPerAiu = Number(parsed?.usdPerAiu);
    return Number.isFinite(usdPerAiu) && usdPerAiu >= 0 ? { usdPerAiu } : {};
  } catch (error) {
    errors?.push?.(`${path.basename(filePath)}: ${error.message}`);
    return {};
  }
}

async function listMarkdownFiles(dir, errors) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !shouldIgnorePath(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if (error?.code !== 'ENOENT') errors?.push?.(`${dir}: ${error.message}`);
    return [];
  }
}

async function listAgentHistoryFiles(agentsDir, errors) {
  try {
    const entries = await fsp.readdir(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '_alumni')
      .map((entry) => path.join(agentsDir, entry.name, 'history.md'));
  } catch (error) {
    if (error?.code !== 'ENOENT') errors?.push?.(`${agentsDir}: ${error.message}`);
    return [];
  }
}

async function canonicalDirectory(dir) {
  try {
    return await fsp.realpath(dir);
  } catch {
    return null;
  }
}

function isInsideDirectory(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function fileMetadata(projectRoot, filePath, errors, canonicalSquadRoot) {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || shouldIgnorePath(filePath)) return null;
    if (stat.isSymbolicLink()) return null;

    if (canonicalSquadRoot) {
      const real = await fsp.realpath(filePath);
      if (!isInsideDirectory(canonicalSquadRoot, real)) return null;
    }

    const relative = path.relative(projectRoot, filePath).split(path.sep).join('/');
    const classified = classifySquadPath(projectRoot, filePath);
    const timestamp = timestampFromFilename(path.basename(filePath)) ?? stat.mtime.toISOString();
    const timestampMs = Date.parse(timestamp);

    return {
      filePath,
      relative,
      kind: classified.kind,
      agentId: classified.agentId,
      timestamp,
      timestampMs: Number.isNaN(timestampMs) ? stat.mtimeMs : timestampMs,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') errors?.push?.(`${filePath}: ${error.message}`);
    return null;
  }
}

async function readFirstHeading(filePath, errors, canonicalSquadRoot) {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (canonicalSquadRoot) {
      const real = await fsp.realpath(filePath);
      if (!isInsideDirectory(canonicalSquadRoot, real)) return null;
    }
    const handle = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(MAX_SUMMARY_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const heading = text.split(/\r?\n/).find((line) => /^#{1,3}\s+\S/.test(line.trim()));
      if (heading) return heading.replace(/^#{1,3}\s+/, '').trim();
      const fallback = text.split(/\r?\n/).find((line) => line.trim());
      return fallback?.trim() || null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') errors?.push?.(`${filePath}: ${error.message}`);
    return null;
  }
}

function fileActivityText(kind, relative) {
  const name = path.basename(relative, '.md').replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:Z|[+-]\d{4})?-?/, '');
  const readable = name ? name.replace(/[-_]+/g, ' ') : relative;
  switch (kind) {
    case 'decision':
      return 'Decisions updated';
    case 'decision-inbox':
      return `Decision inbox: ${readable}`;
    case 'orchestration-log':
      return `Orchestration log: ${readable}`;
    case 'log':
      return `Squad log: ${readable}`;
    case 'history':
      return `Agent history updated: ${readable}`;
    case 'identity':
      return 'Squad identity updated';
    default:
      return relative;
  }
}

function timestampFromFilename(filename) {
  const match = TIMESTAMP_RE.exec(filename);
  if (!match) return null;
  const [, dateHour, minute, second, offsetRaw = ''] = match;
  let offset = offsetRaw;
  if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const iso = `${dateHour}:${minute}:${second}${offset || ''}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function classifySquadPath(projectRoot, filePath) {
  const relative = path.relative(path.join(projectRoot, SQUAD_DIR), filePath).split(path.sep).join('/');
  const segments = relative.split('/');
  if (segments[0] === 'team.md') return { kind: 'team' };
  if (segments[0] === 'routing.md') return { kind: 'routing' };
  if (segments[0] === 'decisions.md') return { kind: 'decision' };
  if (segments[0] === 'decisions' && segments[1] === 'inbox') {
    return { kind: 'decision-inbox', agentId: agentIdFromInboxFilename(path.basename(filePath)) };
  }
  if (segments[0] === 'orchestration-log') {
    return { kind: 'orchestration-log', agentId: agentIdFromDatedFilename(path.basename(filePath)) };
  }
  if (segments[0] === 'log') return { kind: 'log' };
  if (segments[0] === 'agents' && segments[2] === 'history.md') {
    return { kind: 'history', agentId: normalizeAgentKey(segments[1]) };
  }
  if (segments[0] === 'identity') return { kind: 'identity' };
  return { kind: 'unknown' };
}

function agentIdFromDatedFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  const agent = stem.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:Z|[+-]\d{4})?-?/, '');
  return normalizeAgentKey(agent);
}

function agentIdFromInboxFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  const dated = agentIdFromDatedFilename(filename);
  if (dated && dated !== normalizeAgentKey(stem)) return dated;
  const knownMultiWord = ['fact-checker', 'carlos-sardo'];
  const normalized = normalizeAgentKey(stem);
  const known = knownMultiWord.find((prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`));
  if (known) return known;
  return normalizeAgentKey(stem.split('-')[0]);
}

async function collectWatchDirs(root) {
  const dirs = [];
  const walk = async (dir, depth = 0) => {
    if (depth > 3 || shouldIgnorePath(dir)) return;
    dirs.push(dir);
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !shouldIgnorePath(entry.name))
      .map((entry) => walk(path.join(dir, entry.name), depth + 1)));
  };
  await walk(root);
  return dirs;
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shouldIgnorePath(filePath) {
  return TEMP_FILE_RE.test(filePath.split(path.sep).join('/'));
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line ?? '');
}

function isSeparatorRow(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line ?? '');
}

function splitTableRow(line) {
  const cells = [];
  let cell = '';
  const text = String(line ?? '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function cleanCell(cell) {
  return String(cell ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeader(cell) {
  return cleanCell(cell).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
