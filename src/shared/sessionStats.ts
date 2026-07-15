/**
 * sessionStats — in-memory session statistics collector.
 *
 * Tracks TOON-vs-JSON encoding size comparisons (estimated, chars/4 heuristic)
 * and real LLM token usage (exact, reported by providers).
 *
 * IMPORTANT — pure TypeScript module:
 * - NO fs / os / path / vscode imports — this module is bundled into the webview.
 * - Uses globalThis.crypto.randomUUID() (available in Node >= 22 and browsers).
 *
 * llmUsage is NEVER summed into totals: totals are estimated encoding sizes,
 * llmUsage is real provider-reported token consumption. Mixing them would
 * produce a dishonest metric.
 */

/** Source of the stats collection — encoded into persisted file names. */
export type SessionStatsSource = 'mcp' | 'cli' | 'extension';

/** One TOON-vs-JSON encoding comparison for a tool response. */
export interface StatsEntry {
  toolName: string;
  jsonTokens: number;
  toonTokens: number;
  savings: number;
  truncated: boolean;
  timestamp: number;
}

/** One real LLM usage record (provider-reported tokens). */
export interface LlmUsageEntry {
  provider: 'anthropic' | 'openai-compatible';
  tokensUsed: number;
  timestamp: number;
}

/** Aggregated counters for one tool (or for the session totals). */
export interface StatsAggregate {
  calls: number;
  jsonTokens: number;
  toonTokens: number;
  savings: number;
  truncations: number;
}

/** Serializable snapshot of a session. Contains no absolute paths, no code. */
export interface SessionStatsSnapshot {
  schemaVersion: 1;
  sessionId: string;
  source: SessionStatsSource;
  startedAt: number;
  endedAt?: number;
  byTool: Record<string, StatsAggregate>;
  totals: StatsAggregate;
  llmUsage: {
    calls: number;
    tokensUsed: number;
  };
  estimationMethod: 'chars/4 heuristic';
}

function emptyAggregate(): StatsAggregate {
  return { calls: 0, jsonTokens: 0, toonTokens: 0, savings: 0, truncations: 0 };
}

function accumulate(agg: StatsAggregate, entry: StatsEntry): void {
  agg.calls += 1;
  agg.jsonTokens += entry.jsonTokens;
  agg.toonTokens += entry.toonTokens;
  agg.savings += entry.savings;
  if (entry.truncated) {
    agg.truncations += 1;
  }
}

/**
 * Collects session stats in memory. Persistence lives elsewhere
 * (src/analyzer/stats/statsPersistence.ts) to keep this module fs-free.
 */
export class SessionStatsCollector {
  private sessionId: string;
  private source: SessionStatsSource;
  private startedAt: number;
  // Aggregated at record time — no per-entry storage, so memory stays bounded
  // (one aggregate per tool name) on long-running MCP servers.
  private byTool: Record<string, StatsAggregate> = {};
  private totals: StatsAggregate = emptyAggregate();
  private llmCalls = 0;
  private llmTokensUsed = 0;

  constructor(source: SessionStatsSource = 'extension') {
    this.source = source;
    this.sessionId = globalThis.crypto.randomUUID();
    this.startedAt = Date.now();
  }

  /** Set by entry points (mcp/cli) before any recording happens. */
  setSource(source: SessionStatsSource): void {
    this.source = source;
  }

  getSource(): SessionStatsSource {
    return this.source;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Record one TOON-vs-JSON encoding comparison. */
  record(entry: StatsEntry): void {
    this.byTool[entry.toolName] ??= emptyAggregate();
    accumulate(this.byTool[entry.toolName], entry);
    accumulate(this.totals, entry);
  }

  /** Record one real LLM usage event. Kept separate from encoding totals. */
  recordLlmUsage(entry: LlmUsageEntry): void {
    this.llmCalls += 1;
    this.llmTokensUsed += entry.tokensUsed;
  }

  /** True when at least one entry (encoding or LLM) has been recorded. */
  hasEntries(): boolean {
    return this.totals.calls > 0 || this.llmCalls > 0;
  }

  /** Build a serializable snapshot. llmUsage is never summed into totals. */
  snapshot(): SessionStatsSnapshot {
    const byTool: Record<string, StatsAggregate> = {};
    for (const [toolName, agg] of Object.entries(this.byTool)) {
      byTool[toolName] = { ...agg };
    }

    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      source: this.source,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      byTool,
      totals: { ...this.totals },
      llmUsage: {
        calls: this.llmCalls,
        tokensUsed: this.llmTokensUsed,
      },
      estimationMethod: 'chars/4 heuristic',
    };
  }

  /** Clear all counters and start a fresh session (new id, new startedAt). */
  reset(): void {
    this.byTool = {};
    this.totals = emptyAggregate();
    this.llmCalls = 0;
    this.llmTokensUsed = 0;
    this.sessionId = globalThis.crypto.randomUUID();
    this.startedAt = Date.now();
  }
}

/** Process-wide singleton. Entry points call setSource('mcp' | 'cli'). */
export const sessionStats = new SessionStatsCollector();
