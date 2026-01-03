#!/usr/bin/env node

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function getVitestBin(rootDir) {
  const binName = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
  return path.join(rootDir, 'node_modules', '.bin', binName);
}

function listBenchFiles(rootDir) {
  const benchDir = path.join(rootDir, 'tests', 'benchmarks');
  const entries = fs.readdirSync(benchDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.bench.ts'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(benchDir, name));
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options); // NOSONAR

    child.on('close', (code, signal) => {
      resolve({ code: code ?? 0, signal: signal ?? null });
    });
  });
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const rootDir = path.resolve(__dirname, '..');
  const vitestBin = getVitestBin(rootDir);
  const configPath = path.join(rootDir, 'vitest.benchmark.config.mts');

  if (!fs.existsSync(vitestBin)) {
    process.stderr.write(`Vitest binary not found: ${vitestBin}\n`);
    process.stderr.write('Run `npm install` first.\n');
    process.exit(1);
  }

  const benchFiles = listBenchFiles(rootDir);
  if (benchFiles.length === 0) {
    process.stdout.write('No benchmark files found under tests/benchmarks.\n');
    process.exit(0);
  }

  for (const benchFile of benchFiles) {
    process.stdout.write(`\n=== Running benchmark: ${path.relative(rootDir, benchFile)} ===\n`);

    const args = [
      'bench',
      '--run',
      '--no-file-parallelism',
      '--maxWorkers',
      '1',
      '--config',
      configPath,
      benchFile,
    ];

    const { code, signal } = await runProcess(vitestBin, args, {
      cwd: rootDir,
      env: {
        ...process.env,
        LOG_LEVEL: 'error',
      },
      stdio: 'inherit',
    });

    if (signal) {
      process.stderr.write(`Benchmark process terminated by signal: ${signal}\n`);
      process.exit(1);
    }

    if (code !== 0) {
      process.stderr.write(`Benchmark failed with exit code: ${code}\n`);
      process.exit(code);
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
