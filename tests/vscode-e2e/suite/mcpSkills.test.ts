/**
 * The MCP server the extension starts (graph-it-live.enableMcpServer) serves the
 * bundled agent skills (#837). It runs the installed extension's
 * dist/mcpServer.mjs with the command, arguments and environment that
 * McpServerProvider gives VS Code, so a VSIX without dist/skills/ fails here.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

interface Reply {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Raw JSON-RPC over the server's stdio: one request at a time, answered by id. */
function startServer(serverPath: string, workspaceRoot: string, extensionPath: string) {
  // Same definition as McpServerProvider.provideMcpServerDefinitions: `node <serverPath>`.
  const child: ChildProcessWithoutNullStreams = spawn('node', [serverPath], {
    cwd: workspaceRoot,
    env: { ...process.env, WORKSPACE_ROOT: workspaceRoot, EXTENSION_PATH: extensionPath },
  });
  const pending = new Map<number, (reply: Reply) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter((l) => l.startsWith('{'))) {
      const reply = JSON.parse(line) as Reply;
      pending.get(reply.id)?.(reply);
    }
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method}: no response`)), 60_000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { child, request };
}

suite('MCP server skills (#837)', () => {
  test('the server the extension starts declares the Skills extension and serves the five skills', async function () {
    this.timeout(120_000);
    const extension = vscode.extensions.getExtension('magic5644.graph-it-live');
    assert.ok(extension, 'extension installed');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'test workspace open');
    const { child, request } = startServer(path.join(extension.extensionPath, 'dist', 'mcpServer.mjs'), workspaceRoot, extension.extensionPath);
    try {
      const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vscode-e2e', version: '1' } });
      const capabilities = init.result?.capabilities as { extensions?: Record<string, unknown> };
      assert.ok(capabilities.extensions?.[SKILLS_EXTENSION], `capabilities: ${JSON.stringify(capabilities)}`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const { skills } = (await request('skills/list')).result as { skills: { frontmatter: { name: string } }[] };
      assert.deepStrictEqual(
        skills.map((skill) => skill.frontmatter.name),
        ['dead-code-hunter', 'graph-it-live', 'graph-it-refactor', 'onboarding-express', 'pr-review'],
      );
      const read = await request('resources/read', { uri: 'skill://pr-review/SKILL.md' });
      const [content] = (read.result as { contents: { text: string }[] }).contents;
      assert.match(content.text, /^---\nname: pr-review\n/);

      const outside = await request('resources/read', { uri: 'skill://pr-review/../../../package.json' });
      assert.strictEqual(outside.result, undefined);
      assert.ok(outside.error, 'a URI leaving the catalog is an MCP error');
    } finally {
      child.kill();
    }
  });
});
