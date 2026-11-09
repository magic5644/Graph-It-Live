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
  CL100K_COUNTING_SINCE,
  getDefaultStatsDir,
  PERIODIC_FLUSH_DELAY_MS,
  readAllSessions,
  readCumulative,
  rotate,
  startPeriodicFlush,
  summarizeSessions,
} from '../../../src/analyzer/stats/statsPersistence';
import { SessionStatsCollector, type SessionStatsSnapshot } from '../../../src/shared/sessionStats';

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
    estimationMethod: 'cl100k_base',
    ...overrides,
  };
}

/** Session files only: the cumulative totals file sits next to them. */
function sessionFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f !== 'cumulative.totals');
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

  describe('sessions written by older releases', () => {
    // Written as an older release did: a raw file, not through flushSession.
    const writeRaw = (snapshot: unknown, id: string) => fs.writeFileSync(path.join(baseDir, `mcp-${id}.json`), JSON.stringify(snapshot));

    it('loads a session counted with cl100k_base but labelled chars/4, under the cl100k_base label', () => {
      const mislabelled = { ...makeSnapshot(), estimationMethod: 'chars/4 heuristic', startedAt: CL100K_COUNTING_SINCE };
      writeRaw(mislabelled, mislabelled.sessionId);

      expect(readAllSessions(baseDir)).toEqual([{ ...mislabelled, estimationMethod: 'cl100k_base' }]);
    });

    it('skips a session started before v1.14.1, counted as chars/4, so history never mixes units', () => {
      const charsBased = { ...makeSnapshot(), estimationMethod: 'chars/4 heuristic', startedAt: CL100K_COUNTING_SINCE - 1 };
      writeRaw(charsBased, charsBased.sessionId);
      const current = makeSnapshot({ source: 'cli' });
      flushSession(current, baseDir);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(readAllSessions(baseDir)).toEqual([current]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('rejects a session without a numeric startedAt as invalid', () => {
      writeRaw({ ...makeSnapshot(), startedAt: 'yesterday' }, 'bad');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(readAllSessions(baseDir)).toEqual([]);
      expect(warn).toHaveBeenCalledWith('graph-it stats: skipping invalid stats file: mcp-bad.json');
    });
  });

  it('flushSession + readAllSessions roundtrip', () => {
    const snapshot = makeSnapshot();
    flushSession(snapshot, baseDir);

    expect(sessionFiles(baseDir)).toEqual([`mcp-${snapshot.sessionId}.json`]);

    const sessions = readAllSessions(baseDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(snapshot);
  });

  it('flushSession creates the directory recursively when absent', () => {
    const nested = path.join(baseDir, 'a', 'b', 'stats');
    flushSession(makeSnapshot(), nested);
    expect(sessionFiles(nested)).toHaveLength(1);
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

    expect(sessionFiles(baseDir)).toHaveLength(1);
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
    expect(sessionFiles(baseDir)).toHaveLength(1);
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
  it('rotate never lets vscode sessions evict cli or mcp ones', () => {
    for (let i = 0; i < 55; i++) {
      fs.writeFileSync(path.join(baseDir, `vscode-${i}.json`), '{}', 'utf8');
    }
    for (const source of ['cli', 'mcp']) {
      const file = path.join(baseDir, `${source}-old.json`);
      fs.writeFileSync(file, '{}', 'utf8');
      const past = new Date(Date.now() - 3_600_000);
      fs.utimesSync(file, past, past);
    }
    rotate(baseDir);
    const files = fs.readdirSync(baseDir);
    expect(files.filter(f => f.startsWith('vscode-'))).toHaveLength(50);
    expect(files).toEqual(expect.arrayContaining(['cli-old.json', 'mcp-old.json']));
  });

  describe('summarizeSessions', () => {
    it('aggregates by source and adds an all-sources total', () => {
      const summary = summarizeSessions([
        makeSnapshot(),
        makeSnapshot({ source: 'vscode' }),
        makeSnapshot({ source: 'vscode', llmUsage: { calls: 1, tokensUsed: 50 } }),
      ]);
      expect(summary.persistedSessions).toBe(3);
      expect(summary.bySource.mcp).toMatchObject({ sessions: 1, calls: 1, jsonTokens: 100 });
      expect(summary.bySource.vscode).toMatchObject({ sessions: 2, calls: 2, llmTokensUsed: 50 });
      expect(summary.total).toEqual({
        sessions: 3, calls: 3, jsonTokens: 300, toonTokens: 180, savings: 120, truncations: 0, llmCalls: 1, llmTokensUsed: 50,
      });
    });

    it('returns zero totals for no session', () => {
      const summary = summarizeSessions([]);
      expect(summary).toMatchObject({ persistedSessions: 0, bySource: {} });
      expect(summary.total.sessions).toBe(0);
    });
  });

  describe('cumulative totals', () => {
    const cumulativePath = () => path.join(baseDir, 'cumulative.totals');

    it('is undefined before any session is written', () => {
      expect(readCumulative(baseDir)).toBeUndefined();
    });

    it('counts a session once, however often it is rewritten', () => {
      const snapshot = makeSnapshot();
      flushSession(snapshot, baseDir);
      flushSession({ ...snapshot, totals: { ...snapshot.totals, calls: 4 } }, baseDir);

      const cumulative = readCumulative(baseDir);
      expect(cumulative?.total).toMatchObject({ sessions: 1, calls: 4 });
      expect(cumulative?.since).toBe(new Date(snapshot.startedAt).toISOString());
    });

    it('survives rotation and keeps the date of the first session', () => {
      const first = makeSnapshot({ startedAt: Date.now() - 86_400_000 });
      flushSession(first, baseDir);
      const firstFile = path.join(baseDir, `mcp-${first.sessionId}.json`);
      const past = new Date(Date.now() - 3_600_000);
      fs.utimesSync(firstFile, past, past);

      let last = makeSnapshot();
      for (let i = 0; i < 50; i++) {
        last = makeSnapshot();
        flushSession(last, baseDir);
      }
      expect(fs.existsSync(firstFile)).toBe(false);
      flushSession(last, baseDir); // rewrite after rotation: still counted once

      const cumulative = readCumulative(baseDir);
      expect(cumulative?.total).toMatchObject({ sessions: 51, calls: 51 });
      expect(cumulative?.bySource.mcp?.sessions).toBe(51);
      expect(cumulative?.since).toBe(new Date(first.startedAt).toISOString());
      expect(summarizeSessions(readAllSessions(baseDir)).total.sessions).toBe(50);
    });

    it('counts once a session evicted by rotation then rewritten by its live process', () => {
      const live = makeSnapshot();
      flushSession(live, baseDir);
      const liveFile = path.join(baseDir, `mcp-${live.sessionId}.json`);
      const past = new Date(Date.now() - 3_600_000);
      fs.utimesSync(liveFile, past, past);
      for (let i = 0; i < 50; i++) flushSession(makeSnapshot(), baseDir);
      expect(fs.existsSync(liveFile)).toBe(false);
      expect(readCumulative(baseDir)?.total.calls).toBe(51);

      flushSession({ ...live, totals: { ...live.totals, calls: 3 } }, baseDir);
      const cumulative = readCumulative(baseDir);
      // live counts once (3 calls), the 50 others once each; the oldest of them was evicted in turn.
      expect(cumulative?.total).toMatchObject({ sessions: 51, calls: 53 });
    });

    it('folds the oldest evicted sessions into sums beyond 500 tracked', () => {
      const evicted = Object.fromEntries(
        Array.from({ length: 501 }, (_, i) => [`cli-old-${i}.json`, { ...makeSnapshot({ source: 'cli' }), startedAt: CL100K_COUNTING_SINCE + i }]),
      );
      fs.writeFileSync(cumulativePath(), JSON.stringify({ schemaVersion: 1, since: CL100K_COUNTING_SINCE, retired: {}, evicted, sessions: {} }));
      flushSession(makeSnapshot(), baseDir);

      const file = JSON.parse(fs.readFileSync(cumulativePath(), 'utf8'));
      expect(Object.keys(file.evicted)).toHaveLength(500);
      expect(file.evicted['cli-old-0.json']).toBeUndefined();
      expect(file.retired.cli.sessions).toBe(1);
      expect(readCumulative(baseDir)?.total.sessions).toBe(502);
    });

    it('loads a file written without the evicted map', () => {
      const old = makeSnapshot({ source: 'cli' });
      fs.writeFileSync(cumulativePath(), JSON.stringify({
        schemaVersion: 1, since: old.startedAt, retired: { cli: { sessions: 2, calls: 5 } }, sessions: {},
      }));
      expect(readCumulative(baseDir)?.total).toMatchObject({ sessions: 2, calls: 5, jsonTokens: 0 });
    });

    it('starts from the history older releases left on disk', () => {
      const old = makeSnapshot({ source: 'cli', startedAt: CL100K_COUNTING_SINCE + 1 });
      fs.writeFileSync(path.join(baseDir, `cli-${old.sessionId}.json`), JSON.stringify(old));
      flushSession(makeSnapshot(), baseDir);

      const cumulative = readCumulative(baseDir);
      expect(cumulative?.total.sessions).toBe(2);
      expect(cumulative?.since).toBe(new Date(old.startedAt).toISOString());
    });

    it.each([
      ['corrupted', '{ not json'],
      ['unknown format', '{"schemaVersion":2,"since":1}'],
    ])('tolerates a %s file: warns, then rebuilds it from the sessions on disk', (_label, content) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(cumulativePath(), content);
      expect(readCumulative(baseDir)).toBeUndefined();

      flushSession(makeSnapshot(), baseDir);
      expect(readCumulative(baseDir)?.total.sessions).toBe(1);
      expect(warn).toHaveBeenCalledWith('graph-it stats: ignoring invalid cumulative totals file: cumulative.totals');
    });

    it('heals an update another process overwrote, at the next write', () => {
      const lost = makeSnapshot({ source: 'vscode' });
      flushSession(lost, baseDir);
      // Another process read the file before `lost` was added, then wrote it back.
      fs.writeFileSync(cumulativePath(), JSON.stringify({ schemaVersion: 1, since: Date.now(), retired: {}, sessions: {} }));
      flushSession(makeSnapshot(), baseDir);

      const cumulative = readCumulative(baseDir);
      expect(cumulative?.total.sessions).toBe(2);
      expect(cumulative?.since).toBe(new Date(lost.startedAt).toISOString());
    });

    it('writes without warning when a session file is corrupted', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(path.join(baseDir, 'mcp-broken.json'), '{ not json');
      flushSession(makeSnapshot(), baseDir);
      expect(readCumulative(baseDir)?.total.sessions).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is never written with GRAPH_IT_NO_STATS=1', () => {
      process.env.GRAPH_IT_NO_STATS = '1';
      flushSession(makeSnapshot(), baseDir);
      expect(fs.existsSync(cumulativePath())).toBe(false);
    });

    it('is ignored by readAllSessions', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      flushSession(makeSnapshot(), baseDir);
      expect(readAllSessions(baseDir)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('startPeriodicFlush', () => {
    let collector: SessionStatsCollector;
    const sessionFile = () => path.join(baseDir, `vscode-${collector.getSessionId()}.json`);
    const record = () =>
      collector.record({ toolName: 't', jsonTokens: 10, toonTokens: 6, savings: 4, truncated: false, timestamp: 0 });

    beforeEach(() => {
      vi.useFakeTimers();
      collector = new SessionStatsCollector('vscode');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('writes the session once the delay after a record has passed', () => {
      startPeriodicFlush(collector, { baseDir });
      record();
      vi.advanceTimersByTime(PERIODIC_FLUSH_DELAY_MS - 1);
      expect(fs.existsSync(sessionFile())).toBe(false);
      vi.advanceTimersByTime(1);
      expect(fs.existsSync(sessionFile())).toBe(true);
    });

    it('coalesces records into one write within the delay', () => {
      startPeriodicFlush(collector, { baseDir, delayMs: 100 });
      record();
      record();
      collector.recordLlmUsage({ provider: 'anthropic', tokensUsed: 5, timestamp: 0 });
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(100);
      expect(vi.getTimerCount()).toBe(0);
      const written = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as SessionStatsSnapshot;
      expect(written.totals.calls).toBe(2);
      expect(written.llmUsage.calls).toBe(1);
    });

    it('writes nothing while idle', () => {
      const flusher = startPeriodicFlush(collector, { baseDir, delayMs: 100 });
      vi.advanceTimersByTime(10_000);
      flusher.dispose();
      expect(fs.readdirSync(baseDir)).toEqual([]);
    });

    it('rewrites the same file after later activity', () => {
      startPeriodicFlush(collector, { baseDir, delayMs: 100 });
      record();
      vi.advanceTimersByTime(100);
      record();
      vi.advanceTimersByTime(100);
      expect(sessionFiles(baseDir)).toEqual([path.basename(sessionFile())]);
      expect(readAllSessions(baseDir)[0].totals.calls).toBe(2);
    });

    it('dispose (shutdown, deactivate) flushes pending records, clears its timer and stops listening', () => {
      const flusher = startPeriodicFlush(collector, { baseDir });
      record();
      flusher.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(readAllSessions(baseDir)[0].totals.calls).toBe(1);

      record();
      expect(vi.getTimerCount()).toBe(0);
      flusher.dispose();
      expect(readAllSessions(baseDir)[0].totals.calls).toBe(1);
    });

    it('reports a failed write to onError instead of throwing', () => {
      const blocker = path.join(baseDir, 'file');
      fs.writeFileSync(blocker, '');
      const onError = vi.fn();
      const flusher = startPeriodicFlush(collector, { baseDir: path.join(blocker, 'stats'), onError });
      record();
      expect(() => flusher.dispose()).not.toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});
