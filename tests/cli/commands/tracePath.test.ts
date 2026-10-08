/**
 * Unit tests for `graph-it trace` and `graph-it path`: argument checks and
 * --maxDepth validation (#230). The MCP tool executors are mocked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeTraceFunctionExecution: vi.fn(),
  executeCrawlDependencyGraph: vi.fn(),
}));

vi.mock("../../../src/mcp/tools", () => ({
  executeTraceFunctionExecution: mocks.executeTraceFunctionExecution,
  executeCrawlDependencyGraph: mocks.executeCrawlDependencyGraph,
}));

import { run as runPath } from "../../../src/cli/commands/path.js";
import { run as runTrace } from "../../../src/cli/commands/trace.js";

describe("trace and path commands", () => {
  let root: string;
  const runtime = () => ({ workspaceRoot: root, ensureIndexed: vi.fn().mockResolvedValue(undefined) }) as never;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-trace-")));
    fs.writeFileSync(path.join(root, "a.ts"), "export function run() {}\n");
    mocks.executeTraceFunctionExecution.mockReset().mockResolvedValue({ callChain: [] });
    mocks.executeCrawlDependencyGraph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("trace", () => {
    it("traces a symbol with the given --maxDepth", async () => {
      await runTrace(["a.ts#run", "--maxDepth", "4"], runtime(), "json");

      expect(mocks.executeTraceFunctionExecution).toHaveBeenCalledWith({
        filePath: path.join(root, "a.ts"),
        symbolName: "run",
        maxDepth: 4,
      });
    });

    it("leaves maxDepth to the tool default when the flag is absent", async () => {
      await runTrace(["a.ts#run"], runtime(), "json");

      expect(mocks.executeTraceFunctionExecution).toHaveBeenCalledWith(
        expect.objectContaining({ maxDepth: undefined }),
      );
    });

    it.each(["nope", "0", "101", "-2"])("rejects --maxDepth %s before indexing or tracing", async (value) => {
      const rt = runtime() as { ensureIndexed: ReturnType<typeof vi.fn> };
      await expect(runTrace(["a.ts#run", "--maxDepth", value], rt as never, "json")).rejects.toThrow(
        `--maxDepth must be an integer between 1 and 100, got "${value}"`,
      );
      expect(rt.ensureIndexed).not.toHaveBeenCalled();
      expect(mocks.executeTraceFunctionExecution).not.toHaveBeenCalled();
    });

    it("labels Mermaid nodes with workspace-relative paths (#265)", async () => {
      mocks.executeTraceFunctionExecution.mockResolvedValue({
        callChain: [{ callerSymbolId: `${root}/a.ts:run`, calledSymbolId: `${root}/b.ts:end` }],
      });

      const out = await runTrace(["a.ts#run"], runtime(), "mermaid");

      expect(out).toContain('S0["run · a.ts"]');
      expect(out).toContain('S1["end · b.ts"]');
      expect(out).not.toContain(root);
    });

    it("requires a symbol reference", async () => {
      await expect(runTrace([], runtime(), "json")).rejects.toThrow("Usage: graph-it trace");
    });

    it("requires a symbol name after the file", async () => {
      await expect(runTrace(["a.ts"], runtime(), "json")).rejects.toThrow("trace requires a symbol name");
    });
  });

  describe("path", () => {
    it("crawls from the entry file with the given --maxDepth", async () => {
      await runPath(["a.ts", "--maxDepth", "2"], runtime(), "json");

      expect(mocks.executeCrawlDependencyGraph).toHaveBeenCalledWith({
        entryFile: path.join(root, "a.ts"),
        maxDepth: 2,
      });
    });

    it("rejects a non-numeric --maxDepth before crawling", async () => {
      await expect(runPath(["a.ts", "--maxDepth", "deep"], runtime(), "json")).rejects.toThrow(
        `--maxDepth must be an integer between 1 and 100, got "deep"`,
      );
      expect(mocks.executeCrawlDependencyGraph).not.toHaveBeenCalled();
    });

    it("requires an entry file", async () => {
      await expect(runPath([], runtime(), "json")).rejects.toThrow("Usage: graph-it path");
    });
  });
});
