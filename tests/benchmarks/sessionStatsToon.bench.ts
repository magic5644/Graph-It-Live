import { bench, describe } from "vitest";
import { estimateTokenSavings, jsonToToon } from "../../src/shared/toon";

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

function buildCurrentSessionRows(toolCount: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < toolCount; i++) {
    rows.push({
      scope: "current_session",
      toolName: `graphitlive_tool_${String(i).padStart(2, "0")}`,
      calls: 10 + i,
      jsonTokens: 300 + i * 20,
      toonTokens: 180 + i * 12,
      savings: 120 + i * 8,
      truncations: i % 3,
      llmCalls: 0,
      llmTokensUsed: 0,
    });
  }
  return rows;
}

function buildHistoryRows(sourceCount: number, toolsPerSource: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let s = 0; s < sourceCount; s++) {
    rows.push({
      scope: "history_by_source",
      source: `source_${s}`,
      sessions: 20 + s,
      calls: 200 + s * 10,
      jsonTokens: 25000 + s * 1000,
      toonTokens: 15000 + s * 600,
      savings: 10000 + s * 400,
      truncations: s,
      llmCalls: s % 2,
      llmTokensUsed: s * 100,
    });
  }

  for (let i = 0; i < toolsPerSource; i++) {
    rows.push({
      scope: "history_by_tool",
      toolName: `graphitlive_tool_${String(i).padStart(3, "0")}`,
      calls: 5 + i,
      jsonTokens: 400 + i * 15,
      toonTokens: 240 + i * 9,
      savings: 160 + i * 6,
      truncations: i % 4,
    });
  }

  return rows;
}

describe("TOON session-stats benchmarks", () => {
  bench("primary benchmark - current session payload", () => {
    const rows = buildCurrentSessionRows(30);
    const json = JSON.stringify(rows, null, 2);
    const toon = jsonToToon(rows, { objectName: "session_stats_primary" });
    estimateTokenSavings(json, toon);
  }, BENCH_OPTIONS);

  bench("secondary benchmark - persisted history payload", () => {
    const rows = buildHistoryRows(3, 120);
    const json = JSON.stringify(rows, null, 2);
    const toon = jsonToToon(rows, { objectName: "session_stats_secondary" });
    estimateTokenSavings(json, toon);
  }, BENCH_OPTIONS);
});
