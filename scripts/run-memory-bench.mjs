#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = dirname(__dirname);

async function cleanupSequenceCacheDirs() {
  const testsDir = join(rootDir, 'tests');
  const prefix = '.tmp-sequence-cache-';

  let entries;
  try {
    entries = await readdir(testsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const staleDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(testsDir, entry.name));

  await Promise.all(
    staleDirs.map((dirPath) => rm(dirPath, { recursive: true, force: true })),
  );
}

await cleanupSequenceCacheDirs();

const proc = spawn('npx', [
  'vitest',
  'run',
  '--config',
  'vitest.memory.config.mts',
], {
  cwd: rootDir,
  stdio: 'inherit',
});

process.on('SIGINT', () => proc.kill('SIGINT'));
process.on('SIGTERM', () => proc.kill('SIGTERM'));

proc.on('exit', (code) => {
  cleanupSequenceCacheDirs()
    .catch(() => {})
    .finally(() => {
      process.exit(code ?? 0);
    });
});
