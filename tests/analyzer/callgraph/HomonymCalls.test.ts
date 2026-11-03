/**
 * A call reaches the same-file method of its receiver's type, never the first same-named method (#505).
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileExtToLang } from "@/analyzer/callgraph/GraphExtractor";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness } from "./treeSitterHarness";

type Harness = Awaited<ReturnType<typeof createTreeSitterHarness>>;

describe("calls to same-named methods (#505)", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await createTreeSitterHarness("gil-homonyms-"); });
  afterAll(() => harness.dispose());

  /** CALLS of `source` (as file `name`) as "caller -> callee:line", 0-based lines, external stubs as is. */
  async function calls(name: string, source: string): Promise<string[]> {
    const file = normalizePath(path.join(harness.root, name));
    const lang = fileExtToLang(file);
    if (!lang) throw new Error(`No call graph language for ${name}`);
    const { edges } = await harness.extractor.extractSource(file, lang, source);
    const label = (id: string) => id.startsWith("@@") ? id : id.slice(file.length + 1);
    return edges.filter(e => e.typeRelation === "CALLS")
      .map(e => `${label(e.sourceId)} -> ${label(e.targetId)}`).sort();
  }

  // [title, file, source, expected CALLS]
  const cases: [string, string, string, string[]][] = [
    ["TS: new X().m() reaches X's method", "a.ts",
      "export class A { compute(x: number) { return x; } }\nexport class B { compute(x: number) { return x * 3; } }\nexport function run() { return new B().compute(1); }\n",
      ["run:2 -> B:1", "run:2 -> compute:1"]],
    ["TS: a typed parameter, an initialised const, this and a static call", "a.ts",
      "class A { compute() { return 1; } static make() { return 0; } }\nclass B {\n  compute() { return 2; }\n  static make() { return 0; }\n  self() { return this.compute(); }\n}\n" +
      "function run(a: A) { const b = new B(); const c: A = a; return a.compute() + b.compute() + c.compute() + B.make() + (new A()).compute(); }\n",
      ["run:6 -> A:0", "run:6 -> B:1", "run:6 -> compute:0", "run:6 -> compute:2", "run:6 -> make:3", "self:4 -> compute:2"]],
    ["TS: no edge when the receiver type is unknown or not of this file", "a.ts",
      "class A { compute() { return 1; } }\nclass B { compute() { return 2; } }\nfunction run(x: Other, y) { return x.compute() + y.compute() + make().compute() + this.b.compute() + this.compute(); }\n",
      ["run:2 -> @@external:make"]],
    ["TS: a single definition keeps its by-name edge", "a.ts",
      "class A { compute() { return 1; } }\nfunction run(x) { return x.compute(); }\n",
      ["run:1 -> compute:0"]],
    ["TS: a bare call reaches the function, not a same-named method", "a.ts",
      "class A { run() { return 1; } }\nfunction run() { return 2; }\nfunction main() { return run(); }\n",
      ["main:2 -> run:1"]],
    ["TS: a bare call with only method homonyms links nowhere", "a.ts",
      "class A { run() { return 1; } }\nclass B { run() { return 2; } }\nfunction main() { return run(); }\n",
      []],
    ["TSX: new X().m() in a .tsx file", "a.tsx",
      "class A { compute() { return 1; } }\nclass B { compute() { return 2; } }\nexport function run() { return new B().compute(); }\n",
      ["run:2 -> B:1", "run:2 -> compute:1"]],
    ["JS: this and a constructed receiver", "a.js",
      "class A { compute() { return 1; } go() { return this.compute(); } }\nclass B { compute() { return 2; } }\nfunction run() { const b = new B(); return b.compute(); }\n",
      ["go:0 -> compute:0", "run:2 -> B:1", "run:2 -> compute:1"]],
    ["Python: self, a constructed receiver, an annotated parameter and a class call", "a.py",
      "class A:\n    def compute(self):\n        return 1\n    def go(self):\n        return self.compute()\n\nclass B:\n    def compute(self):\n        return 2\n\n" +
      "def run(a: A):\n    b = B()\n    return b.compute() + a.compute() + B().compute()\n",
      ["go:3 -> compute:1", "run:10 -> B:6", "run:10 -> compute:1", "run:10 -> compute:7"]],
    ["Python: no edge for an unknown receiver", "a.py",
      "class A:\n    def compute(self):\n        return 1\n\nclass B:\n    def compute(self):\n        return 2\n\ndef run(x):\n    return x.compute()\n",
      []],
    ["Java: this, implicit this, new X() and typed variables (var included)", "A.java",
      "class A { int compute() { return 1; } int go() { return this.compute() + compute(); } }\n" +
      "class B { int compute() { return 2; } int run(A a) { var b = new B(); A c = a; return b.compute() + c.compute() + new A().compute(); } }\n",
      ["go:0 -> compute:0", "run:1 -> compute:0", "run:1 -> compute:1"]],
    ["Java: no edge for an unknown receiver", "A.java",
      "class A { int compute() { return 1; } }\nclass B { int compute() { return 2; } int run(Other o) { return o.compute(); } }\n",
      []],
    ["C#: this, implicit this, new X() and typed variables (var included)", "A.cs",
      "class A { int Compute() { return 1; } int Go() { return this.Compute() + Compute(); } }\n" +
      "class B { int Compute() { return 2; } int Run(A a) { var b = new B(); A c = a; return b.Compute() + c.Compute() + new A().Compute(); } }\n",
      ["Go:0 -> Compute:0", "Run:1 -> Compute:0", "Run:1 -> Compute:1"]],
    ["C#: no edge for an unknown receiver", "A.cs",
      "class A { int Compute() { return 1; } }\nclass B { int Compute() { return 2; } int Run(Other o) { return o.Compute(); } }\n",
      []],
    ["Go: method receiver, composite literal, pointer and var", "a.go",
      "package p\n\ntype A struct{}\ntype B struct{}\n\nfunc (a A) Compute() int { return 1 }\nfunc (b *B) Compute() int { return 2 }\n" +
      "func (a A) Go() int { return a.Compute() }\nfunc Run() int { b := &B{}; c := A{}; var d B; return b.Compute() + c.Compute() + d.Compute() }\n",
      ["Go:7 -> Compute:5", "Run:8 -> Compute:5", "Run:8 -> Compute:6"]],
    ["Go: no edge for an unknown receiver", "a.go",
      "package p\n\ntype A struct{}\ntype B struct{}\n\nfunc (A) Compute() int { return 1 }\nfunc (B) Compute() int { return 2 }\nfunc Run(x X) int { return x.Compute() }\n",
      []],
    ["Rust: self, Self:: and a struct literal", "a.rs",
      "struct A;\nstruct B;\nimpl A { fn compute(&self) -> i32 { 1 } fn go(&self) -> i32 { self.compute() + Self::compute(self) } }\n" +
      "impl B { fn compute(&self) -> i32 { 2 } }\nfn run() -> i32 { let b = B {}; b.compute() + (B {}).compute() }\n",
      ["go:2 -> compute:2", "run:4 -> compute:3"]],
    ["Rust: no edge for an unknown receiver", "a.rs",
      "struct A;\nstruct B;\nimpl A { fn compute(&self) -> i32 { 1 } }\nimpl B { fn compute(&self) -> i32 { 2 } }\nfn run(x: i32) -> i32 { let y = make(); y.compute() }\n",
      ["run:4 -> @@external:make"]],
  ];

  it.each(cases)("%s", async (_title, name, source, expected) => {
    expect(await calls(name, source)).toEqual(expected);
  });
});
