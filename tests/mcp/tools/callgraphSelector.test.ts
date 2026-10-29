import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CallGraphIndexer,
  type CallGraphNode,
} from "../../../src/analyzer/callgraph/CallGraphIndexer";
import { workerState } from "../../../src/mcp/shared/state";
import { executeQueryCallGraph } from "../../../src/mcp/tools/callgraph";
import { QueryCallGraphParamsSchema } from "../../../src/mcp/types";

const SQL_WASM_PATH = path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const FILE = "/workspace/src/service.ts";

function method(name: string, line: number): CallGraphNode {
  return {
    id: `${FILE}:${name}:${line}`, name, type: "method", lang: "typescript", path: FILE,
    folder: path.dirname(FILE), startLine: line, endLine: line + 2, startCol: 2, isExported: false,
  };
}

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
    expect(result.candidates?.map((c) => c.startLine)).toEqual([1, 5]);
  });

  it("selects the second homonym with an empty caller set, distinct from a miss", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE, symbolName: "compute", symbolId: second.id, direction: "callers", depth: 1,
    });
    expect(result.symbol?.id).toBe(second.id);
    expect(result.reason).toBeUndefined();
    expect(result.callers).toEqual([]);
  });

  it("selects the first homonym with its caller by startLine", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE, symbolName: "compute", startLine: 1, direction: "callers", depth: 1,
    });
    expect(result.symbol?.id).toBe(first.id);
    expect(result.callers).toHaveLength(1);
  });

  it("keeps unambiguous bare names working", async () => {
    const result = await executeQueryCallGraph({ filePath: FILE, symbolName: "run" });
    expect(result.symbol?.id).toBe(caller.id);
  });

  it("reports a stale selector and an unknown qualified name", async () => {
    const stale = await executeQueryCallGraph({ filePath: FILE, symbolName: "compute", symbolId: `${FILE}:compute:77` });
    expect(stale.reason).toBe("stale_selector");
    const qualified = await executeQueryCallGraph({ filePath: FILE, symbolName: "OtherCalculator.compute" });
    expect(qualified.reason).toBe("not_found");
  });

  it("validates the selector fields in the MCP schema", () => {
    const base = { filePath: FILE, symbolName: "compute" };
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, symbolId: first.id, startLine: 1 }).success).toBe(true);
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, startLine: -1 }).success).toBe(false);
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, startLine: 1.5 }).success).toBe(false);
    expect(QueryCallGraphParamsSchema.safeParse({ ...base, symbolId: "a\0b" }).success).toBe(false);
  });
});
