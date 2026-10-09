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
import { executeGenerateWiki, GenerateWikiSchema } from "../../../src/mcp/tools/wiki.js";
import { normalizePath } from "../../../src/shared/path.js";

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
      outputDir: "wiki",
      topHubsLimit: 5,
    });

    expect(result.articlesCount).toBe(5);
  });

  it("returns topHubs array", async () => {
    const result = await executeGenerateWiki({
      outputDir: "wiki",
    });

    expect(result.topHubs).toHaveLength(2);
    expect(result.topHubs[0]).toMatchObject({ name: "CallGraphIndexer.ts", score: 42 });
  });

  // -------------------------------------------------------------------------
  // Path relativization
  // -------------------------------------------------------------------------

  it("indexPath is relative to workspaceRoot", async () => {
    const result = await executeGenerateWiki({
      outputDir: "wiki",
    });

    expect(result.indexPath).not.toContain(WORKSPACE);
    expect(path.isAbsolute(result.indexPath)).toBe(false);
  });

  it("articlesDir is relative to workspaceRoot", async () => {
    const result = await executeGenerateWiki({
      outputDir: "wiki",
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
      outputDir: "wiki",
      scope: "src/",
    });

    expect(result.scopeNote).toBe("Scoped to src/");
  });

  it("scopeNote is undefined when not returned", async () => {
    const result = await executeGenerateWiki({
      outputDir: "wiki",
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
      outputDir: "wiki",
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
      outputDir: "wiki",
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
      outputDir: "wiki",
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
      executeGenerateWiki({ outputDir: "wiki" }),
    ).rejects.toThrow(/not initialized/i);
  });

  // -------------------------------------------------------------------------
  // The workspace is supplied by the MCP session configuration.
  // -------------------------------------------------------------------------

  it("uses config.rootDir as the workspace", async () => {
    const { WikiGenerator } = await import("../../../src/analyzer/wiki/WikiGenerator.js");
    const WikiGeneratorMock = vi.mocked(WikiGenerator);
    WikiGeneratorMock.mockClear();

    await executeGenerateWiki({ outputDir: "wiki" });

    expect(WikiGeneratorMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: expect.stringContaining("wiki-mcp-workspace") }),
    );
  });

  it("resolves a relative outputDir against the workspace, not the process cwd", async () => {
    MockWikiGeneratorClass.mockClear();
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    await executeGenerateWiki({ outputDir: "audit-wiki" });

    expect(MockWikiGeneratorClass).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: normalizePath(path.join(WORKSPACE, "audit-wiki")),
      }),
    );
  });

  it("defaults outputDir to <workspace>/wiki", async () => {
    MockWikiGeneratorClass.mockClear();

    await executeGenerateWiki({});

    expect(MockWikiGeneratorClass).toHaveBeenCalledWith(
      expect.objectContaining({ outputDir: normalizePath(path.join(WORKSPACE, "wiki")), overwrite: false }),
    );
  });

  it("forwards the overwrite opt-in to WikiGenerator", async () => {
    MockWikiGeneratorClass.mockClear();

    await executeGenerateWiki({ outputDir: "docs" }, true);

    expect(MockWikiGeneratorClass).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true }));
  });

  it("accepts an absolute outputDir inside the workspace (CLI path)", async () => {
    MockWikiGeneratorClass.mockClear();

    await executeGenerateWiki({ outputDir: path.join(WORKSPACE, "docs", "wiki") });

    expect(MockWikiGeneratorClass).toHaveBeenCalledWith(
      expect.objectContaining({ outputDir: normalizePath(path.join(WORKSPACE, "docs", "wiki")) }),
    );
  });

  it.each([
    ["an absolute path outside the workspace", () => path.join(os.tmpdir(), "elsewhere")],
    ["a ../ escape", () => path.join("..", "elsewhere")],
    ["a sibling sharing the workspace prefix", () => `${WORKSPACE}-sibling`],
  ])("rejects %s before generating anything (#269)", async (_label, outputDir) => {
    MockWikiGeneratorClass.mockClear();

    await expect(executeGenerateWiki({ outputDir: outputDir() })).rejects.toThrow("outside workspace");
    expect(MockWikiGeneratorClass).not.toHaveBeenCalled();
  });

  it("rejects an outputDir containing a null byte", async () => {
    MockWikiGeneratorClass.mockClear();

    await expect(executeGenerateWiki({ outputDir: "wi\0ki" })).rejects.toThrow("null bytes");
    expect(MockWikiGeneratorClass).not.toHaveBeenCalled();
  });

  it("rejects an outputDir that leaves the workspace through a symbolic link (#269)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-mcp-root-"));
    try {
      await fs.symlink(tmpDir, path.join(root, "linked"), "junction");
      vi.mocked(workerState.getConfig).mockReturnValue({ rootDir: root } as unknown as ReturnType<typeof workerState.getConfig>);
      workerState.callGraphIndexedRoot = normalizePath(root);
      MockWikiGeneratorClass.mockClear();

      await expect(executeGenerateWiki({ outputDir: "linked" })).rejects.toThrow("symbolic link");
      expect(MockWikiGeneratorClass).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("rejects an outputDir on another Windows drive", async () => {
    await expect(executeGenerateWiki({ outputDir: String.raw`Z:\elsewhere` })).rejects.toThrow("outside workspace");
  });
});

describe("GenerateWikiSchema", () => {
  it("accepts only workspace-relative output directories", () => {
    expect(GenerateWikiSchema.safeParse({ outputDir: "docs/wiki" }).success).toBe(true);
    expect(GenerateWikiSchema.safeParse({ outputDir: "/tmp/wiki" }).success).toBe(false);
  });

  it("does not allow overriding the configured MCP workspace", () => {
    expect(GenerateWikiSchema.safeParse({ workspaceRoot: "/tmp" }).success).toBe(false);
  });
});
