/**
 * Agent plugin manifest drift tests
 *
 * scripts/sync-agent-plugin-version.mjs derives the Codex and Claude plugin
 * manifests, both MCP server files and the Claude marketplace entry from
 * plugins/graph-it-live/plugin.json and the published version. These tests
 * fail when a derived file drifts (fix with
 * `node scripts/sync-agent-plugin-version.mjs <version>`).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const pluginDir = path.join(root, 'plugins', 'graph-it-live');
const { version } = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')) as {
  version: string;
};

const script = path.join(root, 'scripts', 'sync-agent-plugin-version.mjs');
const syncedFiles = [
  'plugins/graph-it-live/plugin.json',
  'plugins/graph-it-live/.codex-plugin/plugin.json',
  'plugins/graph-it-live/.claude-plugin/plugin.json',
  'plugins/graph-it-live/mcp.json',
  'plugins/graph-it-live/.mcp.json',
  '.claude-plugin/marketplace.json',
];

function check(checkedVersion: string, cwd = root) {
  return spawnSync(process.execPath, [script, '--check', checkedVersion], {
    cwd,
    encoding: 'utf8',
  });
}

describe('agent plugin manifests', () => {
  it('match plugin.json and its version', () => {
    const result = check(version);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('pin the MCP server package instead of resolving @latest', () => {
    for (const file of ['mcp.json', '.mcp.json']) {
      const config = JSON.parse(fs.readFileSync(path.join(pluginDir, file), 'utf8')) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      expect(config.mcpServers['graph-it-live'].args).toEqual([
        '-y',
        '--prefer-offline',
        `@magic5644/graph-it-live@${version}`,
        'serve',
      ]);
    }
  });

  it('report every drifted file without writing in --check mode', () => {
    const before = fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8');
    const result = check('0.0.0-drift');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plugins/graph-it-live/.mcp.json');
    expect(result.stderr).toContain('.claude-plugin/marketplace.json');
    expect(fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8')).toBe(before);
  });

  it('ignore CRLF line endings from a Windows checkout', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-plugin-sync-'));
    try {
      for (const file of syncedFiles) {
        const target = path.join(copy, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const text = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
        fs.writeFileSync(target, text.replaceAll('\n', '\r\n'));
      }
      const result = check(version, copy);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('reject a version that is not semver', () => {
    const result = check('latest');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid plugin version: latest');
  });
});
