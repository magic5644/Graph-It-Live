/**
 * MCP Session Stats Tool — get_session_stats
 *
 * Reports session statistics: TOON encoding size vs JSON equivalent
 * (estimated, chars/4 heuristic) plus real LLM token usage (exact,
 * provider-reported) as a SEPARATE section — never summed into the
 * estimated encoding totals, mixing them would produce a dishonest metric.
 *
 * Runs IN the MCP server process (not the worker): the sessionStats
 * singleton is populated by responseFormatter in this process.
 *
 * NO vscode imports — this module is VS Code agnostic.
 */

import { z } from "zod/v4";
import { readAllSessions } from "../../analyzer/stats/statsPersistence";
import {
  sessionStats,
  type SessionStatsSnapshot,
  type SessionStatsSource,
} from "../../shared/sessionStats";

// ---------------------------------------------------------------------------
// Zod schema (exported for mcpServer registration)
// ---------------------------------------------------------------------------

/** No parameters — the tool always reports the current session. */
export const GetSessionStatsSchema = z.object({});

export type GetSessionStatsParams = z.infer<typeof GetSessionStatsSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Aggregated persisted history for one source (mcp/cli/extension). */
export interface HistorySourceAggregate {
  sessions: number;
  calls: number;
  jsonTokens: number;
  toonTokens: number;
  savings: number;
  truncations: number;
  /** Real provider-reported LLM tokens — kept separate, never summed into estimated totals. */
  llmTokensUsed: number;
  llmCalls: number;
}

export interface GetSessionStatsResult {
  /** What the numbers measure. */
  description: "TOON encoding size vs JSON equivalent";
  /** How the numbers are computed. */
  estimationNote: "estimated (chars/4 heuristic)";
  /** Why llmUsage is reported separately, and why it stays 0 on the MCP side. */
  llmUsageNote: string;
  /** Current in-memory session (llmUsage is a separate section inside the snapshot). */
  currentSession: SessionStatsSnapshot;
  /** Persisted session history aggregated by source. Empty when no history exists. */
  history: {
    persistedSessions: number;
    bySource: Partial<Record<SessionStatsSource, HistorySourceAggregate>>;
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function emptyHistoryAggregate(): HistorySourceAggregate {
  return {
    sessions: 0,
    calls: 0,
    jsonTokens: 0,
    toonTokens: 0,
    savings: 0,
    truncations: 0,
    llmTokensUsed: 0,
    llmCalls: 0,
  };
}

function aggregateHistory(
  snapshots: SessionStatsSnapshot[],
): GetSessionStatsResult["history"] {
  const bySource: Partial<Record<SessionStatsSource, HistorySourceAggregate>> = {};

  for (const snap of snapshots) {
    const agg = (bySource[snap.source] ??= emptyHistoryAggregate());
    agg.sessions += 1;
    agg.calls += snap.totals.calls;
    agg.jsonTokens += snap.totals.jsonTokens;
    agg.toonTokens += snap.totals.toonTokens;
    agg.savings += snap.totals.savings;
    agg.truncations += snap.totals.truncations;
    // Separate lane: real LLM usage is never merged into the estimated fields above.
    agg.llmTokensUsed += snap.llmUsage.tokensUsed;
    agg.llmCalls += snap.llmUsage.calls;
  }

  return { persistedSessions: snapshots.length, bySource };
}

/**
 * Build the session stats report: current in-memory session + persisted history.
 *
 * @param statsDir optional stats directory override (tests); defaults to ~/.graph-it/stats
 */
export function executeGetSessionStats(statsDir?: string): GetSessionStatsResult {
  const currentSession = sessionStats.snapshot();

  let history: GetSessionStatsResult["history"] = {
    persistedSessions: 0,
    bySource: {},
  };
  try {
    history = aggregateHistory(readAllSessions(statsDir));
  } catch {
    // History is best-effort — the current session must always be reported.
  }

  // The MCP server never instantiates an LLM client (query_natural_language
  // delegates synthesis to the calling LLM), so llmUsage can only be non-zero
  // for CLI sessions (`graph-it query`). Say so instead of showing a section
  // that looks broken.
  const llmUsageNote =
    currentSession.source === "mcp" && currentSession.llmUsage.calls === 0
      ? "llmUsage is tracked for CLI `graph-it query` only — the MCP server delegates LLM synthesis to the calling client and makes no LLM API calls itself"
      : "llmUsage is real provider-reported token consumption; it is never summed into the estimated encoding totals";

  return {
    description: "TOON encoding size vs JSON equivalent",
    estimationNote: "estimated (chars/4 heuristic)",
    llmUsageNote,
    currentSession,
    history,
  };
}
