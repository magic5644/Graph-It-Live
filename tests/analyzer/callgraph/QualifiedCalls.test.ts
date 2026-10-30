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
  async function calls(files: Files, order?: string[]): Promise<string[]> {
    const { dir, indexer } = await index(files, order);
    const snapshot = indexer.getIndexSnapshot();
    indexer.dispose();
    const label = new Map(snapshot.nodes.map(n => [n.id, `${normalizePath(path.relative(dir, n.path))}#${n.name}`]));
    return snapshot.edges.filter(e => e.typeRelation === "CALLS")
      .map(e => `${label.get(e.sourceId)} -> ${label.get(e.targetId)}`).sort();
  }

  /** Same result whatever the indexing order: the decoy may be indexed first or last. */
  async function bothOrders(files: Files): Promise<string[]> {
    const forward = await calls(files);
    expect(await calls(files, Object.keys(files).reverse())).toEqual(forward);
    return forward;
  }

  const check = (cases: Case[]) =>
    it.each(cases)("%s", async (_title, files, expected) => {
      expect(await bothOrders(files)).toEqual(expected);
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
      ["known limits: an inline module or an impl outside the type's file link nowhere; crate:: keeps matching by name", {
        "src/a.rs": "pub struct Foo;\npub mod b { pub fn f() {} }\n",
        "src/c.rs": "impl Foo { pub fn make() {} }\n",
        "src/decoy.rs": "pub fn only() {}\n",
        "src/main.rs": "fn up() { crate::only(); }\nfn run() { b::f(); Foo::make(); }\n",
      }, ["src/main.rs#up -> src/decoy.rs#only"]],
      ["creates no edge for a standard library path or an unknown module",
        main("fn run() { std::mem::swap(&mut 1, &mut 2); nowhere::add(1, 2); }\n", { "src/swap.rs": "pub fn swap() {}\n" }), []],
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
      ({ id: "id", path: "/w/a.rs", folder: "", startLine: 1, endLine: 2, isExported: 0, ...over });
    const stub = (mode: string, key: string) => `${QUALIFIED_PREFIX}${JSON.stringify([mode, key, "f"])}`;
    const ids = (found: QualifiedMember[]) => found.map(c => c.id);

    it("matches a folder exactly, not its subfolders", () => {
      expect(ids(qualifiedCandidates(stub("folder", "pkg"), () => [member({ folder: "pkg" }), member({ id: "sub", folder: "pkg/sub" })], () => []))).toEqual(["id"]);
    });

    it("matches a type only by the members it encloses", () => {
      const members = [member({ id: "in", startLine: 3, endLine: 4 }), member({ id: "out", startLine: 20, endLine: 21 }), member({ id: "elsewhere", path: "/w/b.rs", startLine: 3, endLine: 4 })];
      expect(ids(qualifiedCandidates(stub("type", "T"), () => members, () => [{ path: "/w/a.rs", startLine: 0, endLine: 10 }]))).toEqual(["in"]);
    });

    it("matches a Rust module by file name, mod.rs directory, or a type declared in the file", () => {
      const members = [
        member({ id: "file", path: "/w/src/key.rs" }),
        member({ id: "dir", path: "/w/src/key/mod.rs" }),
        member({ id: "typed", path: "/w/src/other.rs" }),
        member({ id: "no", path: "/w/src/nope.rs" }),
      ];
      const types = () => [{ path: "/w/src/other.rs", startLine: 50, endLine: 60 }];
      expect(ids(qualifiedCandidates(stub("module", "key"), () => members, types))).toEqual(["file", "dir", "typed"]);
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
