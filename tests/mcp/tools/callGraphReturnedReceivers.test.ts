/**
 * query_call_graph links a method called on a returned value (an annotated return, a fluent `this`/`Self`, an
 * identity generic, and their chains) to the method of the proven class, never to a same-named method of another
 * class (#623). Java, C#, Go and Rust are probed: their chains are not typed yet (see the last test).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CliRuntime } from "@/cli/runtime";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { executeInvalidateFiles } from "@/mcp/tools/workspace";
import { normalizePath } from "@/shared/path";
import { indexWorkspace, rewriteKeepingMtime, wasmBuilt } from "./callGraphWorkspace";

const TS_FACTORY = (type: string) => `import { Calculator, OtherCalculator } from './service';
export function make(): ${type} { return new ${type}(); }
export function identity<T>(value: T): T { return value; }
`;

const FIXTURES: Record<string, string> = {
  "ts/service.ts": `export class Calculator { compute(x: number): number { return x * 2; } }
export class OtherCalculator { compute(x: number): number { return x * 3; } }
export class Builder { setX(x: number): this { return this; } build(): Calculator { return new Calculator(); } }
`,
  "ts/factory.ts": TS_FACTORY("Calculator"),
  "ts/use.ts": `import { Builder, Calculator } from './service';
import { identity, make } from './factory';
export function returned() { return make().compute(1); }
export function generic(c: Calculator) { return identity(c).compute(2); }
export function fluent(b: Builder) { return b.setX(1).build().compute(3); }
`,
  "py/service.py": `from typing import Self

class Calculator:
    def compute(self, x: int) -> int:
        return x * 2

class OtherCalculator:
    def compute(self, x: int) -> int:
        return x * 3

class Builder:
    def set_x(self, x: int) -> Self:
        return self

    def build(self) -> Calculator:
        return Calculator()
`,
  "py/factory.py": `from typing import TypeVar
from service import Calculator
T = TypeVar("T")

def make() -> Calculator:
    return Calculator()

def identity(value: T) -> T:
    return value
`,
  "py/use.py": `from service import Builder, Calculator
from factory import identity, make

def returned():
    return make().compute(1)

def generic(c: Calculator):
    return identity(c).compute(2)

def fluent(b: Builder):
    return b.set_x(1).build().compute(3)
`,
  "java/Calculator.java": "class Calculator { int compute(int x) { return x * 2; } }\n",
  "java/OtherCalculator.java": "class OtherCalculator { int compute(int x) { return x * 3; } }\n",
  "java/Factory.java": "class Factory { static Calculator make() { return new Calculator(); } }\n",
  "java/Use.java": "class Use { int returned() { return Factory.make().compute(1); } }\n",
  "cs/Calculator.cs": "class Calculator { public int Compute(int x) { return x * 2; } }\n",
  "cs/OtherCalculator.cs": "class OtherCalculator { public int Compute(int x) { return x * 3; } }\n",
  "cs/Factory.cs": "static class Factory { public static Calculator Make() { return new Calculator(); } }\n",
  "cs/Use.cs": "class Use { int Returned() { return Factory.Make().Compute(1); } }\n",
  "go/service.go": "package p\n\ntype Calculator struct{}\ntype OtherCalculator struct{}\n\nfunc (Calculator) Compute(x int) int { return x * 2 }\nfunc (OtherCalculator) Compute(x int) int { return x * 3 }\nfunc Make() *Calculator { return &Calculator{} }\n",
  "go/use.go": "package p\n\nfunc Returned() int { return Make().Compute(1) }\n",
  "rs/service.rs": "pub struct Calculator;\npub struct OtherCalculator;\nimpl Calculator { pub fn compute(&self, x: i32) -> i32 { x * 2 } }\nimpl OtherCalculator { pub fn compute(&self, x: i32) -> i32 { x * 3 } }\npub fn make() -> Calculator { Calculator }\n",
  "rs/use.rs": "use crate::service::make;\npub fn returned() -> i32 { make().compute(1) }\n",
};

// [caller file, caller, file declaring both classes, method, Calculator's method line, OtherCalculator's (0-based)].
const CASES: [string, string, string, string, number, number][] = [
  ["ts/use.ts", "returned", "ts/service.ts", "compute", 0, 1],
  ["ts/use.ts", "generic", "ts/service.ts", "compute", 0, 1],
  ["ts/use.ts", "fluent", "ts/service.ts", "compute", 0, 1],
  ["py/use.py", "returned", "py/service.py", "compute", 3, 7],
  ["py/use.py", "generic", "py/service.py", "compute", 3, 7],
  ["py/use.py", "fluent", "py/service.py", "compute", 3, 7],
];

// Cold indexing with the WASM parsers is slow on the Windows runner.
describe.skipIf(!wasmBuilt)("query_call_graph on a returned value (#623)", { timeout: 60_000 }, () => {
  let tmpDir: string;
  let runtime: CliRuntime;
  beforeAll(async () => { ({ tmpDir, runtime } = await indexWorkspace("callgraph-returned-", FIXTURES)); }, 120_000);
  afterAll(async () => {
    await runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const file = (name: string) => normalizePath(path.join(tmpDir, "src", name));
  const calleesOf = async (caller: string, symbol: string, method: string) =>
    (await executeQueryCallGraph({ filePath: file(caller), symbolName: symbol, direction: "callees", depth: 1, relationTypes: ["CALLS"] }))
      .callees.filter(r => r.targetName === method).map(r => r.targetId);

  it.each(CASES)("%s %s: the call reaches Calculator's method, never OtherCalculator's", async (caller, symbol, declaring, method, ownLine) => {
    expect(await calleesOf(caller, symbol, method)).toEqual([`${file(declaring)}:${method}:${ownLine}`]);
  });

  // Gaps: their stubs carry no return type, so a chain is not typed there.
  it("Java and Go keep the by-name match of a method called on a returned value; C# and Rust link nowhere", async () => {
    expect(await calleesOf("java/Use.java", "returned", "compute")).toHaveLength(1);
    expect(await calleesOf("cs/Use.cs", "Returned", "Compute")).toEqual([]);
    expect(await calleesOf("go/use.go", "Returned", "Compute")).toHaveLength(1);
    expect(await calleesOf("rs/use.rs", "returned", "compute")).toEqual([]);
  });

  // Runs last: it changes the return annotation of `make`.
  it("re-links the caller after an incremental refresh of the callee's file", async () => {
    const factory = file("ts/factory.ts");
    rewriteKeepingMtime(factory, TS_FACTORY("OtherCalculator"));
    executeInvalidateFiles({ filePaths: [factory] });
    expect(await calleesOf("ts/use.ts", "returned", "compute")).toEqual([`${file("ts/service.ts")}:compute:1`]);
    expect(await calleesOf("ts/use.ts", "generic", "compute")).toEqual([`${file("ts/service.ts")}:compute:0`]);
  });
});
