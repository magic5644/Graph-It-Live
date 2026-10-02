/**
 * query_call_graph must flag call cycles that span files, on a cold build and
 * after incremental refreshes (#239).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliRuntime } from "@/cli/runtime";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { executeInvalidateFiles } from "@/mcp/tools/workspace";
import { normalizePath } from "@/shared/path";
import { indexWorkspace, rewriteKeepingMtime, wasmBuilt } from "./callGraphWorkspace";

// a -> b -> c -> a. Only a and its importer c are re-extracted when a changes.
const A_CALLS_B = 'import { b } from "./b";\nexport function a(n: number): number { return n > 0 ? b(n - 1) : 0; }\n';
// Same length as A_CALLS_B, so neither size nor mtime betrays the edit.
const A_ALONE = 'import { b } from "./b";\nexport function a(n: number): number { return n > 0 ? 7 + n - 1 : 0; }\n';
const B_CALLS_C = 'import { c } from "./c";\nexport function b(n: number): number { return c(n); }\n';
const C_CALLS_A = 'import { a } from "./a";\nexport function c(n: number): number { return a(n); }\n';
// Unrelated files keep a one-file change under the incremental rebuild threshold.
const FILLERS = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`filler${i}.ts`, `export function filler${i}() { return ${i}; }\n`]),
);
const FULL_CYCLE = { "a->b": true, "b->c": true, "c->a": true };

// Cold indexing with the WASM parsers is slow on the Windows runner.
describe.skipIf(!wasmBuilt)("call graph cycle flags (#239)", { timeout: 30_000 }, () => {
  let tmpDir: string;
  let runtime: CliRuntime;
  let fileA: string;

  /** Cyclic flag of every CALLS relation reachable from b, keyed "source->target". */
  const cycleFlags = async (): Promise<Record<string, boolean>> => {
    const filePath = normalizePath(path.join(tmpDir, "src/b.ts"));
    const result = await executeQueryCallGraph({ filePath, symbolName: "b", direction: "both", depth: 3 });
    return Object.fromEntries(
      [...result.callers, ...result.callees].map((r) => [`${r.sourceName}->${r.targetName}`, r.isCyclic]),
    );
  };

  beforeEach(async () => {
    ({ tmpDir, runtime } = await indexWorkspace("callgraph-cycles-", {
      "a.ts": A_CALLS_B,
      "b.ts": B_CALLS_C,
      "c.ts": C_CALLS_A,
      ...FILLERS,
    }));
    fileA = normalizePath(path.join(tmpDir, "src/a.ts"));
  });

  afterEach(async () => {
    await runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags a call cycle that spans files on a cold build", async () => {
    expect(await cycleFlags()).toEqual(FULL_CYCLE);
  });

  it("clears the flags of files left alone by an incremental refresh, and sets them again", async () => {
    await cycleFlags();

    rewriteKeepingMtime(fileA, A_ALONE);
    executeInvalidateFiles({ filePaths: [fileA] });
    // b.ts is not re-extracted: its b->c edge must still lose the flag.
    expect(await cycleFlags()).toEqual({ "b->c": false, "c->a": false });

    rewriteKeepingMtime(fileA, A_CALLS_B);
    executeInvalidateFiles({ filePaths: [fileA] });
    expect(await cycleFlags()).toEqual(FULL_CYCLE);
  });
});
