/// <reference types="node" />

/**
 * Unit tests for statsPersistence (src/analyzer/stats/statsPersistence.ts).
 *
 * Uses a real temp directory (baseDir parameter) — no fs mocking.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushSession,
  getDefaultStatsDir,
  readAllSessions,
  rotate,
} from '../../../src/analyzer/stats/statsPersistence';
import type { SessionStatsSnapshot } from '../../../src/shared/sessionStats';

function makeSnapshot(overrides: Partial<SessionStatsSnapshot> = {}): SessionStatsSnapshot {
  return {
    schemaVersion: 1,
    sessionId: globalThis.crypto.randomUUID(),
    source: 'mcp',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    byTool: {
      generate_codemap: { calls: 1, jsonTokens: 100, toonTokens: 60, savings: 40, truncations: 0 },
    },
    totals: { calls: 1, jsonTokens: 100, toonTokens: 60, savings: 40, truncations: 0 },
    llmUsage: { calls: 0, tokensUsed: 0 },
    estimationMethod: 'chars/4 heuristic',
    ...overrides,
  };
}

function emptySnapshot(): SessionStatsSnapshot {
  return makeSnapshot({
    byTool: {},
    totals: { calls: 0, jsonTokens: 0, toonTokens: 0, savings: 0, truncations: 0 },
    llmUsage: { calls: 0, tokensUsed: 0 },
  });
}

describe('statsPersistence', () => {
  let baseDir: string;
  let originalNoStats: string | undefined;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-stats-test-'));
    originalNoStats = process.env.GRAPH_IT_NO_STATS;
    delete process.env.GRAPH_IT_NO_STATS;
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    if (originalNoStats !== undefined) {
      process.env.GRAPH_IT_NO_STATS = originalNoStats;
    } else {
      delete process.env.GRAPH_IT_NO_STATS;
    }
    vi.restoreAllMocks();
  });

  it('getDefaultStatsDir() points under homedir/.graph-it/stats', () => {
    const dir = getDefaultStatsDir();
    expect(dir).toBe(path.join(os.homedir(), '.graph-it', 'stats'));
  });

  it('flushSession + readAllSessions roundtrip', () => {
    const snapshot = makeSnapshot();
    flushSession(snapshot, baseDir);

    const files = fs.readdirSync(baseDir);
    expect(files).toEqual([`mcp-${snapshot.sessionId}.json`]);

    const sessions = readAllSessions(baseDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(snapshot);
  });

  it('flushSession creates the directory recursively when absent', () => {
    const nested = path.join(baseDir, 'a', 'b', 'stats');
    flushSession(makeSnapshot(), nested);
    expect(fs.readdirSync(nested)).toHaveLength(1);
  });

  it('flushSession leaves no temp files behind (atomic rename)', () => {
    flushSession(makeSnapshot(), baseDir);
    const leftovers = fs.readdirSync(baseDir).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('double flush of the same session yields a single coherent file (upsert)', () => {
    const snapshot = makeSnapshot();
    flushSession(snapshot, baseDir);
    const updated = { ...snapshot, endedAt: Date.now() + 5000 };
    flushSession(updated, baseDir);

    const files = fs.readdirSync(baseDir);
    expect(files).toHaveLength(1);
    const sessions = readAllSessions(baseDir);
    expect(sessions[0].endedAt).toBe(updated.endedAt);
  });

  it('flushSession skips empty sessions (no file written)', () => {
    flushSession(emptySnapshot(), baseDir);
    expect(fs.readdirSync(baseDir)).toEqual([]);
  });

  it('flushSession persists llm-only sessions', () => {
    const snapshot = emptySnapshot();
    snapshot.llmUsage = { calls: 2, tokensUsed: 900 };
    flushSession(snapshot, baseDir);
    expect(fs.readdirSync(baseDir)).toHaveLength(1);
  });

  it('GRAPH_IT_NO_STATS=1 disables persistence entirely', () => {
    process.env.GRAPH_IT_NO_STATS = '1';
    flushSession(makeSnapshot(), baseDir);
    expect(fs.readdirSync(baseDir)).toEqual([]);
  });

  it('readAllSessions returns [] when directory is absent', () => {
    const missing = path.join(baseDir, 'does-not-exist');
    expect(readAllSessions(missing)).toEqual([]);
  });

  it('readAllSessions skips corrupted files with a warning, without crashing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = makeSnapshot();
    flushSession(good, baseDir);
    fs.writeFileSync(path.join(baseDir, 'mcp-corrupted.json'), '{ not json !!!', 'utf8');

    const sessions = readAllSessions(baseDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(good.sessionId);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mcp-corrupted.json'));
  });

  it('readAllSessions skips files with wrong schema, with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(path.join(baseDir, 'mcp-badschema.json'), '{"schemaVersion":99}', 'utf8');

    expect(readAllSessions(baseDir)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mcp-badschema.json'));
  });

  it('readAllSessions ignores non-json files', () => {
    fs.writeFileSync(path.join(baseDir, 'notes.txt'), 'hello', 'utf8');
    expect(readAllSessions(baseDir)).toEqual([]);
  });

  it('rotate keeps at most 50 files per source, deleting the oldest by mtime', () => {
    // 55 mcp files with increasing mtimes + 3 cli files.
    for (let i = 0; i < 55; i++) {
      const file = path.join(baseDir, `mcp-session-${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(file, JSON.stringify(makeSnapshot()), 'utf8');
      const time = new Date(Date.now() - (55 - i) * 60_000);
      fs.utimesSync(file, time, time);
    }
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(baseDir, `cli-session-${i}.json`),
        JSON.stringify(makeSnapshot({ source: 'cli' })),
        'utf8',
      );
    }

    rotate(baseDir);

    const files = fs.readdirSync(baseDir);
    const mcpFiles = files.filter(f => f.startsWith('mcp-'));
    const cliFiles = files.filter(f => f.startsWith('cli-'));
    expect(mcpFiles).toHaveLength(50);
    expect(cliFiles).toHaveLength(3); // CLI never evicted by MCP volume
    // Oldest five mcp files (000..004) are gone.
    for (let i = 0; i < 5; i++) {
      expect(mcpFiles).not.toContain(`mcp-session-${String(i).padStart(3, '0')}.json`);
    }
    expect(mcpFiles).toContain('mcp-session-054.json');
  });

  it('rotate is a no-op when directory is absent', () => {
    expect(() => rotate(path.join(baseDir, 'missing'))).not.toThrow();
  });

  it('flushSession triggers rotation', () => {
    for (let i = 0; i < 50; i++) {
      const file = path.join(baseDir, `mcp-old-${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(file, JSON.stringify(makeSnapshot()), 'utf8');
      const time = new Date(Date.now() - (100 - i) * 60_000);
      fs.utimesSync(file, time, time);
    }

    flushSession(makeSnapshot(), baseDir);

    const mcpFiles = fs.readdirSync(baseDir).filter(f => f.startsWith('mcp-'));
    expect(mcpFiles).toHaveLength(50);
    expect(mcpFiles).not.toContain('mcp-old-000.json');
  });
});
