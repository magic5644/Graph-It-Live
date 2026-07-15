import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSession } from "../../../src/analyzer/stats/statsPersistence";
import {
  executeGetSessionStats,
  GetSessionStatsSchema,
} from "../../../src/mcp/tools/stats";
import {
  sessionStats,
  type SessionStatsSnapshot,
  type SessionStatsSource,
} from "../../../src/shared/sessionStats";

function makeSnapshot(
  source: SessionStatsSource,
  toolName: string,
  overrides: Partial<SessionStatsSnapshot> = {},
): SessionStatsSnapshot {
  return {
    schemaVersion: 1,
    sessionId: globalThis.crypto.randomUUID(),
    source,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    byTool: {
      [toolName]: { calls: 2, jsonTokens: 100, toonTokens: 60, savings: 40, truncations: 0 },
    },
    totals: { calls: 2, jsonTokens: 100, toonTokens: 60, savings: 40, truncations: 0 },
    llmUsage: { calls: 1, tokensUsed: 500 },
    estimationMethod: "chars/4 heuristic",
    ...overrides,
  };
}

describe("get_session_stats tool", () => {
  let tempDir: string;
  let savedNoStats: string | undefined;

  beforeEach(() => {
    // Shared singleton — isolate every test.
    sessionStats.reset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitl-stats-tool-"));
    savedNoStats = process.env.GRAPH_IT_NO_STATS;
    delete process.env.GRAPH_IT_NO_STATS;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (savedNoStats === undefined) {
      delete process.env.GRAPH_IT_NO_STATS;
    } else {
      process.env.GRAPH_IT_NO_STATS = savedNoStats;
    }
  });

  it("accepts an empty params object (Zod {})", () => {
    expect(GetSessionStatsSchema.safeParse({}).success).toBe(true);
  });

  it("includes the required labels (positive assertions)", () => {
    const result = executeGetSessionStats(tempDir);

    expect(result.description).toBe("TOON encoding size vs JSON equivalent");
    expect(result.estimationNote).toBe("estimated (chars/4 heuristic)");
    expect(result.llmUsageNote).toContain("never summed into the estimated encoding totals");
    expect(result.currentSession.estimationMethod).toBe("chars/4 heuristic");
  });

  it('never claims tokens were "saved by the tool"', () => {
    const serialized = JSON.stringify(executeGetSessionStats(tempDir)).toLowerCase();

    expect(serialized).not.toContain("saved by the tool");
    expect(serialized).not.toContain("saved by using");
    expect(serialized).not.toContain("économisés grâce");
  });

  it("reports current session totals as the sum of recorded entries", () => {
    sessionStats.record({
      toolName: "graphitlive_generate_codemap",
      jsonTokens: 100,
      toonTokens: 60,
      savings: 40,
      truncated: false,
      timestamp: Date.now(),
    });
    sessionStats.record({
      toolName: "graphitlive_query_call_graph",
      jsonTokens: 200,
      toonTokens: 120,
      savings: 80,
      truncated: false,
      timestamp: Date.now(),
    });

    const result = executeGetSessionStats(tempDir);

    expect(result.currentSession.totals.calls).toBe(2);
    expect(result.currentSession.totals.jsonTokens).toBe(300);
    expect(result.currentSession.totals.toonTokens).toBe(180);
    expect(result.currentSession.totals.savings).toBe(120);
    expect(result.currentSession.byTool["graphitlive_generate_codemap"].savings).toBe(40);
    expect(result.currentSession.byTool["graphitlive_query_call_graph"].savings).toBe(80);
  });

  it("keeps llmUsage separate — never summed into totals", () => {
    sessionStats.record({
      toolName: "graphitlive_generate_codemap",
      jsonTokens: 100,
      toonTokens: 60,
      savings: 40,
      truncated: false,
      timestamp: Date.now(),
    });
    sessionStats.recordLlmUsage({
      provider: "anthropic",
      tokensUsed: 9999,
      timestamp: Date.now(),
    });

    const result = executeGetSessionStats(tempDir);

    // llmUsage is its own section...
    expect(result.currentSession.llmUsage.calls).toBe(1);
    expect(result.currentSession.llmUsage.tokensUsed).toBe(9999);
    // ...and none of the estimated totals absorb it.
    expect(result.currentSession.totals.jsonTokens).toBe(100);
    expect(result.currentSession.totals.toonTokens).toBe(60);
    expect(result.currentSession.totals.savings).toBe(40);
    expect(result.currentSession.totals.calls).toBe(1);
  });

  it("returns empty history when the stats directory does not exist", () => {
    const missingDir = path.join(tempDir, "does", "not", "exist");

    const result = executeGetSessionStats(missingDir);

    expect(result.history.persistedSessions).toBe(0);
    expect(result.history.bySource).toEqual({});
  });

  it("aggregates persisted history by source, llm lane separate", () => {
    flushSession(makeSnapshot("mcp", "graphitlive_generate_codemap"), tempDir);
    flushSession(makeSnapshot("mcp", "graphitlive_query_call_graph"), tempDir);
    flushSession(makeSnapshot("cli", "graphitlive_generate_codemap"), tempDir);

    const result = executeGetSessionStats(tempDir);

    expect(result.history.persistedSessions).toBe(3);
    expect(result.history.bySource.mcp).toMatchObject({
      sessions: 2,
      calls: 4,
      jsonTokens: 200,
      toonTokens: 120,
      savings: 80,
      llmCalls: 2,
      llmTokensUsed: 1000,
    });
    expect(result.history.bySource.cli).toMatchObject({
      sessions: 1,
      calls: 2,
      llmTokensUsed: 500,
    });
    // Estimated totals never absorb the LLM lane.
    expect(result.history.bySource.mcp!.jsonTokens).toBe(200);
  });

  it("contains no absolute paths in the serialized result", () => {
    flushSession(makeSnapshot("mcp", "graphitlive_generate_codemap"), tempDir);

    const serialized = JSON.stringify(executeGetSessionStats(tempDir));

    expect(serialized).not.toContain(tempDir);
    expect(serialized).not.toContain(os.homedir());
  });
});
