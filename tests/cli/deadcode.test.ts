/**
 * CLI integration tests for the `check` command with dead-code scan feature.
 *
 * Three modes are tested:
 *   1. `check` with no args   → full workspace dead-code scan
 *   2. `check ./src`          → scoped scan of a directory
 *   3. `check ./src/foo.ts`   → per-file unused-symbol check (existing behaviour)
 *
 * Spider and MCP tool functions are mocked so no WASM / AST is loaded.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../src/mcp/shared/state";

// ---------------------------------------------------------------------------
// Helper: tiny fixture project
// ---------------------------------------------------------------------------

function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-check-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "index.ts"),
    `export const x = 1;\n`,
  );
  fs.writeFileSync(
    path.join(root, "src", "utils.ts"),
    `export function helper(): void {}\n`,
  );
  return root;
}

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const scanDeadCodeMock = vi.fn();
const findUnusedSymbolsMock = vi.fn();

vi.mock("../../src/mcp/tools", () => ({
  executeScanDeadCode: (...args: unknown[]) => scanDeadCodeMock(...args),
  executeFindUnusedSymbols: (...args: unknown[]) => findUnusedSymbolsMock(...args),
}));

vi.mock("../../src/cli/formatter", () => ({
  formatOutput: (result: unknown) => JSON.stringify(result),
}));

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("CLI check command", () => {
  let tmpDir: string;

  const runtimeStub = {
    ensureIndexed: vi.fn(),
    workspaceRoot: "",
  };

  beforeEach(() => {
    tmpDir = createFixtureProject();
    runtimeStub.workspaceRoot = tmpDir;
    runtimeStub.ensureIndexed.mockResolvedValue(undefined);

    // Default mock returns for each mode
    scanDeadCodeMock.mockResolvedValue({
      rootDir: tmpDir,
      scopePath: tmpDir,
      scannedFiles: 2,
      filesWithDeadCode: 1,
      totalUnusedSymbols: 1,
      entries: [
        {
          filePath: path.join(tmpDir, "src", "utils.ts"),
          relativePath: "src/utils.ts",
          unusedCount: 1,
          unusedSymbols: [{ id: "s:helper", name: "helper", kind: "FunctionDeclaration", line: 1, isExported: true }],
        },
      ],
      skippedFiles: 0,
      analysisTimeMs: 42,
    });

    findUnusedSymbolsMock.mockResolvedValue({
      filePath: path.join(tmpDir, "src", "utils.ts"),
      unusedSymbols: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    workerState.reset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Mode 1: no args ────────────────────────────────────────────────────────

  describe("no arguments → workspace scan", () => {
    it("calls executeScanDeadCode with no args", async () => {
      const { run } = await import("../../src/cli/commands/check.js");
      await run([], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(scanDeadCodeMock).toHaveBeenCalledOnce();
      expect(scanDeadCodeMock).toHaveBeenCalledWith({});
    });

    it("does NOT call executeFindUnusedSymbols", async () => {
      const { run } = await import("../../src/cli/commands/check.js");
      await run([], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(findUnusedSymbolsMock).not.toHaveBeenCalled();
    });

    it("calls ensureIndexed before scanning", async () => {
      const { run } = await import("../../src/cli/commands/check.js");
      await run([], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(runtimeStub.ensureIndexed).toHaveBeenCalledOnce();
    });

    it("returns formatted output string", async () => {
      const { run } = await import("../../src/cli/commands/check.js");
      const output = await run([], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(typeof output).toBe("string");
      expect(output.length).toBeGreaterThan(0);
    });
  });

  // ── Mode 2: directory arg ──────────────────────────────────────────────────

  describe("directory argument → scoped scan", () => {
    it("calls executeScanDeadCode with the directory as scopePath", async () => {
      const srcDir = path.join(tmpDir, "src");
      const { run } = await import("../../src/cli/commands/check.js");
      await run([srcDir], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(scanDeadCodeMock).toHaveBeenCalledOnce();
      expect(scanDeadCodeMock).toHaveBeenCalledWith({ scopePath: srcDir });
    });

    it("does NOT call executeFindUnusedSymbols", async () => {
      const srcDir = path.join(tmpDir, "src");
      const { run } = await import("../../src/cli/commands/check.js");
      await run([srcDir], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(findUnusedSymbolsMock).not.toHaveBeenCalled();
    });
  });

  // ── Mode 3: file arg ───────────────────────────────────────────────────────

  describe("file argument → per-file unused-symbol check", () => {
    it("calls executeFindUnusedSymbols with the file path", async () => {
      const filePath = path.join(tmpDir, "src", "utils.ts");
      const { run } = await import("../../src/cli/commands/check.js");
      await run([filePath], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(findUnusedSymbolsMock).toHaveBeenCalledOnce();
      expect(findUnusedSymbolsMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath }),
      );
    });

    it("does NOT call executeScanDeadCode", async () => {
      const filePath = path.join(tmpDir, "src", "utils.ts");
      const { run } = await import("../../src/cli/commands/check.js");
      await run([filePath], runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime, "text");

      expect(scanDeadCodeMock).not.toHaveBeenCalled();
    });
  });

  // ── scan_dead_code in tool --list ──────────────────────────────────────────

  describe("tool --list includes scan_dead_code", () => {
    it("lists scan_dead_code in --list output", async () => {
      const { run: toolRun } = await import("../../src/cli/commands/tool.js");
      const output = await toolRun(
        ["--list"],
        runtimeStub as unknown as import("../../src/cli/runtime").CliRuntime,
        "text",
      );
      expect(output).toContain("scan_dead_code");
    });
  });
});
