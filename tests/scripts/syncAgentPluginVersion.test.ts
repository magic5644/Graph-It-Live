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
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const pluginDir = path.join(root, 'plugins', 'graph-it-live');
const { version } = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')) as {
  version: string;
};

function check(checkedVersion: string) {
  return spawnSync(
    process.execPath,
    ['scripts/sync-agent-plugin-version.mjs', '--check', checkedVersion],
    { cwd: root, encoding: 'utf8' },
  );
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

  it('reject a version that is not semver', () => {
    const result = check('latest');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid plugin version: latest');
  });
});
