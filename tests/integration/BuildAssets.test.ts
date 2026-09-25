import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const wasmSources = {
  'tree-sitter.wasm': 'web-tree-sitter/web-tree-sitter.wasm',
  'sqljs.wasm': 'sql.js/dist/sql-wasm.wasm',
  ...Object.fromEntries(['typescript', 'python', 'rust', 'c_sharp', 'go', 'java'].map(language => [
    `tree-sitter-${language}.wasm`, `tree-sitter-wasms/out/tree-sitter-${language}.wasm`,
  ])),
};

describe('Build assets', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(tmpdir(), 'graph-it-build-'));
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    for (const source of Object.values(wasmSources)) {
      const target = path.join(workspace, 'node_modules', source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    fs.cpSync(path.join(root, 'resources/queries'), path.join(workspace, 'resources/queries'), { recursive: true });
    for (const entry of ['analyzer/IndexerWorker', 'analyzer/ast/AstWorker', 'mcp/mcpServer', 'mcp/McpWorker', 'cli/index']) {
      const target = path.join(workspace, 'src', `${entry}.ts`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'export const fixture = true;');
    }
    fs.mkdirSync(path.join(workspace, 'dist/wasm'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'dist/queries'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('copies missing assets and replaces stale assets before the first watch build finishes', async () => {
    fs.writeFileSync(path.join(workspace, 'dist/wasm/tree-sitter.wasm'), 'stale');
    fs.writeFileSync(path.join(workspace, 'dist/queries/python.scm'), 'stale');
    const child = spawn(process.execPath, [path.join(root, 'esbuild.js'), '--cli-only', '--watch'], {
      cwd: workspace,
      timeout: 10_000,
    });
    const closed = once(child, 'close');
    let output = '';
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    try {
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', () => reject(new Error(`Watch exited before building: ${output}`)));
        child.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.includes('[watch] build finished')) resolve();
        });
      });
      for (const [name, source] of Object.entries(wasmSources)) {
        expect(fs.readFileSync(path.join(workspace, 'dist/wasm', name), 'utf8')).toBe(source);
      }
      for (const name of fs.readdirSync(path.join(workspace, 'resources/queries'))) {
        expect(fs.readFileSync(path.join(workspace, 'dist/queries', name)))
          .toEqual(fs.readFileSync(path.join(workspace, 'resources/queries', name)));
      }
    } finally {
      child.kill();
      await closed;
    }
  }, 15_000);

  it('fails watch startup when a required WASM source is missing', () => {
    fs.unlinkSync(path.join(workspace, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'));
    const result = spawnSync(process.execPath, [path.join(root, 'esbuild.js'), '--cli-only', '--watch'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 3_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed to copy node_modules/web-tree-sitter/web-tree-sitter.wasm');
  });

  it.each(['wasm/tree-sitter-go.wasm', 'queries/java.scm'])('post-build verifies current assets and rejects a missing %s', missing => {
    for (const [name, source] of Object.entries(wasmSources)) {
      fs.copyFileSync(path.join(workspace, 'node_modules', source), path.join(workspace, 'dist/wasm', name));
    }
    fs.cpSync(path.join(workspace, 'resources/queries'), path.join(workspace, 'dist/queries'), { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts/hooks/post-build'), path.join(workspace, 'post-build'));
    const valid = spawnSync('bash', ['post-build'], { cwd: workspace, encoding: 'utf8' });
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);

    // Keep the count unchanged: an unrelated asset must not hide a missing required file.
    fs.renameSync(path.join(workspace, 'dist', missing), path.join(workspace, 'dist', `${missing}.unexpected${path.extname(missing)}`));
    const invalid = spawnSync('bash', ['post-build'], { cwd: workspace, encoding: 'utf8' });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toContain(path.basename(missing));
  });
});
