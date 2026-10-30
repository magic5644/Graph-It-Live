import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { QUALIFIED_PREFIX, qualifiedCandidates, type QualifiedMember } from "@/analyzer/callgraph/qualifiedCalls";
import type { SupportedLang } from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";

const LANG_OF_EXT: Record<string, SupportedLang> = {
  ".go": "go", ".rs": "rust", ".java": "java", ".cs": "csharp", ".py": "python", ".ts": "typescript",
};
const WASMS = ["go", "rust", "java", "c_sharp", "python", "typescript"];
const QUERIES = ["go", "rust", "java", "csharp", "python", "typescript"];
const SQL_WASM = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");

type Files = Record<string, string>;
/** [title, files, expected CALLS as "file#symbol -> file#symbol"]. */
type Case = [string, Files, string[]];

describe("qualified calls (#507)", () => {
  let root: string;
  let run = 0;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-qualified-")));
    const wasm = path.join(root, "dist/wasm");
    const queries = path.join(root, "dist/queries");
    await fs.mkdir(wasm, { recursive: true });
    await fs.mkdir(queries, { recursive: true });
    await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(wasm, "tree-sitter.wasm"));
    for (const name of WASMS) {
      await fs.copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${name}.wasm`, path.join(wasm, `tree-sitter-${name}.wasm`));
    }
    for (const lang of QUERIES) await fs.copyFile(`resources/queries/${lang}.scm`, path.join(queries, `${lang}.scm`));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  /** Write `files` in a fresh workspace (its own root: Go reads go.mod there) and index them in `order`. */
  async function index(files: Files, order = Object.keys(files)) {
    const dir = path.join(root, `case${run++}`);
    for (const [name, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), source);
    }
    const extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: dir });
    const indexer = new CallGraphIndexer(SQL_WASM);
    await indexer.init();
    for (const name of order) {
      const lang = LANG_OF_EXT[path.extname(name)];
      if (!lang) continue;
      const file = normalizePath(path.join(dir, name));
      const result = await extractor.extractSource(file, lang, files[name]);
      indexer.indexFile(result.nodes, result.edges, file, lang, 1);
    }
    indexer.resolveExternalEdges();
    extractor.dispose();
    return { dir, indexer };
  }

  /** Resolved CALLS of `files` as "file#symbol -> file#symbol". */
  async function calls(files: Files, order?: string[], lines = false): Promise<string[]> {
    const { dir, indexer } = await index(files, order);
    const snapshot = indexer.getIndexSnapshot();
    indexer.dispose();
    const label = new Map(snapshot.nodes.map(n => [n.id, `${normalizePath(path.relative(dir, n.path))}#${n.name}`]));
    const line = new Map(snapshot.nodes.map(n => [n.id, `:${n.startLine}`]));
    return snapshot.edges.filter(e => e.typeRelation === "CALLS")
      .map(e => `${label.get(e.sourceId)} -> ${label.get(e.targetId)}${lines ? line.get(e.targetId) : ""}`).sort();
  }

  /** Same result whatever the indexing order: the decoy may be indexed first or last. */
  async function bothOrders(files: Files, lines = false): Promise<string[]> {
    const forward = await calls(files, undefined, lines);
    expect(await calls(files, Object.keys(files).reverse(), lines)).toEqual(forward);
    return forward;
  }

  /** `lines`: targets carry their 0-based line (`file#name:line`) to tell same-named methods of one file apart. */
  const check = (cases: Case[], lines = false) =>
    it.each(cases)("%s", async (_title, files, expected) => {
      expect(await bothOrders(files, lines)).toEqual(expected);
    });

  describe("Go", () => {
    const base = {
      "go.mod": "module example.com/probe\n\ngo 1.22\n",
      "mathx/m.go": "package mathx\n\nfunc Add(a, b int) int { return a + b }\n",
      "decoy/d.go": "package decoy\n\nfunc Add(a, b int) int { return a - b }\n",
    };
    const main = (imports: string, body: string) => ({ ...base, "main.go": `package main\n\n${imports}\n\nfunc Run() int { ${body} }\n` });
    const mathx = 'import "example.com/probe/mathx"';

    check([
      ["links pkg.F() to the imported package, never to a same-named function elsewhere", main(mathx, "return mathx.Add(1, 2)"), ["main.go#Run -> mathx/m.go#Add"]],
      ["follows an alias and ignores a /vN suffix", {
        ...main('import (\n\tm "example.com/probe/mathx"\n\t"example.com/probe/decoy/v2"\n)', "return m.Add(1, 2) + decoy.Add(1, 2)"),
        "decoy/v2/x.go": "package decoy\n\nfunc Add(a int) int { return a }\n",
      }, ["main.go#Run -> decoy/v2/x.go#Add", "main.go#Run -> mathx/m.go#Add"]],
      ["reads the nearest go.mod of a module nested in the workspace", {
        "svc/go.mod": "module example.com/svc\n",
        "svc/lib/l.go": "package lib\n\nfunc Add(a int) int { return a }\n",
        "decoy/d.go": base["decoy/d.go"],
        "svc/main.go": 'package main\n\nimport "example.com/svc/lib"\n\nfunc Run() int { return lib.Add(1) }\n',
      }, ["svc/main.go#Run -> svc/lib/l.go#Add"]],
      ["finds go.mod in a parent directory and a package at the module root", {
        ...base,
        "root.go": "package probe\n\nfunc Add(a int) int { return a }\n",
        "cmd/app/main.go": 'package main\n\nimport "example.com/probe"\n\nfunc Run() int { return probe.Add(1) }\n',
      }, ["cmd/app/main.go#Run -> root.go#Add"]],
      ["creates no edge for a standard library package", main('import "fmt"', "return fmt.Add(1, 2)"), []],
      ["creates no edge for a package of another module", main('import "github.com/other/mathx"', "return mathx.Add(1, 2)"), []],
      ["creates no edge for a path outside the module via ..", main('import "example.com/probe/../decoy"', "return decoy.Add(1, 2)"), []],
      ["creates no edge when a local variable shadows the package name", main(mathx, "mathx := 3\n\t_ = mathx\n\treturn mathx.Add(1, 2)"), []],
      ["creates no edge for a function the package does not declare", main(mathx, "return mathx.Missing(1, 2)"), []],
      ["keeps a call on a receiver that is not an import (unchanged by-name matching)", {
        "a.go": "package a\n\ntype T struct{}\n\nfunc (T) Add(a int) int { return a }\n",
        "main.go": "package main\n\nfunc Run(t T) int { return t.Add(1) }\n",
      }, ["main.go#Run -> a.go#Add"]],
    ]);

    /** Extract one Go file as if the workspace were `workspaceRoot`; the CALLS targets it produced. */
    async function targets(workspaceRoot: string, file: string, source: string): Promise<string[]> {
      const extractor = new GraphExtractor({ extensionPath: root, workspaceRoot });
      const result = await extractor.extractSource(file, "go", source);
      extractor.dispose();
      return result.edges.filter(e => e.typeRelation === "CALLS").map(e => e.targetId);
    }

    it("reads no go.mod outside the workspace, even in a sibling directory sharing its name prefix", async () => {
      const dir = path.join(root, `sibling${run++}`);
      await fs.mkdir(`${dir}-other`, { recursive: true });
      await fs.writeFile(path.join(`${dir}-other`, "go.mod"), "module example.com/x\n");
      expect(await targets(dir, normalizePath(path.join(`${dir}-other`, "main.go")),
        'package main\n\nimport "example.com/x/lib"\n\nfunc Run() { lib.Add(1) }\n')).toEqual([]);
    });

    it("computes the folder of a Windows workspace (drive letter, backslashes)", async () => {
      const original = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs, "readFile").mockImplementation(((file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
        const name = normalizePath(String(file));
        if (name === "c:/ws/go.mod") return Promise.resolve("module example.com/probe\n");
        return name.startsWith("c:/ws/") ? Promise.reject(new Error("ENOENT")) : original(file, ...rest);
      }) as typeof fs.readFile);
      expect(await targets("C:\\ws", "C:\\ws\\cmd\\main.go", `package main\n\n${mathx}\n\nfunc Run() int { return mathx.Add(1) }\n`))
        .toEqual([`${QUALIFIED_PREFIX}${JSON.stringify(["folder", "mathx", "Add"])}`]);
    });
  });

  describe("Rust", () => {
    const base = {
      "src/mathx.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
      "src/decoy.rs": "pub fn add(a: i32, b: i32) -> i32 { a - b }\n",
    };
    const main = (source: string, extra: Files = {}) => ({ ...base, ...extra, "src/main.rs": source });

    check([
      ["links module::f() to the module file, never to a same-named function elsewhere",
        main("mod mathx;\nmod decoy;\n\nfn run() -> i32 { mathx::add(1, 2) }\n"), ["src/main.rs#run -> src/mathx.rs#add"]],
      ["reads the last module segment of a path and a mod.rs directory", main(
        "fn run() -> i32 { crate::mathx::twice(1) + crate::mathx::add(1, 2) }\n",
        { "src/mathx/mod.rs": "pub fn twice(a: i32) -> i32 { 2 * a }\n", "src/decoy/mod.rs": "pub fn twice(a: i32) -> i32 { a }\n" },
      ), ["src/main.rs#run -> src/mathx.rs#add", "src/main.rs#run -> src/mathx/mod.rs#twice"]],
      ["follows `use ... as`", main("use crate::mathx as m;\n\nfn run() -> i32 { m::add(1, 2) }\n"), ["src/main.rs#run -> src/mathx.rs#add"]],
      ["links Type::f() to the file that declares the type", {
        "src/a.rs": "pub struct Foo;\nimpl Foo { pub fn make() -> Foo { Foo } }\n",
        "src/b.rs": "pub struct Bar;\nimpl Bar { pub fn make() -> Bar { Bar } }\n",
        "src/main.rs": "fn run() { Foo::make(); }\n",
      }, ["src/main.rs#run -> src/a.rs#make"]],
      ["keeps in-file matching for Self::, self:: and an inline module",
        main("mod inner { pub fn add() {} }\nstruct S;\nimpl S {\n  fn helper() {}\n  fn go() { Self::helper(); }\n}\nfn run() { inner::add(); }\n"),
        ["src/main.rs#go -> src/main.rs#helper", "src/main.rs#run -> src/main.rs#add"]],
      ["known limits: an inline module links nowhere; crate:: keeps matching by name", {
        "src/a.rs": "pub struct Foo;\npub mod b { pub fn f() {} }\n",
        "src/decoy.rs": "pub fn only() {}\n",
        "src/main.rs": "fn up() { crate::only(); }\nfn run() { b::f(); }\n",
      }, ["src/main.rs#up -> src/decoy.rs#only"]],
      ["links Type::f() to the impl of that type, in another file and beside a second type", {
        "src/a.rs": "pub struct Foo;\npub struct Other;\nimpl Other { pub fn make() {} }\n",
        "src/c.rs": "impl Foo { pub fn make() {} }\n",
        "src/main.rs": "fn run() { Foo::make(); }\n",
      }, ["src/main.rs#run -> src/c.rs#make"]],
      ["reads the impl type through generics, paths and trait impls", {
        "src/a.rs": "pub struct W<T>(T);\nimpl<T> W<T> { pub fn wrap() {} }\npub struct P;\nimpl crate::t::Tr for P { fn tr() {} }\nimpl Tr for Q { fn q() {} }\nimpl (u8, u8) { fn tuple() {} }\n",
        "src/main.rs": "fn run() { W::wrap(); P::tr(); Q::q(); }\n",
      }, ["src/main.rs#run -> src/a.rs#q", "src/main.rs#run -> src/a.rs#tr", "src/main.rs#run -> src/a.rs#wrap"]],
      ["links Trait::f() to the default method of the trait", {
        "src/a.rs": "pub trait Tr { fn f(&self) -> i32 { 1 } }\n",
        "src/b.rs": "pub trait Other { fn f(&self) -> i32 { 2 } }\n",
        "src/main.rs": "fn run(x: &dyn Tr) -> i32 { Tr::f(x) }\n",
      }, ["src/main.rs#run -> src/a.rs#f"]],
      ["reads a path in the impl type", {
        "src/a.rs": "pub struct Foo;\nimpl m::Foo { pub fn make() {} }\n",
        "src/main.rs": "fn run() { Foo::make(); }\n",
      }, ["src/main.rs#run -> src/a.rs#make"]],
      ["creates no edge for a standard library path or an unknown module",
        main("fn run() { std::mem::swap(&mut 1, &mut 2); nowhere::add(1, 2); }\n", { "src/swap.rs": "pub fn swap() {}\n" }), []],
    ]);
  });

  describe("Rust aliases and typed receivers (#522)", () => {
    const files = (forms: string, extra: Files = {}): Files => ({
      "src/math.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
      "src/other.rs": "pub fn add(a: i32, b: i32) -> i32 { a - b }\n",
      "src/calc.rs": "pub struct Calc;\nimpl Calc { pub fn compute(&self, x: i32) -> i32 { x } }\npub struct OtherCalc;\nimpl OtherCalc { pub fn compute(x: i32) -> i32 { x } }\n",
      ...extra,
      "src/forms.rs": forms,
    });
    const header = "use crate::math::add as sum;\nuse crate::calc::{Calc, OtherCalc};\n";

    check([
      ["links an aliased function to the module it is imported from", files(`${header}pub fn aliased() -> i32 { sum(1, 2) }\n`),
        ["src/forms.rs#aliased -> src/math.rs#add:0"]],
      ["links a function aliased inside a grouped use", files("use crate::math::{add as sum, sub};\npub fn aliased() -> i32 { sum(1, 2) }\n"),
        ["src/forms.rs#aliased -> src/math.rs#add:0"]],
      ["links a function aliased inside a nested group and a bare module path", files("use crate::{math::{add as sum}};\nuse other::add as minus;\npub fn f() -> i32 { sum(1, 2) + minus(1, 2) }\n"),
        ["src/forms.rs#f -> src/math.rs#add:0", "src/forms.rs#f -> src/other.rs#add:0"]],
      ["does not link a same-named function of another module", files(`${header}pub fn aliased() -> i32 { sum(1, 2) }\n`, { "src/forms2.rs": "pub fn sum() {}\n" }),
        ["src/forms.rs#aliased -> src/math.rs#add:0"]],
      ["creates no edge for an alias of crate/self/super items, and a local binding shadows the alias", files(
        "use crate::add as a;\nuse super::add as b;\nuse crate::math::add as sum;\npub fn f(sum: fn(i32) -> i32) -> i32 { a(1) + b(1) + sum(1) }\n", { "src/a.rs": "pub fn a() {}\n" }), []],
      ["creates no edge and does not throw on a malformed use", files("use crate::math::add as ;\nuse {x as};\npub fn f() -> i32 { sum(1, 2) }\n"), []],
      ["links a method call to the type its parameter is declared with", files(`${header}pub fn method(c: &Calc) -> i32 { c.compute(3) }\n`),
        ["src/forms.rs#method -> src/calc.rs#compute:1"]],
      ["links a method call on an annotated let, mut parameter and generic type", files(
        `${header}pub fn f(mut a: Calc, b: &mut Calc<i32>) -> i32 { let c: OtherCalc = make(); a.compute(1) + b.compute(2) + c.compute(3) }\n`),
        ["src/forms.rs#f -> src/calc.rs#compute:1", "src/forms.rs#f -> src/calc.rs#compute:3"]],
      ["links an associated call on a unit struct value to its own impl", files(`${header}pub fn via_new() -> i32 { OtherCalc.compute(1) }\n`),
        ["src/forms.rs#via_new -> src/calc.rs#compute:3"]],
      ["follows a type alias through use as", files("use crate::calc::OtherCalc as O;\npub fn f() -> i32 { O.compute(1) }\n"),
        ["src/forms.rs#f -> src/calc.rs#compute:3"]],
      ["creates no edge for a receiver of unknown or ambiguous type", files(
        `${header}pub fn f(v: Vec<Calc>, w: Calc) -> i32 { let c = Calc; let w: OtherCalc = make(); v.compute(1) + c.compute(2) + w.compute(3) + d.compute(4) }\n`), []],
    ], true);
  });

  describe("aliases and typed receivers in the other languages (#522)", () => {
    check([
      ["TypeScript: links an aliased named import", {
        "math.ts": "export function add(a: number) { return a; }\n",
        "other.ts": "export function add(a: number) { return -a; }\n",
        "forms.ts": "import { add as sum } from './math';\nexport function aliased() { return sum(1); }\n",
      }, ["forms.ts#aliased -> math.ts#add"]],
      ["TypeScript: a method call on a typed receiver links nowhere (receiver types are #499)", {
        "calc.ts": "export class Calc { compute(x: number) { return x; } }\n",
        "forms.ts": "import { Calc } from './calc';\nexport function method(c: Calc) { return c.compute(1); }\n",
      }, []],
      ["Python: links an aliased from-import", {
        "math_mod.py": "def add(a):\n    return a\n",
        "other.py": "def add(a):\n    return -a\n",
        "forms.py": "from math_mod import add as sum_\n\ndef aliased():\n    return sum_(1)\n",
      }, ["forms.py#aliased -> math_mod.py#add"]],
      ["Python: a method call on a typed receiver links nowhere (receiver types are #499)", {
        "calc.py": "class Calc:\n    def compute(self, x):\n        return x\n",
        "forms.py": "from calc import Calc\n\ndef method(c: Calc):\n    return c.compute(1)\n",
      }, []],
      ["Go: links a method call on a typed receiver", {
        "calc.go": "package p\n\ntype Calc struct{}\n\nfunc (Calc) Compute(x int) int { return x }\n",
        "forms.go": "package p\n\nfunc Method(c Calc) int { return c.Compute(1) }\n",
      }, ["forms.go#Method -> calc.go#Compute"]],
      ["Java: links a method call on a typed receiver", {
        "Calc.java": "class Calc { int compute(int x) { return x; } }\n",
        "Forms.java": "class Forms { int method(Calc c) { return c.compute(1); } }\n",
      }, ["Forms.java#method -> Calc.java#compute"]],
      ["C#: a method call on a typed receiver links nowhere (receiver types are #499)", {
        "Calc.cs": "class Calc { public int Compute(int x) { return x; } }\n",
        "Forms.cs": "class Forms { int Method(Calc c) { return c.Compute(1); } }\n",
      }, []],
      ["C#: known limit, a using alias of a type links nowhere (the stub names the alias, not the type)", {
        "Calc.cs": "namespace N { class Calc { public static int Compute(int x) { return x; } } }\n",
        "Forms.cs": "using C = N.Calc;\nclass Forms { int Method() { return C.Compute(1); } }\n",
      }, []],
    ]);
  });

  describe("Java", () => {
    const base = {
      "Util.java": "public class Util { public static int add(int a, int b) { return a + b; } }\n",
      "Decoy.java": "public class Decoy { public static int add(int a, int b) { return a - b; } }\n",
    };
    const main = (body: string, extra: Files = {}) => ({ ...base, "Main.java": `public class Main { int run() { ${body} } }\n`, ...extra });

    check([
      ["links Type.f() to the method of that class, whatever the homonym or order", main("return Util.add(1, 2);"), ["Main.java#run -> Util.java#add"]],
      ["reads the class of a package-qualified receiver", main("return com.acme.Util.add(1, 2);"), ["Main.java#run -> Util.java#add"]],
      ["links a call to a nested class and to the declaring class of the same file", {
        ...base,
        "Outer.java": "public class Outer {\n  static class Inner { static int add() { return 1; } }\n  int run() { return Inner.add() + Outer.helper(); }\n  static int helper() { return 2; }\n}\n",
      }, ["Outer.java#run -> Outer.java#add", "Outer.java#run -> Outer.java#helper"]],
      ["links an overloaded method to one overload", main("return Util.add(1);", {
        "Util.java": "public class Util {\n  static int add(int a) { return a; }\n  static int add(String a) { return 1; }\n}\n",
      }), ["Main.java#run -> Util.java#add"]],
      ["creates no edge for a library class or an unknown member", main("return Math.add(1, 2) + Util.missing();"), []],
      ["creates no edge when a variable is declared with the qualifier's name", main("", {
        "Main.java": "public class Main { int run(Object Util) { return Util.add(1, 2); } }\n",
      }), []],
    ]);
  });

  describe("C#", () => {
    const base = {
      "M.cs": "public static class M { public static int Add(int a, int b) { return a + b; } }\n",
      "D.cs": "public static class D { public static int Add(int a, int b) { return a - b; } }\n",
    };
    const main = (body: string, extra: Files = {}) => ({ ...base, "P.cs": `public class P { public static int Run() { ${body} } }\n`, ...extra });

    check([
      ["links Type.F() to the method of that class, whatever the order", main("return M.Add(1, 2);"), ["P.cs#Run -> M.cs#Add"]],
      ["reads the class of a namespace-qualified receiver", main("return Acme.Tools.M.Add(1, 2);"), ["P.cs#Run -> M.cs#Add"]],
      ["leaves an unqualified call through `using static` to name matching", main("return Add(1, 2);", {
        "P.cs": "using static M;\npublic class P { public static int Run() { return Add(1, 2); } }\n",
      }), ["P.cs#Run -> D.cs#Add"]],
      ["creates no edge for a library class, an unknown member, or a property named like the type", main("", {
        "Console.cs": "public class Other { public static void WriteLine() {} }\n",
        "P.cs": "public class P {\n  public M M { get; }\n  public int Run() { Console.WriteLine(); return M.Missing() + M.Add(1, 2); }\n}\n",
      }), []],
    ]);
  });

  it("keeps every edge after saving the index and loading it in a new indexer (cache round trip), TS and Python included", async () => {
    const { dir, indexer } = await index({
      "go.mod": "module example.com/probe\n",
      "mathx/m.go": "package mathx\n\nfunc Add(a, b int) int { return a + b }\n",
      "decoy/d.go": "package decoy\n\nfunc Add(a, b int) int { return a - b }\n",
      "main.go": 'package main\n\nimport "example.com/probe/mathx"\n\nfunc Run() int { return mathx.Add(1, 2) }\n',
      "lib.ts": "export function tsAdd(a: number) { return a; }\n",
      "app.ts": "import { tsAdd } from './lib';\nexport function tsRun() { return tsAdd(1); }\n",
      "u.py": "def py_add(a):\n    return a\n",
      "v.py": "from u import py_add\ndef py_run():\n    return py_add(1)\n",
    });
    const edges = (i: CallGraphIndexer) => i.getIndexSnapshot().edges.map(e => `${e.sourceId}>${e.targetId}`).sort();
    const dbPath = path.join(dir, "callgraph.db");
    await indexer.saveToFile(dbPath);
    const before = edges(indexer);
    indexer.dispose();

    const reloaded = new CallGraphIndexer(SQL_WASM);
    await reloaded.init();
    await expect(reloaded.loadFromFile(dbPath)).resolves.toBe(true);
    expect(edges(reloaded)).toEqual(before);
    expect(before).toHaveLength(3);
    reloaded.dispose();
  });

  describe("qualifiedCandidates", () => {
    const member = (over: Partial<QualifiedMember>): QualifiedMember =>
      ({ id: "id", path: "/w/a.rs", folder: "", startLine: 1, endLine: 2, isExported: 0, owner: "", ...over });
    const stub = (mode: string, key: string) => `${QUALIFIED_PREFIX}${JSON.stringify([mode, key, "f"])}`;
    const ids = (found: QualifiedMember[]) => found.map(c => c.id);

    it("matches a folder exactly, not its subfolders", () => {
      expect(ids(qualifiedCandidates(stub("folder", "pkg"), () => [member({ folder: "pkg" }), member({ id: "sub", folder: "pkg/sub" })], () => []))).toEqual(["id"]);
    });

    it("matches a type only by the members it encloses", () => {
      const members = [member({ id: "in", startLine: 3, endLine: 4 }), member({ id: "out", startLine: 20, endLine: 21 }), member({ id: "elsewhere", path: "/w/b.rs", startLine: 3, endLine: 4 })];
      expect(ids(qualifiedCandidates(stub("type", "T"), () => members, () => [{ path: "/w/a.rs", startLine: 0, endLine: 10 }]))).toEqual(["in"]);
    });

    it("matches a Rust module by file name or mod.rs directory, and a type by the impl of its methods", () => {
      const members = [
        member({ id: "file", path: "/w/src/key.rs" }),
        member({ id: "dir", path: "/w/src/key/mod.rs" }),
        member({ id: "method", path: "/w/src/other.rs", owner: "key" }),
        member({ id: "sibling", path: "/w/src/other.rs", owner: "Sibling" }),
        member({ id: "ownedByFile", path: "/w/src/key.rs", owner: "Sibling" }),
        member({ id: "no", path: "/w/src/nope.rs" }),
      ];
      expect(ids(qualifiedCandidates(stub("module", "key"), () => members, () => []))).toEqual(["file", "dir", "method"]);
    });

    it("compares Windows-normalised paths (drive letter, nested mod.rs directory)", () => {
      const members = [member({ id: "dir", path: "c:/w/src/key/mod.rs" }), member({ id: "file", path: "c:/w/src/key.rs" }), member({ id: "no", path: "c:/w/src/keys.rs" })];
      expect(ids(qualifiedCandidates(stub("module", "key"), () => members, () => []))).toEqual(["dir", "file"]);
    });

    it("returns nothing when the container has no member of that name", () => {
      expect(qualifiedCandidates(stub("type", "T"), () => [], () => [])).toEqual([]);
    });
  });
});
