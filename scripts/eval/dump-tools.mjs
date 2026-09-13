#!/usr/bin/env node
/**
 * Dump the MCP server's advertised tool list (tools/list) to a JSON snapshot.
 *
 * Run against a built dist/mcpServer.mjs. Snapshots let the tool-selection eval
 * compare description revisions without rebuilding between runs:
 *
 *   git checkout main      && npm run build && node scripts/eval/dump-tools.mjs /tmp/tools.main.json
 *   git checkout my-branch && npm run build && node scripts/eval/dump-tools.mjs /tmp/tools.new.json
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node scripts/eval/dump-tools.mjs <output.json> [serverPath]');
  process.exit(2);
}
const serverPath = process.argv[3] ?? path.resolve('dist/mcpServer.mjs');
const TIMEOUT_MS = 30_000;

const child = spawn('node', [serverPath], {
  env: { ...process.env, WORKSPACE_ROOT: process.cwd() },
  stdio: ['pipe', 'pipe', 'ignore'],
});

const timer = setTimeout(() => {
  console.error(`Timed out after ${TIMEOUT_MS}ms waiting for tools/list`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // non-JSON stdout noise
    }
    if (message.id !== 2) continue;

    const tools = message.result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Parameter names only: the eval asks which tool to call, not with what.
      parameters: Object.keys(tool.inputSchema?.properties ?? {}),
    }));
    const descriptionChars = tools.reduce((sum, t) => sum + t.description.length, 0);
    writeFileSync(outPath, `${JSON.stringify({ tools, descriptionChars }, null, 2)}\n`);
    console.log(`${outPath}: ${tools.length} tools, ${descriptionChars} description chars`);
    clearTimeout(timer);
    child.kill();
    process.exit(0);
  }
});

child.on('error', (error) => {
  console.error(`Failed to start ${serverPath}: ${error.message}`);
  process.exit(1);
});

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tool-selection-eval', version: '1' },
  },
});
setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
}, 1500);
