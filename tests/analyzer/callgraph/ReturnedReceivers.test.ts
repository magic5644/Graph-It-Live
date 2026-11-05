import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createTreeSitterHarness } from "./treeSitterHarness";

type Harness = Awaited<ReturnType<typeof createTreeSitterHarness>>;

/** Method CALLS edges of an index of `files`, as `file#caller -> file#method:line` (0-based line tells homonyms apart). */
async function methodCalls(harness: Harness, files: Record<string, string>, methods = /^(compute|build|setX|set_x)$/) {
  const indexer = await harness.newIndexer();
  try {
    await harness.indexInto(indexer, files);
    const { nodes, edges } = indexer.getIndexSnapshot();
    const byId = new Map(nodes.map(node => [node.id, node]));
    const rel = (file: string) => path.relative(harness.root, file).replaceAll("\\", "/");
    return edges.filter(edge => edge.typeRelation === "CALLS" && methods.test(byId.get(edge.targetId)?.name ?? "")).map((edge) => {
      const [source, target] = [byId.get(edge.sourceId), byId.get(edge.targetId)];
      return `${rel(source?.path ?? "")}#${source?.name} -> ${rel(target?.path ?? "")}#${target?.name}:${target?.startLine}`;
    }).sort();
  } finally {
    indexer.dispose();
  }
}

const SERVICE_TS = `export class Calculator { compute(x: number): number { return x * 2; } }
export class OtherCalculator { compute(x: number): number { return x * 3; } }
export class Builder { setX(x: number): this { return this; } build(): Calculator { return new Calculator(); } }
`;

