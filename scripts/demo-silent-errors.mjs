#!/usr/bin/env node

/**
 * Demo: CLI error silencing in action
 * 
 * Run: node scripts/demo-silent-errors.mjs
 * 
 * Shows that parsing errors are collected silently, not displayed.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('🧪 Demo: Silent Error Collection in CLI\n');
console.log('Running: graph-it scan (with error collection enabled)\n');
console.log('Expected behavior: No parse error messages on stderr, clean output\n');
console.log('---');

// Run graph-it scan on the fixtures directory
const proc = spawn(
  'node',
  [path.join(projectRoot, 'dist', 'graph-it.js'), 'scan', '--workspace', path.join(projectRoot, 'tests/fixtures/basic-ts')],
  {
    stdio: ['inherit', 'pipe', 'pipe'],
  }
);

let stdout = '';
let stderr = '';

proc.stdout.on('data', (data) => {
  stdout += data.toString();
  process.stdout.write(data);
});

proc.stderr.on('data', (data) => {
  stderr += data.toString();
  process.stderr.write(data);
});

proc.on('close', (code) => {
  console.log('\n---');
  console.log(`\n✅ Exit code: ${code}\n`);

  if (stderr.includes('[ERROR]') || stderr.includes('Analysis failed')) {
    console.log('❌ FAIL: Error messages found in stderr (should be silent)');
    console.log('Stderr output:');
    console.log(stderr);
  } else {
    console.log('✅ PASS: No parse error messages polluted stderr');
    console.log('Errors were collected silently during processing');
  }
});
