import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CallGraphIndexer,
  type CallGraphNode,
} from "../../../src/analyzer/callgraph/CallGraphIndexer";
import { workerState } from "../../../src/mcp/shared/state";
import { executeQueryCallGraph } from "../../../src/mcp/tools/callgraph";
import { parseToolParams } from "../../../src/mcp/paramIssues";
import { QueryCallGraphParamsSchema } from "../../../src/mcp/types";

const SQL_WASM_PATH = path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const FILE = "/workspace/src/service.ts";

function method(name: string, line: number): CallGraphNode {
  return {
    id: `${FILE}:${name}:${line}`, name, type: "method", lang: "typescript", path: FILE,
    folder: path.dirname(FILE), startLine: line, endLine: line + 2, startCol: 2, isExported: false,
  };
}

/** The id results show: the stored 0-based row as the 1-based editor line (#793). */
const shownId = (node: CallGraphNode) => `${FILE}:${node.name}:${node.startLine + 1}`;

describe("executeQueryCallGraph exact selector", () => {
  const first = method("compute", 1);
  const second = method("compute", 5);
  const caller = method("run", 9);

  beforeEach(async () => {
    const indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
    indexer.indexFile(
      [first, second, caller],
      [{ sourceId: caller.id, targetId: first.id, typeRelation: "CALLS", sourceLine: 9 }],
      FILE, "typescript", Date.now(),
    );
    workerState.callGraphIndexer = indexer;
    workerState.callGraphIndexedRoot = "/workspace";
    workerState.config = { rootDir: "/workspace", excludeNodeModules: true, maxDepth: 10 };
    workerState.isReady = true;
  });

  afterEach(() => workerState.reset());

  it("returns ambiguity with candidates for a bare shared name", async () => {
    const result = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute" });
    expect(result.symbol).toBeNull();
    expect(result.reason).toBe("ambiguous");
    // Stored rows 1 and 5 are editor lines 2 and 6.
    expect(result.candidates?.map((c) => [c.startLine, c.endLine])).toEqual([[2, 4], [6, 8]]);
  });

  it("selects the second homonym with an empty caller set, distinct from a miss", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE, symbolName: "compute", symbolId: shownId(second), direction: "callers", depth: 1,
    });
    expect(result.symbol?.id).toBe(shownId(second));
    expect(result.reason).toBeUndefined();
    expect(result.callers).toEqual([]);
  });

  it("selects the first homonym with its caller by its 1-based startLine", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE, symbolName: "compute", startLine: 2, direction: "callers", depth: 1,
    });
    expect(result.symbol).toMatchObject({ id: shownId(first), startLine: 2 });
    expect(result.callers).toMatchObject([{ sourceName: "run", sourceLine: 10 }]);
  });

  it("selects a symbol declared on the file's first line with startLine 1", async () => {
    const top = method("boot", 0);
    workerState.callGraphIndexer?.indexFile([top, first, second, caller], [], FILE, "typescript", Date.now());
    const result = await executeQueryCallGraph({ filePath: FILE, symbolName: "boot", startLine: 1 });
    expect(result.symbol).toMatchObject({ id: `${FILE}:boot:1`, startLine: 1 });
  });

  it("rejects startLine 0 with a message naming 1-based lines", () => {
    const parsed = parseToolParams(QueryCallGraphParamsSchema, { filePath: FILE, symbolName: "compute", startLine: 0 });
    expect(parsed).toMatchObject({
      success: false,
      error: '"startLine" must be >= 1; got 0. startLine is 1-based (the editor line): the first line is 1.',
    });
  });

  it("keeps unambiguous bare names working", async () => {
    const result = await executeQueryCallGraph({ filePath: FILE, symbolName: "run" });
    expect(result.symbol?.id).toBe(shownId(caller));
  });

  it("accepts the workspace-relative id shown in MCP responses", async () => {
    for (const target of [first, second]) {
      const result = await executeQueryCallGraph({
        filePath: FILE, symbolName: "compute", symbolId: `src/service.ts:compute:${target.startLine + 1}`,
      });
      expect(result.symbol?.id).toBe(shownId(target));
    }
  });

  it("selects the symbol of an id copied from a result, its line the shown startLine", async () => {
    const { candidates } = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute" });
    expect(candidates?.map((candidate) => candidate.id)).toEqual([`${FILE}:compute:2`, `${FILE}:compute:6`]);
    for (const candidate of candidates ?? []) {
      const result = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute", symbolId: candidate.id, direction: "callers", depth: 1 });
      expect(result.symbol).toMatchObject({ id: candidate.id, startLine: candidate.startLine });
    }
    const { callers } = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute", startLine: 2, direction: "callers", depth: 1 });
    expect(callers).toMatchObject([{ sourceId: shownId(caller), targetId: shownId(first) }]);
    // The stored 0-based id is stale once shown ids are 1-based.
    const stored = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute", symbolId: first.id });
    expect(stored).toMatchObject({ symbol: null, reason: "stale_selector" });
  });

  it("keeps a relative id of another file, or a stale relative id, from selecting anything", async () => {
    const foreign = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute", symbolId: "src/other.ts:compute:1" });
    expect(foreign).toMatchObject({ symbol: null, reason: "stale_selector" });
    const stale = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute", symbolId: "src/service.ts:compute:77" });
    expect(stale).toMatchObject({ symbol: null, reason: "stale_selector" });
  });

  it("reports a stale selector and an unknown qualified name", async () => {
    const stale = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute", symbolId: `${FILE}:compute:77` });
    expect(stale.reason).toBe("stale_selector");
    await expect(executeQueryCallGraph({ filePath: FILE, symbolName: "OtherCalculator.compute" }))
      .rejects.toThrow("Symbol 'OtherCalculator.compute' not found");
  });

  it("validates the selector fields in the MCP schema", () => {
    const base = { filePath: FILE, symbolName: "compute" };
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, symbolId: first.id, startLine: 1 }).success).toBe(true);
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, startLine: 0 }).success).toBe(false);
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, startLine: 1.5 }).success).toBe(false);
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, symbolId: "a\0b" }).success).toBe(false);
  });
});
