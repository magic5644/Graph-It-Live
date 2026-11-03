/**
 * query_call_graph links a call to the method of its receiver's type when two classes of one file
 * declare a same-named method, in every call graph language (#505).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliRuntime } from "@/cli/runtime";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { normalizePath } from "@/shared/path";
import { indexWorkspace, wasmBuilt } from "./callGraphWorkspace";

// Per language: classes A and B declare a same-named method; `run` calls B's on a constructed or typed receiver.
const FIXTURES: Record<string, string> = {
  "service.ts": "// two classes\nexport class A { compute(x: number) { return x; } }\nexport class B { compute(x: number) { return x * 3; } }\nexport function run() { return new B().compute(1); }\n",
  "view.tsx": "// two classes\nexport class A { compute(x: number) { return x; } }\nexport class B { compute(x: number) { return x * 3; } }\nexport function run() { const b: B = new B(); return b.compute(1); }\n",
  "service.js": "// two classes\nexport class A { compute(x) { return x; } }\nexport class B { compute(x) { return x * 3; } }\nexport function run() { const b = new B(); return b.compute(1); }\n",
  "service.py": "class A:\n    def compute(self, x): return x\nclass B:\n    def compute(self, x): return x * 3\n\ndef run():\n    return B().compute(1)\n",
  "Service.java": "// two classes\nclass A { int compute(int x) { return x; } }\nclass B { int compute(int x) { return x * 3; } }\nclass C { int run() { return new B().compute(1); } }\n",
  "Service.cs": "// two classes\nclass A { public int Compute(int x) { return x; } }\nclass B { public int Compute(int x) { return x * 3; } }\nclass C { int Run() { var b = new B(); return b.Compute(1); } }\n",
  "service.go": "package p\ntype A struct{}\ntype B struct{}\nfunc (A) Compute(x int) int { return x }\nfunc (B) Compute(x int) int { return x * 3 }\nfunc Run() int { return B{}.Compute(1) }\n",
  "service.rs": "struct A;\nstruct B;\nimpl A { fn compute(&self, x: i32) -> i32 { x } }\nimpl B { fn compute(&self, x: i32) -> i32 { x * 3 } }\nfn run() -> i32 { B {}.compute(1) }\n",
};

// [file, caller, method, line of A's method, line of B's method] (0-based).
const CASES: [string, string, string, number, number][] = [
  ["service.ts", "run", "compute", 1, 2],
  ["view.tsx", "run", "compute", 1, 2],
  ["service.js", "run", "compute", 1, 2],
  ["service.py", "run", "compute", 1, 3],
  ["Service.java", "run", "compute", 1, 2],
  ["Service.cs", "Run", "Compute", 1, 2],
  ["service.go", "Run", "Compute", 3, 4],
  ["service.rs", "run", "compute", 2, 3],
];

// Cold indexing with the WASM parsers is slow on the Windows runner.
describe.skipIf(!wasmBuilt)("query_call_graph on same-named methods (#505)", { timeout: 30_000 }, () => {
  let tmpDir: string;
  let runtime: CliRuntime;
  beforeAll(async () => { ({ tmpDir, runtime } = await indexWorkspace("callgraph-homonyms-", FIXTURES)); });
  afterAll(async () => {
    await runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(CASES)("%s: the call reaches B's method, never A's", async (file, caller, method, aLine, bLine) => {
    const filePath = normalizePath(path.join(tmpDir, "src", file));
    const callees = await executeQueryCallGraph({ filePath, symbolName: caller, direction: "callees", depth: 1 });
    expect(callees.callees.filter(r => r.targetName === method && r.relation === "CALLS").map(r => r.targetId))
      .toEqual([`${filePath}:${method}:${bLine}`]);
    const callers = await executeQueryCallGraph({ filePath, symbolName: method, startLine: aLine, direction: "callers", depth: 1 });
    expect(callers.callers).toEqual([]);
  });
});
