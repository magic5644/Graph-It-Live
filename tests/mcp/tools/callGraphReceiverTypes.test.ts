/**
 * query_call_graph links a method call on a receiver of proven type to the method of that type declared in
 * another file, never to a same-named method of another class (#499), in every call graph language.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliRuntime } from "@/cli/runtime";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { executeInvalidateFiles } from "@/mcp/tools/workspace";
import { normalizePath } from "@/shared/path";
import { indexWorkspace, rewriteKeepingMtime, wasmBuilt } from "./callGraphWorkspace";

// Per language: `service` declares Calculator and OtherCalculator, both with `compute`; `method` calls it on a
// receiver typed (or constructed) as Calculator, the TS one through an aliased import.
const FIXTURES: Record<string, string> = {
  "ts/service.ts": "export class Calculator { compute(x: number): number { return x * 2; } }\nexport class OtherCalculator { compute(x: number): number { return x * 3; } }\n",
  "ts/method.ts": "import { Calculator as Calc } from './service';\nexport function methodCall(calculator: Calc): number {\n  return calculator.compute(3);\n}\n",
  "py/service.py": "class Calculator:\n    def compute(self, x):\n        return x * 2\n\nclass OtherCalculator:\n    def compute(self, x):\n        return x * 3\n",
  "py/method.py": "from service import Calculator\n\ndef py_method(service: Calculator):\n    return service.compute(3)\n",
  "java/Calculator.java": "class Calculator { int compute(int x) { return x * 2; } }\n",
  "java/OtherCalculator.java": "class OtherCalculator { int compute(int x) { return x * 3; } }\n",
  "java/Method.java": "class Method { int methodCall(Calculator calculator) { return calculator.compute(3); } }\n",
  "cs/Calculator.cs": "class Calculator { public int Compute(int x) { return x * 2; } }\n",
  "cs/OtherCalculator.cs": "class OtherCalculator { public int Compute(int x) { return x * 3; } }\n",
  "cs/Method.cs": "class Method { int MethodCall(Calculator calculator) { return calculator.Compute(3); } }\n",
  "go/service.go": "package p\n\ntype Calculator struct{}\ntype OtherCalculator struct{}\n\nfunc (Calculator) Compute(x int) int { return x * 2 }\nfunc (OtherCalculator) Compute(x int) int { return x * 3 }\n",
  "go/method.go": "package p\n\nfunc MethodCall(calculator *Calculator) int { return calculator.Compute(3) }\n",
  "rs/service.rs": "pub struct Calculator;\npub struct OtherCalculator;\nimpl Calculator { pub fn compute(&self, x: i32) -> i32 { x * 2 } }\nimpl OtherCalculator { pub fn compute(&self, x: i32) -> i32 { x * 3 } }\n",
  "rs/method.rs": "use crate::service::Calculator;\npub fn method_call(calculator: &Calculator) -> i32 { calculator.compute(3) }\n",
};

// [caller file, caller, declaring file of Calculator's method, of OtherCalculator's, method, their 0-based lines].
const CASES: [string, string, string, string, string, number, number][] = [
  ["ts/method.ts", "methodCall", "ts/service.ts", "ts/service.ts", "compute", 0, 1],
  ["py/method.py", "py_method", "py/service.py", "py/service.py", "compute", 1, 5],
  ["java/Method.java", "methodCall", "java/Calculator.java", "java/OtherCalculator.java", "compute", 0, 0],
  ["cs/Method.cs", "MethodCall", "cs/Calculator.cs", "cs/OtherCalculator.cs", "Compute", 0, 0],
  ["go/method.go", "MethodCall", "go/service.go", "go/service.go", "Compute", 5, 6],
  ["rs/method.rs", "method_call", "rs/service.rs", "rs/service.rs", "compute", 2, 3],
];

// Cold indexing with the WASM parsers is slow on the Windows runner.
describe.skipIf(!wasmBuilt)("query_call_graph on a receiver of an imported type (#499)", { timeout: 60_000 }, () => {
  let tmpDir: string;
  let runtime: CliRuntime;
  beforeAll(async () => { ({ tmpDir, runtime } = await indexWorkspace("callgraph-receivers-", FIXTURES)); }, 120_000);
  afterAll(async () => {
    await runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const file = (name: string) => normalizePath(path.join(tmpDir, "src", name));

  it.each(CASES)("%s: the call reaches Calculator's method, never OtherCalculator's", async (caller, symbol, own, other, method, ownLine, otherLine) => {
    const callees = await executeQueryCallGraph({ filePath: file(caller), symbolName: symbol, direction: "callees", depth: 1, relationTypes: ["CALLS"] });
    expect(callees.callees.filter(r => r.targetName === method).map(r => r.targetId)).toEqual([`${file(own)}:${method}:${ownLine}`]);
    const callers = await executeQueryCallGraph({ filePath: file(other), symbolName: method, startLine: otherLine, direction: "callers", depth: 1 });
    expect(callers.callers).toEqual([]);
  });

  // Runs last: it moves Calculator below OtherCalculator, so its method gets a new node id.
  it("follows the class's method after an incremental refresh of the class file", async () => {
    const service = file("ts/service.ts");
    rewriteKeepingMtime(service, "export class OtherCalculator { compute(x: number): number { return x * 3; } }\nexport class Calculator { compute(x: number): number { return x * 2; } }\n");
    executeInvalidateFiles({ filePaths: [service] });
    const callees = await executeQueryCallGraph({ filePath: file("ts/method.ts"), symbolName: "methodCall", direction: "callees", depth: 1, relationTypes: ["CALLS"] });
    expect(callees.callees.filter(r => r.targetName === "compute").map(r => r.targetId)).toEqual([`${service}:compute:1`]);
  });
});
