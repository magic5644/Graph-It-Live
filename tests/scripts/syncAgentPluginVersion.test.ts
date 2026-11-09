/**
 * Agent plugin manifest drift tests
 *
 * scripts/sync-agent-plugin-version.mjs derives the Codex and Claude plugin
 * manifests, both MCP server files and the Claude and Copilot marketplace entries from
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
  '.github/plugin/marketplace.json',
];
const copilotMarketplace = '.github/plugin/marketplace.json';

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function check(checkedVersion: string, cwd = root) {
  return run(cwd, '--check', checkedVersion);
}

/** Copies every synced file into a temp workspace, optionally with CRLF line endings. */
function copyWorkspace(crlf = false) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-plugin-sync-'));
  for (const file of syncedFiles) {
    const target = path.join(copy, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const text = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
    fs.writeFileSync(target, crlf ? text.replaceAll('\n', '\r\n') : text);
  }
  return copy;
}

type Marketplace = { plugins: Record<string, string>[] };

function editMarketplace(cwd: string, file: string, edit: (entry: Record<string, string>) => void) {
  const target = path.join(cwd, file);
  const catalog = JSON.parse(fs.readFileSync(target, 'utf8')) as Marketplace;
  edit(catalog.plugins[0]);
  fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`);
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
    expect(result.stderr).toContain(copilotMarketplace);
    expect(fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8')).toBe(before);
  });

  it('ignore CRLF line endings from a Windows checkout', () => {
    const copy = copyWorkspace(true);
    try {
      const result = check(version, copy);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('keep the Copilot marketplace identical to the Claude marketplace', () => {
    const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
    expect(read(copilotMarketplace)).toBe(read('.claude-plugin/marketplace.json'));
    const [entry] = (JSON.parse(read(copilotMarketplace)) as Marketplace).plugins;
    expect(entry).toMatchObject({ name: 'graph-it-live', source: './plugins/graph-it-live', version });
  });

  it.each(['name', 'description', 'source', 'version'])(
    'flag a Copilot marketplace %s that disagrees with the Claude marketplace',
    (field) => {
      const copy = copyWorkspace();
      try {
        editMarketplace(copy, copilotMarketplace, (entry) => {
          entry[field] = `drifted-${field}`;
        });
        const result = check(version, copy);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(copilotMarketplace);
        expect(result.stderr).not.toContain('.claude-plugin/marketplace.json');
      } finally {
        fs.rmSync(copy, { recursive: true, force: true });
      }
    },
  );

  it('flag a Claude marketplace source that does not point at the plugin directory', () => {
    const copy = copyWorkspace();
    try {
      editMarketplace(copy, '.claude-plugin/marketplace.json', (entry) => {
        entry.source = './plugins/elsewhere';
      });
      const result = check(version, copy);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('.claude-plugin/marketplace.json');
      expect(result.stderr).not.toContain(copilotMarketplace);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('flag a missing Copilot marketplace in --check mode and create it otherwise', () => {
    const copy = copyWorkspace();
    try {
      fs.rmSync(path.join(copy, '.github'), { recursive: true });
      const result = check(version, copy);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(copilotMarketplace);
      expect(fs.existsSync(path.join(copy, copilotMarketplace))).toBe(false);

      const written = run(copy, version);
      expect(written.status).toBe(0);
      expect(written.stdout).toContain(copilotMarketplace);
      expect(fs.readFileSync(path.join(copy, copilotMarketplace), 'utf8')).toBe(
        fs.readFileSync(path.join(copy, '.claude-plugin/marketplace.json'), 'utf8'),
      );
      expect(check(version, copy).status).toBe(0);
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
