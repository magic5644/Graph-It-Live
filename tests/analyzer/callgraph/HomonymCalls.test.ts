/**
 * A call reaches the same-file method of its receiver's type, never the first same-named method (#505).
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileExtToLang } from "@/analyzer/callgraph/GraphExtractor";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness, writeFiles } from "./treeSitterHarness";

type Harness = Awaited<ReturnType<typeof createTreeSitterHarness>>;

type Case = [string, string, string, string[]];

/**
 * Review of #505: a binding with no readable type shadows an outer typed one. One case per binding form, each in
 * its own file (the file scope sees every declaration), next to a control case where the outer variable links.
 */
function shadowing(lang: string, file: string, prefix: string, forms: [string, string, string[]][]): Case[] {
  return forms.map(([form, body, expected]) => [`${lang}: ${form}`, file, prefix + body, expected]);
}

const TS_PREFIX = "class A { compute() { return 1; } }\nclass B { compute() { return 2; } }\nlet b: B;\n";
const PY_PREFIX = "class A:\n    def compute(self):\n        return 1\n\nclass B:\n    def compute(self):\n        return 2\n\nb: B = None\n";
const JAVA_PREFIX = "class A { int compute() { return 1; } }\nclass B { int compute() { return 2; } }\n";
const CS_PREFIX = "class A { public int Compute() { return 1; } }\nclass B { public int Compute() { return 2; } }\n";
const GO_PREFIX = "package p\n\ntype A struct{}\ntype B struct{}\n\nfunc (A) Compute() int { return 1 }\nfunc (B) Compute() int { return 2 }\n";
const RS_PREFIX = "struct A;\nstruct B;\nimpl A { fn compute(&self) -> i32 { 1 } }\nimpl B { fn compute(&self) -> i32 { 2 } }\n";

