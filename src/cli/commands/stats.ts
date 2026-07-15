/**
 * CLI Command: stats
 *
 * Session token stats: TOON encoding size vs JSON equivalent (estimated,
 * chars/4 heuristic) for the current session plus persisted history,
 * aggregated by source and by tool. Real LLM token usage is reported as a
 * SEPARATE section — never summed into the estimated encoding totals.
 *
 * Usage: graph-it stats [--stats-dir <dir>] [--format text|json|markdown]
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { readAllSessions } from "../../analyzer/stats/statsPersistence.js";
import {
  sessionStats,
  type SessionStatsSnapshot,
  type SessionStatsSource,
  type StatsAggregate,
} from "../../shared/sessionStats.js";
import type { CliOutputFormat } from "../formatter.js";
import type { CliRuntime } from "../runtime.js";

// ---------------------------------------------------------------------------
// Labels (spec v2 — required wording)
// ---------------------------------------------------------------------------

const HEADER = "TOON encoding size vs JSON equivalent";
const ESTIMATION_NOTE = "estimated (chars/4 heuristic)";
const LLM_NOTE =
  "llmUsage: real provider-reported tokens — reported separately, never summed into the estimated totals above.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Règle 10 — escape pipes in any name rendered inside a markdown table cell. */
function escapeCell(s: string): string {
  return s.replaceAll("|", "\\|");
}

function parseStatsDir(args: string[]): string | undefined {
  const idx = args.indexOf("--stats-dir");
  if (idx >= 0 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

interface SourceAggregate extends StatsAggregate {
  sessions: number;
  llmCalls: number;
  llmTokensUsed: number;
}

function emptySourceAggregate(): SourceAggregate {
  return {
    sessions: 0,
    calls: 0,
    jsonTokens: 0,
    toonTokens: 0,
    savings: 0,
    truncations: 0,
    llmCalls: 0,
    llmTokensUsed: 0,
  };
}

function aggregateBySource(
  snapshots: SessionStatsSnapshot[],
): Partial<Record<SessionStatsSource, SourceAggregate>> {
  const bySource: Partial<Record<SessionStatsSource, SourceAggregate>> = {};
  for (const snap of snapshots) {
    const agg = (bySource[snap.source] ??= emptySourceAggregate());
    agg.sessions += 1;
    agg.calls += snap.totals.calls;
    agg.jsonTokens += snap.totals.jsonTokens;
    agg.toonTokens += snap.totals.toonTokens;
    agg.savings += snap.totals.savings;
    agg.truncations += snap.totals.truncations;
    // Separate lane — real LLM tokens are never merged into the estimated fields.
    agg.llmCalls += snap.llmUsage.calls;
    agg.llmTokensUsed += snap.llmUsage.tokensUsed;
  }
  return bySource;
}

function aggregateByTool(
  snapshots: SessionStatsSnapshot[],
): Record<string, StatsAggregate> {
  const byTool: Record<string, StatsAggregate> = {};
  for (const snap of snapshots) {
    for (const [toolName, agg] of Object.entries(snap.byTool)) {
      byTool[toolName] ??= {
        calls: 0,
        jsonTokens: 0,
        toonTokens: 0,
        savings: 0,
        truncations: 0,
      };
      const target = byTool[toolName];
      target.calls += agg.calls;
      target.jsonTokens += agg.jsonTokens;
      target.toonTokens += agg.toonTokens;
      target.savings += agg.savings;
      target.truncations += agg.truncations;
    }
  }
  return byTool;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderToolTable(byTool: Record<string, StatsAggregate>): string[] {
  const lines: string[] = [
    "| Tool | Calls | JSON tokens | TOON tokens | Delta |",
    "|------|-------|-------------|-------------|-------|",
  ];
  const names = Object.keys(byTool).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const t = byTool[name];
    lines.push(
      `| ${escapeCell(name)} | ${t.calls} | ${t.jsonTokens} | ${t.toonTokens} | ${t.savings} |`,
    );
  }
  return lines;
}

function renderSourceTable(
  bySource: Partial<Record<SessionStatsSource, SourceAggregate>>,
): string[] {
  const lines: string[] = [
    "| Source | Sessions | Calls | JSON tokens | TOON tokens | Delta | LLM calls | LLM tokens (real) |",
    "|--------|----------|-------|-------------|-------------|-------|-----------|-------------------|",
  ];
  const sources = Object.keys(bySource).sort((a, b) => a.localeCompare(b));
  for (const source of sources) {
    const s = bySource[source as SessionStatsSource];
    if (!s) {
      continue;
    }
    lines.push(
      `| ${escapeCell(source)} | ${s.sessions} | ${s.calls} | ${s.jsonTokens} | ${s.toonTokens} | ${s.savings} | ${s.llmCalls} | ${s.llmTokensUsed} |`,
    );
  }
  return lines;
}

function renderText(
  current: SessionStatsSnapshot,
  history: SessionStatsSnapshot[],
): string {
  const lines: string[] = [
    `# ${HEADER}`,
    "",
    `All JSON/TOON token counts are ${ESTIMATION_NOTE}.`,
    "",
    "## Current session",
    "",
  ];

  if (current.totals.calls === 0) {
    lines.push("(no TOON-encoded responses recorded in this session)");
  } else {
    lines.push(...renderToolTable(current.byTool));
    lines.push(
      "",
      `Totals: ${current.totals.calls} calls, JSON ${current.totals.jsonTokens} tokens vs TOON ${current.totals.toonTokens} tokens (delta ${current.totals.savings}, ${ESTIMATION_NOTE}).`,
    );
  }

  lines.push("", "## llmUsage (current session)", "");
  if (current.llmUsage.calls === 0) {
    lines.push("(no LLM calls recorded in this session)");
  } else {
    lines.push(
      `LLM calls: ${current.llmUsage.calls}, tokens used: ${current.llmUsage.tokensUsed} (real, provider-reported).`,
    );
  }
  lines.push("", LLM_NOTE);

  lines.push("", "## History (persisted sessions)", "");
  if (history.length === 0) {
    lines.push("(no persisted sessions found)");
  } else {
    lines.push("### By source", "", ...renderSourceTable(aggregateBySource(history)));
    lines.push("", "### By tool", "", ...renderToolTable(aggregateByTool(history)));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(
  args: string[],
  _runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const statsDir = parseStatsDir(args);

  const current = sessionStats.snapshot();
  // readAllSessions handles a missing directory (returns []) and skips
  // corrupted files with a stderr warning — clean empty state guaranteed.
  const history = readAllSessions(statsDir);

  if (format === "json") {
    return JSON.stringify(
      {
        description: HEADER,
        estimationNote: ESTIMATION_NOTE,
        llmUsageNote: LLM_NOTE,
        currentSession: current,
        history: {
          persistedSessions: history.length,
          bySource: aggregateBySource(history),
          byTool: aggregateByTool(history),
        },
      },
      null,
      2,
    );
  }

  // text / markdown / toon fall back to the markdown-style report
  return renderText(current, history);
}
