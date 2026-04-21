/**
 * MCP Worker integration tests for scan_dead_code
 *
 * Tests the full invocation path:
 *   invokeTool(requestId, "scan_dead_code", params, postMessage)
 *     → executeScanDeadCode() → spider.scanDeadCode()
 *
 * Mirrors the pattern used in McpWorker.test.ts (real Spider, tmp workspace).
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Spider } from "../../src/analyzer/Spider";
import { SpiderBuilder } from "../../src/analyzer/SpiderBuilder";
import { workerState } from "../../src/mcp/shared/state";
import type { McpWorkerResponse, ScanDeadCodeResult } from "../../src/mcp/types";
import { invokeTool } from "../../src/mcp/worker/invokeTool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal workspace: one file with an exported but never-imported function. */
async function createDeadCodeWorkspace(root: string) {
  const src = path.join(root, "src");
  await fs.mkdir(src, { recursive: true });

  // index.ts imports usedHelper — this creates a reverse-index entry for utils.ts
  // BUT does NOT import unusedHelper or anotherUnused → those remain dead code
  await fs.writeFile(
    path.join(src, "index.ts"),
    `import { usedHelper } from "./utils";\n` +
      `export const main = (): void => { usedHelper(); };\n`,
  );

  await fs.writeFile(
    path.join(src, "utils.ts"),
    `export function usedHelper(): void { console.log("used"); }\n` +
      `export function unusedHelper(): number { return 42; }\n` +
      `export function anotherUnused(): string { return "x"; }\n`,
  );

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-workspace", version: "1.0.0" }),
  );
}

/**
 * Wrap invokeTool into a Promise that resolves/rejects from the postMessage callback.
 */
async function callTool(tool: string, params: unknown): Promise<McpWorkerResponse> {
  return new Promise((resolve) => {
    invokeTool(
      "test-request-id",
      tool as Parameters<typeof invokeTool>[1],
      params,
      (msg: McpWorkerResponse) => resolve(msg),
    ).catch((err: unknown) => {
      resolve({ type: "error", requestId: "test-request-id", error: err instanceof Error ? err.message : "unknown", code: "EXECUTION_ERROR" });
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("MCP invokeTool – scan_dead_code", () => {
  let tempDir: string;
  let spider: Spider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "mcp-scan-dead-code-"));
    await createDeadCodeWorkspace(tempDir);

    spider = new SpiderBuilder()
      .withRootDir(tempDir)
      .withMaxDepth(10)
      .withReverseIndex(true)
      .withExcludeNodeModules(true)
      .withExtensionPath(process.cwd())
      .build();

    // Seed reverse index so scanDeadCode can work
    await spider.buildFullIndex();

    workerState.spider = spider as unknown as typeof workerState.spider;
    workerState.parser = {} as unknown as typeof workerState.parser;
    workerState.resolver = {} as unknown as typeof workerState.resolver;
    workerState.config = {
      rootDir: tempDir,
      excludeNodeModules: true,
      maxDepth: 10,
    };
    workerState.isReady = true;
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("returns a successful ScanDeadCodeResult via invokeTool", async () => {
    const response = await callTool("scan_dead_code", {});

    expect(response.type).toBe("result");
    if (response.type !== "result") return;
    const result = response.data as ScanDeadCodeResult;

    expect(result.rootDir).toBe(tempDir);
    expect(result.scopePath).toBe(tempDir);
    expect(result.scannedFiles).toBeGreaterThanOrEqual(1);
    expect(result.filesWithDeadCode).toBeGreaterThanOrEqual(0);
    expect(result.skippedFiles).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.entries)).toBe(true);
    expect(typeof result.analysisTimeMs).toBe("number");
    expect(result.analysisTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("detects unused exported symbols in the workspace", async () => {
    const response = await callTool("scan_dead_code", {});

    expect(response.type).toBe("result");
    if (response.type !== "result") return;
    const result = response.data as ScanDeadCodeResult;

    // utils.ts has two exported functions never referenced anywhere
    const utilsEntry = result.entries.find((e) =>
      e.filePath.endsWith("utils.ts"),
    );
    expect(utilsEntry).toBeDefined();
    if (utilsEntry) {
      expect(utilsEntry.unusedCount).toBeGreaterThanOrEqual(1);
      expect(utilsEntry.unusedSymbols.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("respects scopePath parameter — limits scan to a subdirectory", async () => {
    const srcDir = path.join(tempDir, "src");
    const response = await callTool("scan_dead_code", { scopePath: srcDir });

    expect(response.type).toBe("result");
    if (response.type !== "result") return;
    const result = response.data as ScanDeadCodeResult;

    expect(result.scopePath).toBe(srcDir);
    // All returned file paths are inside src/
    for (const entry of result.entries) {
      expect(entry.filePath.startsWith(srcDir)).toBe(true);
    }
  });

  it("respects maxFiles parameter", async () => {
    const response = await callTool("scan_dead_code", { maxFiles: 1 });

    expect(response.type).toBe("result");
    if (response.type !== "result") return;
    const result = response.data as ScanDeadCodeResult;

    // At most 1 file was analysed
    expect(result.scannedFiles).toBeLessThanOrEqual(1);
  });

  it("returns error for scopePath outside workspace", async () => {
    const response = await callTool("scan_dead_code", {
      scopePath: "/tmp/some-other-totally-unrelated-path",
    });

    // Should propagate as an error (security or path validation)
    expect(response.type).toBe("error");
  });

  it("result entries include relativePath field", async () => {
    const response = await callTool("scan_dead_code", {});

    expect(response.type).toBe("result");
    if (response.type !== "result") return;
    const result = response.data as ScanDeadCodeResult;

    for (const entry of result.entries) {
      expect(typeof entry.relativePath).toBe("string");
      // relativePath must be shorter than the absolute filePath
      expect(entry.relativePath.length).toBeLessThan(entry.filePath.length);
    }
  });
});
