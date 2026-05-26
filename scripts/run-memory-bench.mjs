#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = dirname(__dirname);

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
  process.exit(code ?? 0);
});
