/**
 * Unit tests for the MCP wiki generation tool (executeGenerateWiki).
 * Uses a mock CallGraphIndexer (no sql.js WASM) — WikiGenerator runs for real.
 */

import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGraphIndexer } from "../../../src/analyzer/callgraph/CallGraphIndexer";
import { workerState } from "../../../src/mcp/shared/state";
import { executeGenerateWiki } from "../../../src/mcp/tools/wiki";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeGenerateWiki", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-mcp-test-"));
    vi.resetAllMocks();

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
    await fs.rm(tmpDir, { recursive: true, force: true });
    workerState.callGraphIndexer = undefined as unknown as CallGraphIndexer;
    workerState.callGraphIndexedRoot = undefined as unknown as string;
  });

  it("returns articlesCount 0 for empty db", async () => {
    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
      topHubsLimit: 5,
    });

    expect(result.articlesCount).toBe(0);
    expect(result.topHubs).toEqual([]);
  });

  it("creates index.md file", async () => {
    await executeGenerateWiki({ workspaceRoot: WORKSPACE, outputDir: tmpDir });

    const indexExists = await fs.stat(path.join(tmpDir, "index.md")).then(() => true).catch(() => false);
    expect(indexExists).toBe(true);
  });

  it("indexPath and articlesDir do not contain absolute workspace path", async () => {
    const result = await executeGenerateWiki({
      workspaceRoot: WORKSPACE,
      outputDir: tmpDir,
    });

    expect(result.indexPath).not.toContain(WORKSPACE);
    expect(result.articlesDir).not.toContain(WORKSPACE);
  });

  it("throws when callGraphIndexer not initialized", async () => {
    workerState.callGraphIndexer = undefined as unknown as CallGraphIndexer;

    await expect(
      executeGenerateWiki({ workspaceRoot: WORKSPACE, outputDir: tmpDir }),
    ).rejects.toThrow();
  });

  it("uses configured workspaceRoot when not provided", async () => {
    const result = await executeGenerateWiki({ outputDir: tmpDir });

    expect(result.articlesCount).toBeGreaterThanOrEqual(0);
    expect(result.indexPath).toBeDefined();
  });
});
