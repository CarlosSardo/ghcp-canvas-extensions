import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findPlaywrightModule() {
  if (process.env.PLAYWRIGHT_CORE_PATH) return process.env.PLAYWRIGHT_CORE_PATH;
  try {
    return require.resolve('playwright-core');
  } catch {}

  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  try {
    const entries = await readdir(npxRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(npxRoot, entry.name, 'node_modules', 'playwright-core');
      if (await exists(candidate)) return candidate;
    }
  } catch {}
  return null;
}

async function findChromeExecutable() {
  if (process.env.CHROME_PATH && await exists(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const pwCache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const entries = await readdir(pwCache, { withFileTypes: true });
    const chromiumDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const dir of chromiumDirs) {
      const candidate = path.join(pwCache, dir, 'chrome-linux64', 'chrome');
      if (await exists(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export async function launchBrowser(t) {
  const modulePath = await findPlaywrightModule();
  const executablePath = await findChromeExecutable();
  if (!modulePath || !executablePath) {
    const message = `Playwright browser unavailable (playwright-core: ${modulePath || 'not found'}, chrome: ${executablePath || 'not found'})`;
    if (process.env.SQUAD_DASHBOARD_REQUIRE_BROWSER || process.env.CI) {
      throw new Error(message);
    }
    t?.diagnostic?.(`${message}; skipping local browser runtime coverage`);
    t?.skip?.(message);
    return null;
  }

  const playwright = require(modulePath);
  return playwright.chromium.launch({ executablePath, args: ['--no-sandbox'] });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

export async function serveDir(rootDir, { routes } = {}) {
  const root = path.resolve(rootDir);
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const handler = routes?.[`${req.method || 'GET'} ${requestUrl.pathname}`] || routes?.[requestUrl.pathname];
      if (handler) {
        await handler(req, res, requestUrl);
        return;
      }

      const decoded = decodeURIComponent(requestUrl.pathname);
      const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
      const filePath = path.resolve(root, relative);
      if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const info = await stat(filePath);
      if (!info.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': contentType(filePath), 'content-length': info.size });
      createReadStream(filePath).pipe(res);
    } catch (error) {
      if (error?.code === 'ENOENT') res.writeHead(404).end('Not found');
      else res.writeHead(500).end('Internal server error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error?.stack || error?.message || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}