const SHADOWING: Case[] = [
  ...shadowing("TS", "a.ts", TS_PREFIX, [
    ["an outer typed variable links (control)", "function r() { return b.compute(); }\n", ["r:3 -> compute:1"]],
    ["a for-of variable shadows it", "function r(items: A[]) { for (const b of items) b.compute(); }\n", []],
    ["a catch parameter shadows it", "function r() { try { return 0; } catch (b) { b.compute(); } }\n", []],
    ["an arrow parameter shadows it", "function r(items: A[]) { return items.map(b => b.compute()); }\n", []],
    ["an untyped parameter shadows it", "function r(b) { return b.compute(); }\n", []],
  ]),
  ...shadowing("Python", "a.py", PY_PREFIX, [
    ["an outer typed variable links (control)", "def r():\n    return b.compute()\n", ["r:9 -> compute:5"]],
    ["a for variable shadows it", "def r(items):\n    for b in items:\n        b.compute()\n", []],
    ["a comprehension variable shadows it", "def r(items):\n    return [b.compute() for b in items]\n", []],
    ["an untyped parameter shadows it", "def r(b):\n    return b.compute()\n", []],
    ["a lambda parameter shadows it", "def r():\n    return lambda b: b.compute()\n", []],
  ]),
  ...shadowing("Java", "A.java", JAVA_PREFIX, [
    ["a field links (control)", "class C { B b = new B(); int r() { return b.compute(); } }\n", ["r:2 -> compute:1"]],
    ["a foreach variable shadows it", "class C { B b = new B(); void r(java.util.List<A> items) { for (var b : items) b.compute(); } }\n", []],
    ["a lambda parameter shadows it", "class C { B b = new B(); void r(java.util.List<A> items) { items.forEach(b -> b.compute()); } }\n",
      ["r:2 -> @@external:forEach"]],
    ["a catch parameter shadows it", "class C { B b = new B(); void r() { try { } catch (RuntimeException b) { b.compute(); } } }\n", []],
  ]),
  ...shadowing("C#", "A.cs", CS_PREFIX, [
    ["a field links (control)", "class C { B b = new B(); int R() { return b.Compute(); } }\n", ["R:2 -> Compute:1"]],
    ["a foreach variable shadows it", "class C { B b = new B(); void R(System.Collections.Generic.List<A> items) { foreach (var b in items) b.Compute(); } }\n", []],
    ["a lambda parameter shadows it", "class C { B b = new B(); void R(System.Collections.Generic.List<A> items) { items.ForEach(b => b.Compute()); } }\n", []],
    ["a catch variable shadows it", "class C { B b = new B(); void R() { try { } catch (System.Exception b) { b.Compute(); } } }\n", []],
  ]),
  ...shadowing("Go", "a.go", GO_PREFIX, [
    ["an outer variable links in a closure (control)", "func R() { b := B{}; _ = func() int { return b.Compute() } }\n", ["R:7 -> Compute:6"]],
    ["a range variable shadows it", "func R(items []A) { b := B{}; _ = func() { for _, b := range items { b.Compute() } } }\n", []],
  ]),
  ...shadowing("Rust", "a.rs", RS_PREFIX, [
    ["an outer let links in a closure (control)", "fn r() { let b = B {}; let f = || b.compute(); }\n", ["r:4 -> compute:3"]],
    ["a closure parameter shadows it", "fn r() { let b = B {}; let f = |b| b.compute(); }\n", []],
    ["a for variable shadows it", "fn r(items: Vec<A>) { let b = B {}; let f = || { for b in items { b.compute(); } }; }\n", []],
  ]),
];

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
  const cases: Case[] = [
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
    ["Go: a range variable shadows the receiver; methods share a receiver name across types", "a.go",
      "package p\n\ntype A struct{}\ntype B struct{}\n\nfunc (s *A) Compute() int { return 1 }\nfunc (s *B) Compute() int { return 2 }\n" +
      "func (s *A) Go() int { return s.Compute() }\nfunc (s *B) Go2(items []A) int { for _, s := range items { s.Compute() }; return s.Compute() }\n",
      ["Go:7 -> Compute:5"]],
    ["TS: this in an object literal or a nested function is not the class", "a.ts",
      "class A { compute() { return 1; } }\nclass B {\n  compute() { return 2; }\n  go() { const o = { f() { return this.compute(); } }; return function () { return this.compute(); }; }\n}\n",
      []],
    ["TS: this in an abstract class and in an arrow inside a method", "a.ts",
      "abstract class A { compute() { return 1; } go() { return [1].map(() => this.compute()); } }\nclass B { compute() { return 2; } }\n",
      ["go:0 -> compute:0"]],
    ["TS: this in an object property value or an arrow property is still the class", "a.ts",
      "class A { compute() { return 1; } m() { return { k: this.compute(), f: () => this.compute() }; } }\nclass B { compute() { return 2; } }\n",
      ["m:0 -> compute:0"]],
    ["TS: super.m() links nowhere (inherited methods are not followed)", "a.ts",
      "class A { compute() { return 1; } }\nclass B extends A { compute() { return super.compute(); } }\n",
      []],
    ["Python: a decorated method and a nested function", "a.py",
      "class A:\n    @staticmethod\n    def compute():\n        return 1\n\nclass B:\n    def compute(self):\n        x = 0\n        def compute():\n            return x\n        return compute() + self.compute()\n",
      ["compute:6 -> compute:6", "compute:6 -> compute:8"]],
    ["Rust: a trait default method calling self.m() links nowhere when several impls define it", "a.rs",
      "struct A;\nstruct B;\ntrait T { fn compute(&self) -> i32; fn go(&self) -> i32 { self.compute() } }\n" +
      "impl T for A { fn compute(&self) -> i32 { 1 } }\nimpl T for B { fn compute(&self) -> i32 { 2 } }\n",
      []],
  ];

  it("keeps the import binding of an imported call", async () => {
    await writeFiles(harness.root, { "m.ts": "export function compute() { return 0; }\n" });
    expect(await calls("imp.ts", "import { compute } from './m';\nclass A { compute() { return 1; } }\nclass B { compute() { return 2; } }\n" +
      "export function run() { return compute(); }\n")).toEqual([`run:3 -> @@import:${JSON.stringify([normalizePath(path.join(harness.root, "m.ts")), "compute"])}`]);
  });

  // Review of #505: the caller of a call is its enclosing declaration, not one starting where the file or a block does.
  it.each([
    ["a top-level call in TS is no call of the class starting the file", "top.ts",
      "class A { compute() { return 1; } }\nconst a = new A();\n", []],
    ["a call after a nested def in Python belongs to the enclosing method", "nested.py",
      "class A:\n    def run(self):\n        def helper():\n            return 0\n        return helper()\n", ["run:1 -> helper:2"]],
  ])("%s", async (_title, name, source, expected) => {
    expect(await calls(name, source)).toEqual(expected);
  });

  it("leaves INHERITS edges alone", async () => {
    const file = normalizePath(path.join(harness.root, "inherit.ts"));
    const { edges } = await harness.extractor.extractSource(file, "typescript",
      "class A { compute() { return 1; } }\nclass B extends A { compute() { return super.compute(); } }\n");
    expect(edges.filter(e => e.typeRelation === "INHERITS").map(e => e.targetId)).toEqual([`${file}:A:0`]);
  });

  it.each([...cases, ...SHADOWING])("%s", async (_title, name, source, expected) => {
    expect(await calls(name, source)).toEqual(expected);
  });
});
