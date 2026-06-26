/**
 * Unit tests for the MCP wiki generation tool (executeGenerateWiki).
 * WikiGenerator is mocked via vi.mock so executeGenerateWiki runs for real.
 */

import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGraphIndexer } from "../../../src/analyzer/callgraph/CallGraphIndexer.js";

// ---------------------------------------------------------------------------
// Hoist mocks — must run before any imports of the modules under test
// ---------------------------------------------------------------------------

const mockGenerate = vi.fn();

const MockWikiGeneratorClass = vi.fn().mockImplementation(function () {
  return { generate: mockGenerate };
});

vi.mock("../../../src/analyzer/wiki/WikiGenerator.js", () => ({
  WikiGenerator: MockWikiGeneratorClass,
}));

// Mock dynamic import of callgraph used by ensureCallGraphReady
vi.mock("../../../src/mcp/tools/callgraph.js", () => ({
  executeQueryCallGraph: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { workerState } from "../../../src/mcp/shared/state.js";
import { executeGenerateWiki } from "../../../src/mcp/tools/wiki.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE = path.join(os.tmpdir(), "wiki-mcp-workspace");

function makeMockDb() {
  return {
    exec: vi.fn().mockReturnValue([]),
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn(),
      step: vi.fn().mockReturnValue(false),
      getAsObject: vi.fn().mockReturnValue({}),
      free: vi.fn(),
    }),
  };
}

function makeMockIndexer(): CallGraphIndexer {
  return {
    getDb: vi.fn().mockReturnValue(makeMockDb()),
    isReady: vi.fn().mockReturnValue(true),
  } as unknown as CallGraphIndexer;
}

function makeGenerateResult(overrides = {}) {
  return {
    articlesCount: 5,
    indexPath: path.join(WORKSPACE, "wiki", "index.md"),
    articlesDir: path.join(WORKSPACE, "wiki", "articles"),
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

describe("executeGenerateWiki", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-mcp-test-"));

    // Default generate mock
    mockGenerate.mockResolvedValue(makeGenerateResult({
      indexPath: path.join(tmpDir, "index.md"),
      articlesDir: path.join(tmpDir, "articles"),
    }));

    // Wire up workerState
    workerState.callGraphIndexer = makeMockIndexer();
    workerState.callGraphIndexedRoot = WORKSPACE;

    vi.spyOn(workerState, "getConfig").mockReturnValue({
      rootDir: WORKSPACE,
      tsConfigPath: undefined,
      excludeNodeModules: true,
      maxDepth: 50,
    } as unknown as ReturnType<typeof workerState.getConfig>);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockGenerate.mockReset();
    await fs.rm(tmpDir, { recursive: true, force: true });
    workerState.callGraphIndexer = undefined as unknown as CallGraphIndexer;
    workerState.callGraphIndexedRoot = undefined as unknown as string;
  });

  // -------------------------------------------------------------------------
  // Basic shape
  // -------------------------------------------------------------------------

  it("returns articlesCount from WikiGenerator result", async () => {
    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
      topHubsLimit: 5,
    });

    expect(result.articlesCount).toBe(5);
  });

  it("returns topHubs array", async () => {
    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
    });

    expect(result.topHubs).toHaveLength(2);
    expect(result.topHubs[0]).toMatchObject({ name: "CallGraphIndexer.ts", score: 42 });
  });

  // -------------------------------------------------------------------------
  // Path relativization
  // -------------------------------------------------------------------------

  it("indexPath is relative to workspaceRoot", async () => {
    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
    });

    expect(result.indexPath).not.toContain(WORKSPACE);
    expect(path.isAbsolute(result.indexPath)).toBe(false);
  });

  it("articlesDir is relative to workspaceRoot", async () => {
    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
    });

    expect(result.articlesDir).not.toContain(WORKSPACE);
    expect(path.isAbsolute(result.articlesDir)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // scopeNote propagation
  // -------------------------------------------------------------------------

  it("propagates scopeNote when WikiGenerator returns one", async () => {
    mockGenerate.mockResolvedValue(makeGenerateResult({
      indexPath: path.join(tmpDir, "index.md"),
      articlesDir: path.join(tmpDir, "articles"),
      scopeNote: "Scoped to src/",
    }));

    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
      scope: "src/",
    });

    expect(result.scopeNote).toBe("Scoped to src/");
  });

  it("scopeNote is undefined when not returned", async () => {
    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
    });

    expect(result.scopeNote).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // WikiGenerator constructor args
  // -------------------------------------------------------------------------

  it("passes topHubsLimit to WikiGenerator", async () => {
    const { WikiGenerator } = await import("../../../src/analyzer/wiki/WikiGenerator.js");
    const WikiGeneratorMock = vi.mocked(WikiGenerator);
    WikiGeneratorMock.mockClear();

    await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
      topHubsLimit: 7,
    });

    expect(WikiGeneratorMock).toHaveBeenCalledWith(
      expect.objectContaining({ topHubsLimit: 7 }),
    );
  });

  it("passes scope to WikiGenerator when provided", async () => {
    const { WikiGenerator } = await import("../../../src/analyzer/wiki/WikiGenerator.js");
    const WikiGeneratorMock = vi.mocked(WikiGenerator);
    WikiGeneratorMock.mockClear();

    await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
      scope: "src/analyzer",
    });

    expect(WikiGeneratorMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "src/analyzer" }),
    );
  });

  it("passes exclude array to WikiGenerator when provided", async () => {
    const { WikiGenerator } = await import("../../../src/analyzer/wiki/WikiGenerator.js");
    const WikiGeneratorMock = vi.mocked(WikiGenerator);
    WikiGeneratorMock.mockClear();

    await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
      exclude: ["tests/", "dist/"],
    });

    expect(WikiGeneratorMock).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: ["tests/", "dist/"] }),
    );
  });

  // -------------------------------------------------------------------------
  // Error: indexer not initialized
  // -------------------------------------------------------------------------

  it("throws when callGraphIndexer is not initialized", async () => {
    workerState.callGraphIndexer = undefined as unknown as CallGraphIndexer;
    // Force callGraphIndexedRoot mismatch so ensureCallGraphReady tries to init
    workerState.callGraphIndexedRoot = undefined as unknown as string;

    await expect(
      executeGenerateWiki({ workspaceRoot: WORKSPACE, outputDir: tmpDir }),
    ).rejects.toThrow(/not initialized/i);
  });

  // -------------------------------------------------------------------------
  // workspaceRoot fallback from config
  // -------------------------------------------------------------------------

  it("uses config.rootDir when workspaceRoot is not provided", async () => {
    const { WikiGenerator } = await import("../../../src/analyzer/wiki/WikiGenerator.js");
    const WikiGeneratorMock = vi.mocked(WikiGenerator);
    WikiGeneratorMock.mockClear();

    await executeGenerateWiki({ outputDir: tmpDir });

    expect(WikiGeneratorMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: expect.stringContaining("wiki-mcp-workspace") }),
    );
  });
});
