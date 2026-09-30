import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function makeScratch(prefix) {
  const safePrefix = String(prefix || 'scratch').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'scratch';
  const root = path.resolve('test', 'scratch');
  const processRoot = path.join(root, `${process.pid}-${randomBytes(6).toString('hex')}`);
  const dir = path.join(processRoot, `${safePrefix}-${Date.now()}-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  let cleaned = false;
  return {
    dir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(dir, { recursive: true, force: true });
      await removeIfEmpty(processRoot);
      await removeIfEmpty(root);
    },
  };
}

async function removeIfEmpty(dir) {
  try {
    const remaining = await readdir(dir);
    if (remaining.length === 0) await rmdir(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
  }
}
