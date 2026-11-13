/**
 * MCP Session Stats Tool — get_session_stats
 *
 * Reports session statistics: TOON encoding size vs JSON equivalent
 * (estimated, cl100k_base tokenizer) plus real LLM token usage (exact,
 * provider-reported) as a SEPARATE section — never summed into the
 * estimated encoding totals, mixing them would produce a dishonest metric.
 *
 * Runs IN the MCP server process (not the worker): the sessionStats
 * singleton is populated by responseFormatter in this process.
 *
 * NO vscode imports — this module is VS Code agnostic.
 */

import { z } from "zod/v4";
import {
  readAllSessions,
  readCumulative,
  summarizeSessions,
  type CumulativeSummary,
  type HistorySummary,
} from "../../analyzer/stats/statsPersistence";
import { ESTIMATION_NOTE, sessionStats, type SessionStatsSnapshot } from "../../shared/sessionStats";

// ---------------------------------------------------------------------------
// Zod schema (exported for mcpServer registration)
// ---------------------------------------------------------------------------

/** No parameters — the tool always reports the current session. */
export const GetSessionStatsSchema = z.object({});

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface GetSessionStatsResult {
  /** What the numbers measure. */
  description: "TOON encoding size vs JSON equivalent";
  /** How the numbers are computed. */
  estimationNote: typeof ESTIMATION_NOTE;
  /** Why llmUsage is reported separately, and why it stays 0 on the MCP side. */
  llmUsageNote: string;
  /** Current in-memory session (llmUsage is a separate section inside the snapshot). */
  currentSession: SessionStatsSnapshot;
  /** Persisted session window (last 50 per source) by source and in total. Empty when no history exists. */
  history: HistorySummary;
  /** Totals since the first counted session, rotation included. Absent before the first write. */
  cumulative?: CumulativeSummary;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Build the session stats report: current in-memory session + persisted history.
 *
 * @param statsDir optional stats directory override (tests); defaults to ~/.graph-it/stats
 */
export function executeGetSessionStats(statsDir?: string): GetSessionStatsResult {
  const currentSession = sessionStats.snapshot();

  let history = summarizeSessions([]);
  let cumulative: CumulativeSummary | undefined;
  try {
    history = summarizeSessions(readAllSessions(statsDir));
    cumulative = readCumulative(statsDir);
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
    estimationNote: ESTIMATION_NOTE,
    llmUsageNote,
    currentSession,
    history,
    ...(cumulative && { cumulative }),
  };
}