describe("method calls on returned values (#623)", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-returned-");
  });
  afterAll(() => harness.dispose());

  it("TS: annotated return, identity generic and fluent chain reach Calculator.compute (issue repro)", async () => {
    const calls = await methodCalls(harness, {
      "src/service.ts": SERVICE_TS,
      "src/factory.ts": `import { Calculator } from './service';
export function make(): Calculator { return new Calculator(); }
export function identity<T>(value: T): T { return value; }
`,
      "src/use.ts": `import { Builder, Calculator } from './service';
import { identity, make } from './factory';
export function returned() { return make().compute(1); }
export function generic(c: Calculator) { return identity(c).compute(2); }
export function fluent(b: Builder) { return b.setX(1).build().compute(3); }
`,
    });
    expect(calls).toEqual([
      "src/use.ts#fluent -> src/service.ts#build:2",
      "src/use.ts#fluent -> src/service.ts#compute:0",
      "src/use.ts#fluent -> src/service.ts#setX:2",
      "src/use.ts#generic -> src/service.ts#compute:0",
      "src/use.ts#returned -> src/service.ts#compute:0",
    ]);
  });

  const FACTORY = (body: string) => ({ "src/service.ts": SERVICE_TS, "src/factory.ts": `import { Calculator, OtherCalculator, Builder } from './service';\n${body}` });

  it.each([
    ["an arrow function value", "export const make = (): Calculator => new Calculator();", "make().compute(1)"],
    ["a static method", "export class Shop { static open(): Calculator { return new Calculator(); } }", "Shop.open().compute(1)"],
    ["overloads that agree", "export function make(a: string): Calculator;\nexport function make(a: number): Calculator;\nexport function make(a: any): any { return new Calculator(); }", "make(1).compute(1)"],
    ["an identity on a construction", "export function identity<T>(value: T): T { return value; }", "identity(new Calculator()).compute(1)"],
    ["an identity on a returned value", "export function identity<T>(value: T): T { return value; }\nexport function make(): Calculator { return new Calculator(); }", "identity(make()).compute(1)"],
    ["a fluent method on a returned value", "export function builder(): Builder { return new Builder(); }", "builder().setX(1).build().compute(1)"],
    ["a default export", "export default function make(): Calculator { return new Calculator(); }", "make().compute(1)", "import make from './factory';"],
    ["an aliased import", "export function make(): Calculator { return new Calculator(); }", "build().compute(1)", "import { make as build } from './factory';"],
    ["a namespace import", "export function make(): Calculator { return new Calculator(); }", "f.make().compute(1)", "import * as f from './factory';"],
  ])("TS: %s reaches Calculator.compute", async (_label, factory, call, imports = "import { make, identity, builder, Shop } from './factory';\nimport { Calculator } from './service';") => {
    const calls = await methodCalls(harness, {
      ...FACTORY(factory),
      "src/use.ts": `${imports}\nexport function run() { return ${call}; }\n`,
    }, /^compute$/);
    expect(calls).toEqual(["src/use.ts#run -> src/service.ts#compute:0"]);
  });

  it.each([
    ["an unannotated return", "export function make() { return new Calculator(); }"],
    ["a union", "export function make(): Calculator | OtherCalculator { return new Calculator(); }"],
    ["a nullable union", "export function make(): Calculator | null { return new Calculator(); }"],
    ["a Promise", "export async function make(): Promise<Calculator> { return new Calculator(); }"],
    ["Awaited", "export function make(): Awaited<Calculator> { return new Calculator(); }"],
    ["a utility type", "export function make(): Partial<Calculator> { return new Calculator(); }"],
    ["ReturnType", "export function make(): ReturnType<typeof other> { return new Calculator(); }\nfunction other(): Calculator { return new Calculator(); }"],
    ["another generic", "export function make<T>(values: T[]): T { return values[0]; }"],
    ["a generic not bound by an argument", "export function make<T>(): T { return null as T; }"],
    ["overloads that disagree", "export function make(a: string): Calculator;\nexport function make(a: number): OtherCalculator;\nexport function make(a: any): any { return new Calculator(); }"],
    ["any", "export function make(): any { return new Calculator(); }"],
    ["unknown", "export function make(): unknown { return new Calculator(); }"],
    ["an interface", "export interface Computes { compute(x: number): number }\nexport function make(): Computes { return new Calculator(); }"],
    ["a qualified type", "import * as s from './service';\nexport function make(): s.Calculator { return new Calculator(); }"],
    ["a type declared nowhere", "export function make(): Missing { return new Calculator(); }"],
  ])("TS: %s creates no method edge", async (_label, factory) => {
    const calls = await methodCalls(harness, {
      ...FACTORY(factory),
      "src/use.ts": "import { make } from './factory';\nexport function run() { return make([]).compute(1); }\n",
    }, /^compute$/);
    expect(calls).toEqual([]);
  });

  it("TS: the return type is named in the callee's file, whatever the caller imports under that name", async () => {
    const calls = await methodCalls(harness, {
      "src/service.ts": SERVICE_TS,
      "src/other.ts": "export class Calculator { compute(x: number): number { return x; } }\n",
      "src/factory.ts": "import { Calculator } from './service';\nexport function make(): Calculator { return new Calculator(); }\n",
      "src/use.ts": "import { Calculator } from './other';\nimport { make } from './factory';\nexport function run(c: Calculator) { c.compute(0); return make().compute(1); }\n",
    }, /^compute$/);
    expect(calls).toEqual(["src/use.ts#run -> src/other.ts#compute:0", "src/use.ts#run -> src/service.ts#compute:0"]);
  });

  it("TS: barrels are followed for the callee and for its return type", async () => {
    const calls = await methodCalls(harness, {
      "src/service.ts": SERVICE_TS,
      "src/models/index.ts": "export * from '../service';\n",
      "src/factory.ts": "import { Calculator } from './models';\nexport function make(): Calculator { return new Calculator(); }\n",
      "src/index.ts": "export { make as create } from './factory';\n",
      "src/use.ts": "import { create } from './index';\nexport function run() { return create().compute(1); }\n",
    }, /^compute$/);
    expect(calls).toEqual(["src/use.ts#run -> src/service.ts#compute:0"]);
  });

  it("TS: same-file callees, `this` and a fluent `this` chain, never the homonym", async () => {
    const calls = await methodCalls(harness, {
      "src/use.ts": `${SERVICE_TS}function make(): Calculator { return new Calculator(); }
export class Shop {
  calc(): Calculator { return new Calculator(); }
  run(b: Builder) { make().compute(1); this.calc().compute(2); b.setX(1).setX(2).build().compute(3); }
}
`,
    });
    expect(calls).toEqual([
      "src/use.ts#run -> src/use.ts#build:2",
      "src/use.ts#run -> src/use.ts#compute:0",
      "src/use.ts#run -> src/use.ts#setX:2",
    ]);
  });

  it("TS: a callee shadowed by a parameter or a local, or a call on an unknown receiver, creates no method edge", async () => {
    const calls = await methodCalls(harness, {
      ...FACTORY("export function make(): Calculator { return new Calculator(); }"),
      "src/use.ts": `import { make } from './factory';
export function a(make: () => unknown) { return make().compute(1); }
export function b() { const make = () => null; return make().compute(1); }
export function c(x: any) { return x.make().compute(1); }
export function d() { return Object.create(null).compute(1); }
`,
    }, /^compute$/);
    expect(calls).toEqual([]);
  });

  it("TS: a chain longer than the cap stops there", async () => {
    const links = ".setX(1)".repeat(10);
    const calls = await methodCalls(harness, {
      "src/service.ts": SERVICE_TS,
      "src/use.ts": `import { Builder } from './service';\nexport function run(b: Builder) { return b${links}.build().compute(1); }\n`,
    }, /^(build|compute)$/);
    expect(calls).toEqual([]);
  });

  it("JS: no annotation, no method edge", async () => {
    const calls = await methodCalls(harness, {
      "src/service.js": "export class Calculator { compute(x) { return x; } }\nexport class OtherCalculator { compute(x) { return x; } }\n",
      "src/factory.js": "import { Calculator } from './service.js';\nexport function make() { return new Calculator(); }\n",
      "src/use.js": "import { make } from './factory.js';\nexport function run() { return make().compute(1); }\n",
    }, /^compute$/);
    expect(calls).toEqual([]);
  });

  const SERVICE_PY = `class Calculator:
    def compute(self, x: int) -> int:
        return x * 2

class OtherCalculator:
    def compute(self, x: int) -> int:
        return x * 3

class Builder:
    def set_x(self, x: int) -> Self:
        return self

    def build(self) -> "Calculator":
        return Calculator()
`;
  const PY_FACTORY = (body: string) => ({
    "pkg/__init__.py": "",
    "pkg/service.py": `from typing import Self\n${SERVICE_PY}`,
    "pkg/factory.py": `from typing import Any, Optional, TypeVar, overload\nfrom pkg.service import Builder, Calculator, OtherCalculator\nT = TypeVar("T")\n${body}`,
  });

  it("Python: annotated return, TypeVar identity and fluent Self chain reach Calculator.compute (issue repro)", async () => {
    const calls = await methodCalls(harness, {
      ...PY_FACTORY("def make() -> Calculator:\n    return Calculator()\n\ndef identity(value: T) -> T:\n    return value\n"),
      "pkg/use.py": `from pkg.service import Builder, Calculator
from pkg.factory import identity, make

def returned():
    return make().compute(1)

def generic(c: Calculator):
    return identity(c).compute(2)

def fluent(b: Builder):
    return b.set_x(1).build().compute(3)

def constructed():
    return Builder().set_x(1).build().compute(4)
`,
    });
    expect(calls).toEqual([
      "pkg/use.py#constructed -> pkg/service.py#build:13",
      "pkg/use.py#constructed -> pkg/service.py#compute:2",
      "pkg/use.py#constructed -> pkg/service.py#set_x:10",
      "pkg/use.py#fluent -> pkg/service.py#build:13",
      "pkg/use.py#fluent -> pkg/service.py#compute:2",
      "pkg/use.py#fluent -> pkg/service.py#set_x:10",
      "pkg/use.py#generic -> pkg/service.py#compute:2",
      "pkg/use.py#returned -> pkg/service.py#compute:2",
    ]);
  });

  it.each([
    ["a PEP 695 identity", "def make[U](value: U) -> U:\n    return value\n", "make(Calculator()).compute(1)"],
    ["a forward reference", "def make() -> 'Calculator':\n    return Calculator()\n", "make().compute(1)"],
    ["a static method identity", "class Shop:\n    @staticmethod\n    def keep(value: T) -> T:\n        return value\n", "Shop.keep(Calculator()).compute(1)"],
    ["a class method", "class Shop:\n    @classmethod\n    def open(cls) -> Calculator:\n        return Calculator()\n", "Shop.open().compute(1)"],
    ["overloads that agree", "@overload\ndef make(a: int) -> Calculator: ...\n@overload\ndef make(a: str) -> Calculator: ...\ndef make(a):\n    return Calculator()\n", "make(1).compute(1)"],
    ["a module import", "def make() -> Calculator:\n    return Calculator()\n", "factory.make().compute(1)", "from pkg import factory"],
    ["an aliased import", "def make() -> Calculator:\n    return Calculator()\n", "build().compute(1)", "from pkg.factory import make as build"],
    ["a re-exporting package", "def make() -> Calculator:\n    return Calculator()\n", "make().compute(1)", "from pkg.api import make"],
  ])("Python: %s reaches Calculator.compute", async (_label, factory, call, imports = "from pkg.factory import make, Shop\nfrom pkg.service import Calculator") => {
    const calls = await methodCalls(harness, {
      ...PY_FACTORY(factory),
      "pkg/api.py": "from pkg.factory import make\n",
      "pkg/use.py": `${imports}\n\ndef run():\n    return ${call}\n`,
    }, /^compute$/);
    expect(calls).toEqual(["pkg/use.py#run -> pkg/service.py#compute:2"]);
  });

  it.each([
    ["an unannotated return", "def make():\n    return Calculator()\n"],
    ["Optional", "def make() -> Optional[Calculator]:\n    return Calculator()\n"],
    ["a union", "def make() -> Calculator | None:\n    return Calculator()\n"],
    ["Any", "def make() -> Any:\n    return Calculator()\n"],
    ["another generic", "def make(values: list[T]) -> T:\n    return values[0]\n"],
    ["overloads that disagree", "@overload\ndef make(a: int) -> Calculator: ...\n@overload\ndef make(a: str) -> OtherCalculator: ...\ndef make(a):\n    return Calculator()\n"],
    ["a qualified type", "import pkg.service\ndef make() -> pkg.service.Calculator:\n    return Calculator()\n"],
    ["a coroutine", "async def make() -> Calculator:\n    return Calculator()\n"],
  ])("Python: %s creates no method edge", async (_label, factory) => {
    const calls = await methodCalls(harness, {
      ...PY_FACTORY(factory),
      "pkg/use.py": "from pkg.factory import make\n\ndef run():\n    return make([]).compute(1)\n",
    }, /^compute$/);
    expect(calls).toEqual([]);
  });

  it("Python: the return type is named in the callee's file, a TYPE_CHECKING import included; self chains stay in the class", async () => {
    const calls = await methodCalls(harness, {
      "pkg/__init__.py": "",
      "pkg/service.py": `from typing import Self\n${SERVICE_PY}`,
      "pkg/other.py": "class Calculator:\n    def compute(self, x: int) -> int:\n        return x\n",
      "pkg/factory.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from pkg.service import Calculator\n\ndef make() -> Calculator:\n    return None\n",
      "pkg/use.py": `from pkg.other import Calculator
from pkg.factory import make

class Shop:
    def calc(self) -> Calculator:
        return Calculator()

    def run(self):
        make().compute(1)
        self.calc().compute(2)
`,
    }, /^compute$/);
    expect(calls).toEqual(["pkg/use.py#run -> pkg/other.py#compute:1", "pkg/use.py#run -> pkg/service.py#compute:2"]);
  });

  it("Python: an import cycle between re-exporting modules ends with no edge", async () => {
    const calls = await methodCalls(harness, {
      ...PY_FACTORY(""),
      "pkg/a.py": "from pkg.b import make\n",
      "pkg/b.py": "from pkg.a import make\n",
      "pkg/use.py": "from pkg.a import make\n\ndef run():\n    return make().compute(1)\n",
    }, /^compute$/);
    expect(calls).toEqual([]);
  });
});
