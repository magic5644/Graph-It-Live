/**
 * The MCP call graph build extracts files in parallel, a window at a time, and writes them to the DB in job
 * order: a slow extraction never reorders the writes, and a failing one is skipped without blocking the rest.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { SourceFileCollector } from "@/analyzer/SourceFileCollector";
import type { CliRuntime } from "@/cli/runtime";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { normalizePath } from "@/shared/path";
import { indexWorkspace, wasmBuilt } from "./callGraphWorkspace";

// More files than one extraction window (64), so the build crosses a window boundary.
const FILE_COUNT = 70;
const files = Object.fromEntries(
  Array.from({ length: FILE_COUNT }, (_, i) => [`f${i}.ts`, `export function fn${i}() { return ${i}; }\n`]),
);

describe.skipIf(!wasmBuilt)("call graph build write order", { timeout: 60_000 }, () => {
  let tmpDir = "";
  let runtime: CliRuntime | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await runtime?.dispose();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes in job order whatever the extraction order, skipping a failed file", async () => {
    const started: string[] = [];
    const written: string[] = [];
    const extract = GraphExtractor.prototype.extractFile;
    vi.spyOn(GraphExtractor.prototype, "extractFile").mockImplementation(async function (this: GraphExtractor, ...args) {
      const file = normalizePath(args[0]);
      started.push(file);
      // The first job is the slowest, so later ones finish first; one job fails.
      if (started.length === 1) await new Promise((resolve) => setTimeout(resolve, 50));
      if (file.endsWith("/f3.ts")) throw new Error("unparsable");
      return extract.apply(this, args);
    });
    const index = CallGraphIndexer.prototype.indexFile;
    vi.spyOn(CallGraphIndexer.prototype, "indexFile").mockImplementation(function (this: CallGraphIndexer, ...args) {
      written.push(normalizePath(args[2]));
      return index.apply(this, args);
    });

    ({ tmpDir, runtime } = await indexWorkspace("callgraph-order-", files));
    await executeQueryCallGraph({ filePath: path.join(tmpDir, "src/f0.ts"), symbolName: "fn0", direction: "callers", depth: 1 });

    // Job order is the source collector's order.
    const jobOrder = (await new SourceFileCollector({ excludeNodeModules: true }).collectAllSourceFiles(tmpDir))
      .map(normalizePath)
      .filter((file) => file.includes("/src/f"));
    expect(jobOrder).toHaveLength(FILE_COUNT);
    expect(started.filter((file) => file.includes("/src/f"))).toHaveLength(FILE_COUNT);
    expect(written.filter((file) => file.includes("/src/f"))).toEqual(jobOrder.filter((file) => !file.endsWith("/f3.ts")));
  });
});
