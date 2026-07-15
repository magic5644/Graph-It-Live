/**
 * Unit tests for SessionStatsCollector (src/shared/sessionStats.ts).
 *
 * Pure in-memory module — no fs/os/path/vscode, no mocks needed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  SessionStatsCollector,
  sessionStats,
  type StatsEntry,
} from '../../src/shared/sessionStats';

function makeEntry(overrides: Partial<StatsEntry> = {}): StatsEntry {
  return {
    toolName: 'generate_codemap',
    jsonTokens: 100,
    toonTokens: 60,
    savings: 40,
    truncated: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('SessionStatsCollector', () => {
  let collector: SessionStatsCollector;

  beforeEach(() => {
    collector = new SessionStatsCollector();
  });

  it('defaults source to "extension"', () => {
    expect(collector.getSource()).toBe('extension');
    expect(collector.snapshot().source).toBe('extension');
  });

  it('accepts source in constructor', () => {
    const mcp = new SessionStatsCollector('mcp');
    expect(mcp.snapshot().source).toBe('mcp');
  });

  it('setSource() overrides source', () => {
    collector.setSource('cli');
    expect(collector.snapshot().source).toBe('cli');
  });

  it('generates a UUID sessionId', () => {
    expect(collector.getSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('hasEntries() is false initially', () => {
    expect(collector.hasEntries()).toBe(false);
  });

  it('hasEntries() is true after record()', () => {
    collector.record(makeEntry());
    expect(collector.hasEntries()).toBe(true);
  });

  it('hasEntries() is true after recordLlmUsage() only', () => {
    collector.recordLlmUsage({ provider: 'anthropic', tokensUsed: 42, timestamp: Date.now() });
    expect(collector.hasEntries()).toBe(true);
  });

  it('snapshot() aggregates totals across entries', () => {
    collector.record(makeEntry({ jsonTokens: 100, toonTokens: 60, savings: 40 }));
    collector.record(makeEntry({ jsonTokens: 200, toonTokens: 120, savings: 80, truncated: true }));

    const snap = collector.snapshot();
    expect(snap.totals).toEqual({
      calls: 2,
      jsonTokens: 300,
      toonTokens: 180,
      savings: 120,
      truncations: 1,
    });
  });

  it('snapshot() groups byTool with per-tool aggregates', () => {
    collector.record(makeEntry({ toolName: 'a', savings: 10 }));
    collector.record(makeEntry({ toolName: 'a', savings: 5, truncated: true }));
    collector.record(makeEntry({ toolName: 'b', savings: 7 }));

    const snap = collector.snapshot();
    expect(Object.keys(snap.byTool).sort()).toEqual(['a', 'b']);
    expect(snap.byTool.a.calls).toBe(2);
    expect(snap.byTool.a.savings).toBe(15);
    expect(snap.byTool.a.truncations).toBe(1);
    expect(snap.byTool.b.calls).toBe(1);
    expect(snap.byTool.b.savings).toBe(7);
  });

  it('snapshot() keeps llmUsage separate — never summed into totals', () => {
    collector.record(makeEntry({ jsonTokens: 100, toonTokens: 60, savings: 40 }));
    collector.recordLlmUsage({ provider: 'anthropic', tokensUsed: 500, timestamp: Date.now() });
    collector.recordLlmUsage({
      provider: 'openai-compatible',
      tokensUsed: 300,
      timestamp: Date.now(),
    });

    const snap = collector.snapshot();
    expect(snap.llmUsage).toEqual({ calls: 2, tokensUsed: 800 });
    // totals must reflect ONLY encoding entries.
    expect(snap.totals.calls).toBe(1);
    expect(snap.totals.jsonTokens).toBe(100);
    expect(snap.totals.toonTokens).toBe(60);
    expect(snap.totals.savings).toBe(40);
  });

  it('snapshot() carries schemaVersion, estimationMethod and timestamps', () => {
    const snap = collector.snapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.estimationMethod).toBe('chars/4 heuristic');
    expect(snap.startedAt).toBeTypeOf('number');
    expect(snap.endedAt).toBeTypeOf('number');
    expect(snap.endedAt!).toBeGreaterThanOrEqual(snap.startedAt);
    expect(snap.sessionId).toBe(collector.getSessionId());
  });

  it('snapshot() of empty collector has zeroed aggregates', () => {
    const snap = collector.snapshot();
    expect(snap.totals).toEqual({
      calls: 0,
      jsonTokens: 0,
      toonTokens: 0,
      savings: 0,
      truncations: 0,
    });
    expect(snap.byTool).toEqual({});
    expect(snap.llmUsage).toEqual({ calls: 0, tokensUsed: 0 });
  });

  it('reset() clears entries and issues a new sessionId', () => {
    const oldId = collector.getSessionId();
    collector.record(makeEntry());
    collector.recordLlmUsage({ provider: 'anthropic', tokensUsed: 10, timestamp: Date.now() });

    collector.reset();

    expect(collector.hasEntries()).toBe(false);
    expect(collector.getSessionId()).not.toBe(oldId);
    const snap = collector.snapshot();
    expect(snap.totals.calls).toBe(0);
    expect(snap.llmUsage.calls).toBe(0);
  });

  it('serialized snapshot contains no absolute paths', () => {
    collector.record(makeEntry({ toolName: 'query_call_graph' }));
    collector.recordLlmUsage({ provider: 'anthropic', tokensUsed: 12, timestamp: Date.now() });
    const json = JSON.stringify(collector.snapshot());
    expect(json).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });
});

describe('sessionStats singleton', () => {
  it('is a SessionStatsCollector instance with default source extension', () => {
    expect(sessionStats).toBeInstanceOf(SessionStatsCollector);
  });
});
