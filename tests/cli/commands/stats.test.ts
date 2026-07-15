import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSession } from "../../../src/analyzer/stats/statsPersistence";
import { run } from "../../../src/cli/commands/stats";
import type { CliRuntime } from "../../../src/cli/runtime";
import {
  sessionStats,
  type SessionStatsSnapshot,
  type SessionStatsSource,
} from "../../../src/shared/sessionStats";

const fakeRuntime = {} as unknown as CliRuntime;

function makeSnapshot(
  source: SessionStatsSource,
  toolName: string,
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
  };
}

describe("cli stats command", () => {
  let tempDir: string;
  let savedNoStats: string | undefined;

  beforeEach(() => {
    // Shared singleton — isolate every test.
    sessionStats.reset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitl-stats-cli-"));
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

  it("renders a clean empty state when the stats directory does not exist", async () => {
    const missingDir = path.join(tempDir, "nope");

    const output = await run(["--stats-dir", missingDir], fakeRuntime, "text");

    expect(output).toContain("TOON encoding size vs JSON equivalent");
    expect(output).toContain("estimated (chars/4 heuristic)");
    expect(output).toContain("(no persisted sessions found)");
    expect(output).toContain("(no TOON-encoded responses recorded in this session)");
  });

  it("includes the required labels and keeps llmUsage as a separate section", async () => {
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
      tokensUsed: 777,
      timestamp: Date.now(),
    });

    const output = await run(["--stats-dir", tempDir], fakeRuntime, "text");

    expect(output).toContain("TOON encoding size vs JSON equivalent");
    expect(output).toContain("estimated (chars/4 heuristic)");
    expect(output).toContain("llmUsage");
    expect(output).toContain("never summed into the estimated totals");
    expect(output).toContain("tokens used: 777");
    // Estimated totals do not absorb the LLM lane.
    expect(output).toContain("JSON 100 tokens vs TOON 60 tokens");
    expect(output.toLowerCase()).not.toContain("saved by the tool");
  });

  it("aggregates history by source and by tool", async () => {
    flushSession(makeSnapshot("mcp", "graphitlive_generate_codemap"), tempDir);
    flushSession(makeSnapshot("mcp", "graphitlive_query_call_graph"), tempDir);
    flushSession(makeSnapshot("cli", "graphitlive_generate_codemap"), tempDir);

    const output = await run(["--stats-dir", tempDir], fakeRuntime, "text");

    expect(output).toContain("### By source");
    expect(output).toMatch(/\| mcp \| 2 \| 4 \| 200 \| 120 \| 80 \| 2 \| 1000 \|/);
    expect(output).toMatch(/\| cli \| 1 \| 2 \| 100 \| 60 \| 40 \| 1 \| 500 \|/);
    expect(output).toContain("### By tool");
    expect(output).toMatch(/\| graphitlive_generate_codemap \| 4 \| 200 \| 120 \| 80 \|/);
  });

  it("escapes pipes in tool names inside markdown tables (Règle 10)", async () => {
    sessionStats.record({
      toolName: "evil|tool",
      jsonTokens: 10,
      toonTokens: 5,
      savings: 5,
      truncated: false,
      timestamp: Date.now(),
    });

    const output = await run(["--stats-dir", tempDir], fakeRuntime, "text");

    expect(output).toContain("evil\\|tool");
    expect(output).not.toContain("| evil|tool |");
  });

  it("does not print absolute paths", async () => {
    flushSession(makeSnapshot("mcp", "graphitlive_generate_codemap"), tempDir);

    const output = await run(["--stats-dir", tempDir], fakeRuntime, "text");

    expect(output).not.toContain(tempDir);
    expect(output).not.toContain(os.homedir());
  });

  it("skips corrupted stats files without crashing", async () => {
    flushSession(makeSnapshot("mcp", "graphitlive_generate_codemap"), tempDir);
    fs.writeFileSync(path.join(tempDir, "mcp-corrupted.json"), "{ not json", "utf8");

    const output = await run(["--stats-dir", tempDir], fakeRuntime, "text");

    expect(output).toMatch(/\| mcp \| 1 \|/);
  });

  it("returns structured JSON with required labels for --format json", async () => {
    flushSession(makeSnapshot("cli", "graphitlive_generate_codemap"), tempDir);

    const output = await run(["--stats-dir", tempDir], fakeRuntime, "json");
    const parsed = JSON.parse(output);

    expect(parsed.description).toBe("TOON encoding size vs JSON equivalent");
    expect(parsed.estimationNote).toBe("estimated (chars/4 heuristic)");
    expect(parsed.history.persistedSessions).toBe(1);
    expect(parsed.history.bySource.cli.llmTokensUsed).toBe(500);
    expect(parsed.currentSession.estimationMethod).toBe("chars/4 heuristic");
  });
});
