/**
 * Unit tests for the `graph-it wiki` CLI command.
 * executeGenerateWiki is mocked — no DB or WikiGenerator runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  executeGenerateWiki: vi.fn(),
}));

vi.mock("../../../src/mcp/tools/wiki.js", () => ({
  executeGenerateWiki: mocks.executeGenerateWiki,
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { run } from "../../../src/cli/commands/wiki.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = "/workspace";

function makeRuntime(root = WORKSPACE_ROOT) {
  return {
    workspaceRoot: root,
    ensureIndexed: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function makeWikiResult(overrides = {}) {
  return {
    articlesCount: 5,
    indexPath: "wiki/index.md",
    articlesDir: "wiki/articles",
    topHubs: [
      { name: "CallGraphIndexer.ts", score: 42 },
      { name: "Spider.ts", score: 30 },
    ],
    scopeNote: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki command", () => {
  beforeEach(() => {
    mocks.executeGenerateWiki.mockReset();
    mocks.executeGenerateWiki.mockResolvedValue(makeWikiResult());
  });

  // -------------------------------------------------------------------------
  // 1. ensureIndexed is called
  // -------------------------------------------------------------------------

  it("calls runtime.ensureIndexed before generating wiki", async () => {
    const runtime = makeRuntime();
    await run([], runtime, "text");
    expect(runtime.ensureIndexed).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 2. Default flag values
  // -------------------------------------------------------------------------

  it("uses default outputDir 'wiki' when --output is not provided", async () => {
    await run([], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: expect.stringContaining("wiki"),
      }),
    );
  });

  it("uses default topHubsLimit 10 when --top is not provided", async () => {
    await run([], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ topHubsLimit: 10 }),
    );
  });

  it("does not pass scope when --scope is not provided", async () => {
    await run([], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ scope: undefined }),
    );
  });

  it("does not pass exclude when --exclude is not provided", async () => {
    await run([], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: undefined }),
    );
  });

  // -------------------------------------------------------------------------
  // 3. Flag parsing
  // -------------------------------------------------------------------------

  it("parses --output flag", async () => {
    await run(["--output", "out/wiki"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: expect.stringContaining("out/wiki"),
      }),
    );
  });

  it("parses --scope flag", async () => {
    await run(["--scope", "src/analyzer"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "src/analyzer" }),
    );
  });

  it("parses --exclude flag (single)", async () => {
    await run(["--exclude", "tests/"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: ["tests/"] }),
    );
  });

  it("parses multiple --exclude flags", async () => {
    await run(["--exclude", "tests/", "--exclude", "dist/"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: ["tests/", "dist/"] }),
    );
  });

  it("parses --top flag as integer", async () => {
    await run(["--top", "5"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ topHubsLimit: 5 }),
    );
  });

  it("clamps --top to default 10 when value is invalid", async () => {
    await run(["--top", "abc"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ topHubsLimit: 10 }),
    );
  });

  it("clamps --top to default 10 when value is 0", async () => {
    await run(["--top", "0"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ topHubsLimit: 10 }),
    );
  });

  it("clamps --top to default 10 when value exceeds 50", async () => {
    await run(["--top", "99"], makeRuntime(), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({ topHubsLimit: 10 }),
    );
  });

  // -------------------------------------------------------------------------
  // 4. Output formats
  // -------------------------------------------------------------------------

  it("returns markdown output by default (text format)", async () => {
    const output = await run([], makeRuntime(), "text");

    expect(output).toContain("# Wiki generated");
    expect(output).toContain("Articles");
    expect(output).toContain("wiki/index.md");
    expect(output).toContain("CallGraphIndexer.ts");
  });

  it("returns JSON output when --format json", async () => {
    const output = await run(["--format", "json"], makeRuntime(), "text");

    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.articlesCount).toBe(5);
    expect(parsed.indexPath).toBe("wiki/index.md");
    expect(parsed.topHubs).toHaveLength(2);
  });

  it("returns JSON when top-level format is json (no --format flag)", async () => {
    const output = await run([], makeRuntime(), "json");

    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output).articlesCount).toBe(5);
  });

  it("returns toon output when --format toon", async () => {
    const output = await run(["--format", "toon"], makeRuntime(), "text");

    expect(output).toContain("wiki articles=5");
    expect(output).toContain("index=wiki/index.md");
    expect(output).toContain("dir=wiki/articles");
    expect(output).toContain("CallGraphIndexer.ts(42)");
  });

  it("returns toon when top-level format is toon (no --format flag)", async () => {
    const output = await run([], makeRuntime(), "toon");

    expect(output).toContain("wiki articles=5");
  });

  it("--format flag overrides top-level format", async () => {
    const output = await run(["--format", "markdown"], makeRuntime(), "json");

    expect(output).toContain("# Wiki generated");
    expect(() => JSON.parse(output)).toThrow();
  });

  // -------------------------------------------------------------------------
  // 5. scopeNote in output
  // -------------------------------------------------------------------------

  it("includes scopeNote in markdown output when present", async () => {
    mocks.executeGenerateWiki.mockResolvedValue(makeWikiResult({ scopeNote: "Scoped to src/" }));

    const output = await run([], makeRuntime(), "text");

    expect(output).toContain("Scoped to src/");
  });

  it("includes scopeNote in toon output when present", async () => {
    mocks.executeGenerateWiki.mockResolvedValue(makeWikiResult({ scopeNote: "Scoped to src/" }));

    const output = await run(["--format", "toon"], makeRuntime(), "text");

    expect(output).toContain("scope: Scoped to src/");
  });

  it("does not include scopeNote line in markdown when absent", async () => {
    const output = await run([], makeRuntime(), "text");

    expect(output).not.toContain("Scope");
  });

  // -------------------------------------------------------------------------
  // 6. workspaceRoot is passed correctly
  // -------------------------------------------------------------------------

  it("passes normalized workspaceRoot to executeGenerateWiki", async () => {
    await run([], makeRuntime("/my/project"), "text");

    expect(mocks.executeGenerateWiki).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: expect.stringContaining("my"),
      }),
    );
  });
});
