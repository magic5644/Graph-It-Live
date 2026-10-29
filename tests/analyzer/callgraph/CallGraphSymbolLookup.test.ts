import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CallGraphIndexer,
  type CallGraphNode,
} from "../../../src/analyzer/callgraph/CallGraphIndexer";
import { lookupCallGraphSymbol } from "../../../src/analyzer/callgraph/CallGraphSymbolLookup";

const SQL_WASM_PATH = path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const FILE = "/workspace/src/service.ts";
const OTHER_FILE = "/workspace/src/other.ts";

function node(filePath: string, name: string, line: number): CallGraphNode {
  return {
    id: `${filePath}:${name}:${line}`,
    name,
    type: "method",
    lang: "typescript",
    path: filePath,
    folder: path.dirname(filePath),
    startLine: line,
    endLine: line + 2,
    startCol: 2,
    isExported: false,
  };
}

describe("lookupCallGraphSymbol", () => {
  let indexer: CallGraphIndexer;
  const first = node(FILE, "compute", 1);
  const second = node(FILE, "compute", 5);
  const unique = node(FILE, "format", 9);

  beforeEach(async () => {
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
    indexer.indexFile([first, second, unique], [], FILE, "typescript", Date.now());
    indexer.indexFile([node(OTHER_FILE, "compute", 1)], [], OTHER_FILE, "typescript", Date.now());
  });

  it("returns the only node for an unambiguous bare name", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), { filePath: FILE, symbolName: "format" });
    expect(result.symbol?.id).toBe(unique.id);
  });

  it("reports ambiguity with ordered candidates instead of picking the first row", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), { filePath: FILE, symbolName: "compute" });
    expect(result).toMatchObject({ symbol: null, reason: "ambiguous" });
    expect("candidates" in result && result.candidates.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("selects either homonym exactly by symbolId", () => {
    for (const target of [first, second]) {
      const result = lookupCallGraphSymbol(indexer.getDb(), {
        filePath: FILE,
        symbolName: "compute",
        symbolId: target.id,
      });
      expect(result.symbol?.id).toBe(target.id);
    }
  });

  it("selects a homonym by startLine", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: FILE,
      symbolName: "compute",
      startLine: 5,
    });
    expect(result.symbol?.startLine).toBe(5);
  });

  it("flags a stale symbolId and lists the current same-name nodes", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: FILE,
      symbolName: "compute",
      symbolId: `${FILE}:compute:99`,
    });
    expect(result).toMatchObject({ symbol: null, reason: "stale_selector" });
    expect("candidates" in result && result.candidates).toHaveLength(2);
  });

  it("flags a stale startLine", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: FILE,
      symbolName: "compute",
      startLine: 42,
    });
    expect(result).toMatchObject({ symbol: null, reason: "stale_selector" });
  });

  it("reports not_found for a deleted symbol, even with a selector", () => {
    const withId = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: FILE,
      symbolName: "gone",
      symbolId: `${FILE}:gone:3`,
    });
    expect(withId).toMatchObject({ symbol: null, reason: "not_found", candidates: [] });
    expect(lookupCallGraphSymbol(indexer.getDb(), { filePath: FILE, symbolName: "gone" })).toMatchObject({
      reason: "not_found",
    });
  });

  it("reports not_found for a qualified name instead of guessing from a suffix", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: FILE,
      symbolName: "OtherCalculator.compute",
    });
    expect(result).toMatchObject({ symbol: null, reason: "not_found" });
  });

  it("cannot reach a node of another file with a foreign symbolId", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: FILE,
      symbolName: "compute",
      symbolId: `${OTHER_FILE}:compute:1`,
    });
    expect(result).toMatchObject({ symbol: null, reason: "stale_selector" });
    expect("candidates" in result && result.candidates.every((c) => c.filePath === FILE)).toBe(true);
  });

  it("treats SQL metacharacters in selectors as plain data", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: FILE,
      symbolName: "compute",
      symbolId: "x' OR '1'='1",
    });
    expect(result).toMatchObject({ symbol: null, reason: "stale_selector" });
    expect(lookupCallGraphSymbol(indexer.getDb(), { filePath: FILE, symbolName: "' OR 1=1 --" }).symbol).toBeNull();
  });

  it("normalizes Windows separators in filePath", () => {
    const result = lookupCallGraphSymbol(indexer.getDb(), {
      filePath: "\\workspace\\src\\service.ts",
      symbolName: "format",
    });
    expect(result.symbol?.id).toBe(unique.id);
  });
});
