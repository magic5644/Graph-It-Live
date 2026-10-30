import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { QUALIFIED_PREFIX, qualifiedCandidates, type QualifiedMember } from "@/analyzer/callgraph/qualifiedCalls";
import type { SupportedLang } from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";

const WASM: Record<SupportedLang, string> = {
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  python: "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-typescript.wasm",
};
const LANG_OF_EXT: Record<string, SupportedLang> = {
  ".go": "go", ".rs": "rust", ".java": "java", ".cs": "csharp", ".py": "python", ".ts": "typescript",
};

describe("qualified calls (#507)", () => {
  let root: string;
  let extractor: GraphExtractor;
  let run = 0;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-qualified-")));
    const wasm = path.join(root, "dist/wasm");
    const queries = path.join(root, "dist/queries");
    await fs.mkdir(wasm, { recursive: true });
    await fs.mkdir(queries, { recursive: true });
    await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(wasm, "tree-sitter.wasm"));
    for (const file of new Set(Object.values(WASM))) {
      await fs.copyFile(path.join("node_modules/tree-sitter-wasms/out", file), path.join(wasm, file));
    }
    for (const lang of ["go", "rust", "java", "csharp", "python", "typescript"]) {
      await fs.copyFile(`resources/queries/${lang}.scm`, path.join(queries, `${lang}.scm`));
    }
    extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    extractor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * Index `files` (relative paths, language from the extension) in a fresh workspace and return
   * the CALLS as "file#symbol -> file#symbol". Each workspace is its own root: Go reads go.mod there.
   */
  async function calls(files: Record<string, string>, order = Object.keys(files)): Promise<string[]> {
    const dir = path.join(root, `case${run++}`);
    for (const [name, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), source);
    }
    const scoped = new GraphExtractor({ extensionPath: root, workspaceRoot: dir });
    const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
    for (const name of order) {
      const lang = LANG_OF_EXT[path.extname(name)];
      if (!lang) continue;
      const file = normalizePath(path.join(dir, name));
      const result = await scoped.extractSource(file, lang, files[name]);
      indexer.indexFile(result.nodes, result.edges, file, lang, 1);
    }
    indexer.resolveExternalEdges();
    const snapshot = indexer.getIndexSnapshot();
    indexer.dispose();
    scoped.dispose();
    const label = new Map(snapshot.nodes.map(n => [n.id, `${normalizePath(path.relative(dir, n.path))}#${n.name}`]));
    return snapshot.edges.filter(e => e.typeRelation === "CALLS")
      .map(e => `${label.get(e.sourceId)} -> ${label.get(e.targetId)}`).sort();
  }

  /** Same result whatever the indexing order: the decoy may be indexed first or last. */
  async function bothOrders(files: Record<string, string>): Promise<string[]> {
    const forward = await calls(files);
    expect(await calls(files, Object.keys(files).reverse())).toEqual(forward);
    return forward;
  }

  describe("Go", () => {
    const base = {
      "go.mod": "module example.com/probe\n\ngo 1.22\n",
      "mathx/m.go": "package mathx\n\nfunc Add(a, b int) int { return a + b }\n",
      "decoy/d.go": "package decoy\n\nfunc Add(a, b int) int { return a - b }\n",
    };

    it("links pkg.F() to the imported package, never to a same-named function elsewhere", async () => {
      expect(await bothOrders({
        ...base,
        "main.go": 'package main\n\nimport "example.com/probe/mathx"\n\nfunc Run() int { return mathx.Add(1, 2) }\n',
      })).toEqual(["main.go#Run -> mathx/m.go#Add"]);
    });

    it("follows an alias and ignores a /vN suffix", async () => {
      expect(await bothOrders({
        ...base,
        "v2/m.go": "package v2\n\nfunc Twice(a int) int { return 2 * a }\n",
        "main.go": 'package main\n\nimport (\n\tm "example.com/probe/mathx"\n\t"example.com/probe/decoy/v2"\n)\n\nfunc Run() int { return m.Add(1, 2) }\nfunc Other() int { return decoy.Add(1, 2) }\n',
        "decoy/v2/x.go": "package decoy\n\nfunc Add(a int) int { return a }\n",
      })).toEqual(["main.go#Other -> decoy/v2/x.go#Add", "main.go#Run -> mathx/m.go#Add"]);
    });

    it("reads the nearest go.mod of a module nested in the workspace", async () => {
      expect(await calls({
        "svc/go.mod": "module example.com/svc\n",
        "svc/lib/l.go": "package lib\n\nfunc Add(a int) int { return a }\n",
        "decoy/d.go": base["decoy/d.go"],
        "svc/main.go": 'package main\n\nimport "example.com/svc/lib"\n\nfunc Run() int { return lib.Add(1) }\n',
      })).toEqual(["svc/main.go#Run -> svc/lib/l.go#Add"]);
    });

    it.each([
      ["a standard library package", 'import "fmt"', "fmt.Add(1, 2)"],
      ["a package of another module", 'import "github.com/other/mathx"', "mathx.Add(1, 2)"],
      ["a path outside the module via ..", 'import "example.com/probe/../decoy"', "decoy.Add(1, 2)"],
    ])("creates no edge for %s", async (_label, importLine, call) => {
      expect(await calls({
        ...base,
        "main.go": `package main\n\n${importLine}\n\nfunc Run() int { return ${call} }\n`,
      })).toEqual([]);
    });

    it("creates no edge when a local variable shadows the package name", async () => {
      expect(await calls({
        ...base,
        "main.go": 'package main\n\nimport "example.com/probe/mathx"\n\nfunc Run() int {\n\tmathx := 3\n\t_ = mathx\n\treturn mathx.Add(1, 2)\n}\n',
      })).toEqual([]);
    });

    it("creates no edge for a package whose function is not exported by it", async () => {
      expect(await calls({
        ...base,
        "main.go": 'package main\n\nimport "example.com/probe/mathx"\n\nfunc Run() int { return mathx.Missing(1, 2) }\n',
      })).toEqual([]);
    });

    it("finds go.mod in a parent directory and a package at the module root (folder \"\")", async () => {
      expect(await bothOrders({
        ...base,
        "root.go": "package probe\n\nfunc Add(a int) int { return a }\n",
        "cmd/app/main.go": 'package main\n\nimport "example.com/probe"\n\nfunc Run() int { return probe.Add(1) }\n',
      })).toEqual(["cmd/app/main.go#Run -> root.go#Add"]);
    });

    it("reads no go.mod outside the workspace, even in a sibling directory sharing its name prefix", async () => {
      const dir = path.join(root, `sibling${run++}`);
      await fs.mkdir(`${dir}-other`, { recursive: true });
      await fs.writeFile(path.join(`${dir}-other`, "go.mod"), "module example.com/x\n");
      const scoped = new GraphExtractor({ extensionPath: root, workspaceRoot: dir });
      const result = await scoped.extractSource(normalizePath(path.join(`${dir}-other`, "main.go")), "go",
        'package main\n\nimport "example.com/x/lib"\n\nfunc Run() { lib.Add(1) }\n');
      scoped.dispose();
      expect(result.edges).toEqual([]);
    });

    it("computes the folder of a Windows workspace (drive letter, backslashes)", async () => {
      const original = fs.readFile.bind(fs);
      const read = vi.spyOn(fs, "readFile").mockImplementation(((file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
        if (normalizePath(String(file)) === "c:/ws/go.mod") return Promise.resolve("module example.com/probe\n");
        if (normalizePath(String(file)).startsWith("c:/ws/")) return Promise.reject(new Error("ENOENT"));
        return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
      }) as typeof fs.readFile);
      const scoped = new GraphExtractor({ extensionPath: root, workspaceRoot: "C:\\ws" });
      const result = await scoped.extractSource("C:\\ws\\cmd\\main.go", "go",
        'package main\n\nimport "example.com/probe/mathx"\n\nfunc Run() int { return mathx.Add(1) }\n');
      read.mockRestore();
      scoped.dispose();
      expect(result.edges.filter(e => e.typeRelation === "CALLS").map(e => e.targetId)).toEqual([`${QUALIFIED_PREFIX}${JSON.stringify(["folder", "mathx", "Add"])}`]);
    });

    it("keeps a call on a receiver that is not an import (unchanged by-name matching)", async () => {
      expect(await calls({
        "a.go": "package a\n\ntype T struct{}\n\nfunc (T) Add(a int) int { return a }\n",
        "main.go": "package main\n\nfunc Run(t T) int { return t.Add(1) }\n",
      })).toEqual(["main.go#Run -> a.go#Add"]);
    });
  });

  describe("Rust", () => {
    const base = {
      "src/mathx.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
      "src/decoy.rs": "pub fn add(a: i32, b: i32) -> i32 { a - b }\n",
    };

    it("links module::f() to the module file, never to a same-named function elsewhere", async () => {
      expect(await bothOrders({
        ...base,
        "src/main.rs": "mod mathx;\nmod decoy;\n\nfn run() -> i32 { mathx::add(1, 2) }\n",
      })).toEqual(["src/main.rs#run -> src/mathx.rs#add"]);
    });

    it("reads the last module segment of a path and a mod.rs directory", async () => {
      expect(await bothOrders({
        ...base,
        "src/mathx/mod.rs": "pub fn twice(a: i32) -> i32 { 2 * a }\n",
        "src/decoy/mod.rs": "pub fn twice(a: i32) -> i32 { a }\n",
        "src/main.rs": "fn run() -> i32 { crate::mathx::twice(1) + crate::mathx::add(1, 2) }\n",
      })).toEqual(["src/main.rs#run -> src/mathx.rs#add", "src/main.rs#run -> src/mathx/mod.rs#twice"]);
    });

    it("follows `use ... as`", async () => {
      expect(await bothOrders({
        ...base,
        "src/main.rs": "use crate::mathx as m;\n\nfn run() -> i32 { m::add(1, 2) }\n",
      })).toEqual(["src/main.rs#run -> src/mathx.rs#add"]);
    });

    it("links Type::f() to the file that declares the type", async () => {
      expect(await bothOrders({
        "src/a.rs": "pub struct Foo;\nimpl Foo { pub fn make() -> Foo { Foo } }\n",
        "src/b.rs": "pub struct Bar;\nimpl Bar { pub fn make() -> Bar { Bar } }\n",
        "src/main.rs": "fn run() { Foo::make(); }\n",
      })).toEqual(["src/main.rs#run -> src/a.rs#make"]);
    });

    it("keeps in-file matching for Self::, self::, crate:: and an inline module", async () => {
      expect(await calls({
        ...base,
        "src/main.rs": "mod inner { pub fn add() {} }\nstruct S;\nimpl S {\n  fn helper() {}\n  fn go() { Self::helper(); }\n}\nfn run() { inner::add(); }\n",
      })).toEqual(["src/main.rs#go -> src/main.rs#helper", "src/main.rs#run -> src/main.rs#add"]);
    });

    it("known limits: a module declared inline in another file and an impl outside the type's file link nowhere; crate:: / super:: keep matching by name", async () => {
      expect(await calls({
        "src/a.rs": "pub struct Foo;\npub mod b { pub fn f() {} }\n",
        "src/c.rs": "impl Foo { pub fn make() {} }\n",
        "src/decoy.rs": "pub fn only() {}\n",
        "src/main.rs": "fn up() { crate::only(); }\nfn run() { b::f(); Foo::make(); }\n",
      })).toEqual(["src/main.rs#up -> src/decoy.rs#only"]);
    });

    it("creates no edge for a standard library path or an unknown module", async () => {
      expect(await calls({
        ...base,
        "src/swap.rs": "pub fn swap() {}\n",
        "src/main.rs": "fn run() { std::mem::swap(&mut 1, &mut 2); nowhere::add(1, 2); }\n",
      })).toEqual([]);
    });
  });

  describe("Java", () => {
    const base = {
      "Util.java": "public class Util { public static int add(int a, int b) { return a + b; } }\n",
      "Decoy.java": "public class Decoy { public static int add(int a, int b) { return a - b; } }\n",
    };

    it("links Type.f() to the method of that class, whatever the homonym or order", async () => {
      expect(await bothOrders({
        ...base,
        "Main.java": "public class Main { public static int run() { return Util.add(1, 2); } }\n",
      })).toEqual(["Main.java#run -> Util.java#add"]);
    });

    it("reads the class of a package-qualified receiver", async () => {
      expect(await bothOrders({
        ...base,
        "Main.java": "public class Main { int run() { return com.acme.Util.add(1, 2); } }\n",
      })).toEqual(["Main.java#run -> Util.java#add"]);
    });

    it("links a call to a nested class and to the declaring class of the same file", async () => {
      expect(await bothOrders({
        ...base,
        "Outer.java": "public class Outer {\n  static class Inner { static int add() { return 1; } }\n  int run() { return Inner.add() + Outer.helper(); }\n  static int helper() { return 2; }\n}\n",
      })).toEqual(["Outer.java#run -> Outer.java#add", "Outer.java#run -> Outer.java#helper"]);
    });

    it("links an overloaded method to one deterministic overload, whatever the order", async () => {
      const files = {
        "Util.java": "public class Util {\n  static int add(int a) { return a; }\n  static int add(String a) { return 1; }\n}\n",
        "Main.java": "public class Main { int run() { return Util.add(1); } }\n",
      };
      const found = await bothOrders(files);
      expect(found).toHaveLength(1);
      expect(found[0]).toBe("Main.java#run -> Util.java#add");
    });

    it("creates no edge for a library class or an unknown member", async () => {
      expect(await calls({
        ...base,
        "Main.java": "public class Main { int run() { return Math.add(1, 2) + Util.missing(); } }\n",
      })).toEqual([]);
    });

    it("creates no edge when a variable is declared with the qualifier's name", async () => {
      expect(await calls({
        ...base,
        "Main.java": "public class Main { int run(Object Util) { return Util.add(1, 2); } }\n",
      })).toEqual([]);
    });
  });

  describe("C#", () => {
    const base = {
      "M.cs": "public static class M { public static int Add(int a, int b) { return a + b; } }\n",
      "D.cs": "public static class D { public static int Add(int a, int b) { return a - b; } }\n",
    };

    it("links Type.F() to the method of that class, whatever the order", async () => {
      expect(await bothOrders({
        ...base,
        "P.cs": "public class P { public static int Run() { return M.Add(1, 2); } }\n",
      })).toEqual(["P.cs#Run -> M.cs#Add"]);
    });

    it("reads the class of a namespace-qualified receiver", async () => {
      expect(await bothOrders({
        ...base,
        "P.cs": "public class P { public static int Run() { return Acme.Tools.M.Add(1, 2); } }\n",
      })).toEqual(["P.cs#Run -> M.cs#Add"]);
    });

    it("leaves an unqualified call through `using static` unchanged (name match)", async () => {
      expect(await calls({
        ...base,
        "P.cs": "using static M;\npublic class P { public static int Run() { return Add(1, 2); } }\n",
      })).toHaveLength(1);
    });

    it("creates no edge for a library class, an unknown member, or a property named like the type", async () => {
      expect(await calls({
        ...base,
        "Console.cs": "public class Other { public static void WriteLine() {} }\n",
        "P.cs": "public class P {\n  public M M { get; }\n  public int Run() { Console.WriteLine(); return M.Missing() + M.Add(1, 2); }\n}\n",
      })).toEqual([]);
    });
  });

  it("keeps TypeScript and Python edges whatever else is indexed alongside (mixed workspace)", async () => {
    const files = {
      "go.mod": "module example.com/probe\n",
      "mathx/m.go": "package mathx\n\nfunc Add(a, b int) int { return a + b }\n",
      "lib.ts": "export function tsAdd(a: number) { return a; }\n",
      "app.ts": "import { tsAdd } from './lib';\nexport function tsRun() { return tsAdd(1); }\n",
      "u.py": "def py_add(a):\n    return a\n",
      "main.go": 'package main\n\nimport "example.com/probe/mathx"\n\nfunc Run() int { return mathx.Add(1, 2) }\n',
      "Util.java": "public class Util { public static int add(int a) { return a; } }\n",
      "Main.java": "public class Main { int run() { return Util.add(1); } }\n",
    };
    const expected = ["Main.java#run -> Util.java#add", "app.ts#tsRun -> lib.ts#tsAdd", "main.go#Run -> mathx/m.go#Add"];
    expect(await calls(files)).toEqual(expected);
    expect(await calls(files, Object.keys(files).reverse())).toEqual(expected);
  });

  it("keeps every edge after saving the index and loading it in a new indexer (cache round trip)", async () => {
    const dir = path.join(root, `cache${run++}`);
    const files: Record<string, string> = {
      "go.mod": "module example.com/probe\n",
      "mathx/m.go": "package mathx\n\nfunc Add(a, b int) int { return a + b }\n",
      "decoy/d.go": "package decoy\n\nfunc Add(a, b int) int { return a - b }\n",
      "main.go": 'package main\n\nimport "example.com/probe/mathx"\n\nfunc Run() int { return mathx.Add(1, 2) }\n',
      "lib.ts": "export function tsAdd(a: number) { return a; }\n",
      "app.ts": "import { tsAdd } from './lib';\nexport function tsRun() { return tsAdd(1); }\n",
      "u.py": "def py_add(a):\n    return a\n",
      "v.py": "from u import py_add\ndef py_run():\n    return py_add(1)\n",
    };
    const scoped = new GraphExtractor({ extensionPath: root, workspaceRoot: dir });
    const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
    const indexer = new CallGraphIndexer(wasm);
    await indexer.init();
    for (const [name, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), source);
    }
    for (const [name, source] of Object.entries(files)) {
      const lang = LANG_OF_EXT[path.extname(name)];
      if (!lang) continue;
      const file = normalizePath(path.join(dir, name));
      const result = await scoped.extractSource(file, lang, source);
      indexer.indexFile(result.nodes, result.edges, file, lang, 1);
    }
    indexer.resolveExternalEdges();
    const dbPath = path.join(dir, "callgraph.db");
    await indexer.saveToFile(dbPath);
    const before = indexer.getIndexSnapshot().edges.map(e => `${e.sourceId}>${e.targetId}`).sort();
    indexer.dispose();
    scoped.dispose();

    const reloaded = new CallGraphIndexer(wasm);
    await reloaded.init();
    await expect(reloaded.loadFromFile(dbPath)).resolves.toBe(true);
    expect(reloaded.getIndexSnapshot().edges.map(e => `${e.sourceId}>${e.targetId}`).sort()).toEqual(before);
    expect(before).toHaveLength(3);
    reloaded.dispose();
  });

  describe("qualifiedCandidates", () => {
    const member = (over: Partial<QualifiedMember>): QualifiedMember =>
      ({ id: "id", path: "/w/a.rs", folder: "", startLine: 1, endLine: 2, isExported: 0, ...over });
    const stub = (mode: string, key: string) => `${QUALIFIED_PREFIX}${JSON.stringify([mode, key, "f"])}`;

    it("matches a folder exactly, not its subfolders", () => {
      const found = qualifiedCandidates(stub("folder", "pkg"), () => [member({ folder: "pkg" }), member({ id: "sub", folder: "pkg/sub" })], () => []);
      expect(found.map(c => c.id)).toEqual(["id"]);
    });

    it("matches a type only by the members it encloses", () => {
      const members = [member({ id: "in", startLine: 3, endLine: 4 }), member({ id: "out", startLine: 20, endLine: 21 }), member({ id: "elsewhere", path: "/w/b.rs", startLine: 3, endLine: 4 })];
      const types = () => [{ path: "/w/a.rs", startLine: 0, endLine: 10 }];
      expect(qualifiedCandidates(stub("type", "T"), () => members, types).map(c => c.id)).toEqual(["in"]);
    });

    it("matches a Rust module by file name, mod.rs directory, or a type declared in the file", () => {
      const members = [
        member({ id: "file", path: "/w/src/key.rs" }),
        member({ id: "dir", path: "/w/src/key/mod.rs" }),
        member({ id: "typed", path: "/w/src/other.rs" }),
        member({ id: "no", path: "/w/src/nope.rs" }),
      ];
      const types = () => [{ path: "/w/src/other.rs", startLine: 50, endLine: 60 }];
      expect(qualifiedCandidates(stub("module", "key"), () => members, types).map(c => c.id)).toEqual(["file", "dir", "typed"]);
    });

    it("compares Windows-normalised paths (drive letter, nested mod.rs directory)", () => {
      const members = [member({ id: "dir", path: "c:/w/src/key/mod.rs" }), member({ id: "file", path: "c:/w/src/key.rs" }), member({ id: "no", path: "c:/w/src/keys.rs" })];
      expect(qualifiedCandidates(stub("module", "key"), () => members, () => []).map(c => c.id)).toEqual(["dir", "file"]);
    });

    it("returns nothing when the container has no member of that name", () => {
      expect(qualifiedCandidates(stub("type", "T"), () => [], () => [])).toEqual([]);
    });
  });
});
