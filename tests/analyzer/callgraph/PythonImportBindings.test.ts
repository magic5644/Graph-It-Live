import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { normalizePath } from "@/shared/path";

describe("python import bindings (#497)", () => {
  let root: string;
  let extractor: GraphExtractor;
  let run = 0;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-pyimports-")));
    const wasm = path.join(root, "dist/wasm");
    const queries = path.join(root, "dist/queries");
    await fs.mkdir(wasm, { recursive: true });
    await fs.mkdir(queries, { recursive: true });
    await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(wasm, "tree-sitter.wasm"));
    await fs.copyFile("node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm", path.join(wasm, "tree-sitter-python.wasm"));
    await fs.copyFile("resources/queries/python.scm", path.join(queries, "python.scm"));
    extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    extractor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Index `files` (relative paths) in a fresh directory; returns resolved CALLS as "file#fn -> file#fn". */
  async function calls(files: Record<string, string>, order = Object.keys(files)): Promise<string[]> {
    const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
    const dir = path.join(root, `case${run++}`);
    for (const [name, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), source);
    }
    for (const name of order) {
      const file = normalizePath(path.join(dir, name));
      const result = await extractor.extractSource(file, "python", files[name]);
      indexer.indexFile(result.nodes, result.edges, file, "python", 1);
    }
    indexer.resolveExternalEdges();
    const snapshot = indexer.getIndexSnapshot();
    indexer.dispose();
    const label = new Map(snapshot.nodes.map(n => [n.id, `${normalizePath(path.relative(dir, n.path))}#${n.name}`]));
    return snapshot.edges.filter(e => e.typeRelation === "CALLS")
      .map(e => `${label.get(e.sourceId)} -> ${label.get(e.targetId)}`).sort();
  }

  const add = "def py_add(a, b):\n    return a + b\n";
  const decoy = "def py_add(a, b):\n    return 100 + a + b\n";

  it("binds direct, aliased, relative and package imports to the imported definition, whatever the homonym or order", async () => {
    const files = {
      "pkg/__init__.py": "",
      "pkg/math_utils.py": add,
      "pkg/decoy.py": decoy,
      "pkg/direct.py": "from .math_utils import py_add\ndef py_direct():\n    return py_add(1, 2)\n",
      "pkg/alias.py": "from .math_utils import py_add as plus\ndef py_alias():\n    return plus(1, 2)\n",
      "pkg/deep/__init__.py": "def init_fn():\n    pass\n",
      "pkg/deep/user.py": "from ..math_utils import py_add\nfrom pkg import init_fn\ndef deep_user():\n    py_add(1, 2)\n    init_fn()\n",
      "app.py": "from pkg.math_utils import py_add\ndef app():\n    return py_add(1, 2)\n",
    };
    const expected = [
      "app.py#app -> pkg/math_utils.py#py_add",
      "pkg/alias.py#py_alias -> pkg/math_utils.py#py_add",
      "pkg/deep/user.py#deep_user -> pkg/math_utils.py#py_add",
      "pkg/direct.py#py_direct -> pkg/math_utils.py#py_add",
    ];
    expect(await calls(files)).toEqual(expected);
    expect(await calls(files, Object.keys(files).reverse())).toEqual(expected);
  });

  it("binds `from pkg import name` to a symbol of pkg/__init__.py", async () => {
    expect(await calls({
      "pkg/__init__.py": "def init_fn():\n    pass\n",
      "app.py": "from pkg import init_fn\ndef app():\n    init_fn()\n",
    })).toEqual(["app.py#app -> pkg/__init__.py#init_fn"]);
  });

  it("preserves the module receiver for `from . import module` and `import a.b as m`", async () => {
    expect(await calls({
      "pkg/__init__.py": "",
      "pkg/math_utils.py": add,
      "pkg/decoy.py": decoy,
      "pkg/a.py": "from . import math_utils\ndef via_from():\n    math_utils.py_add(1, 2)\n",
      "pkg/b.py": "import pkg.math_utils as mu\ndef via_import():\n    mu.py_add(1, 2)\n",
      "pkg/c.py": "from . import decoy as math_utils\ndef via_rebound():\n    math_utils.py_add(1, 2)\n",
    })).toEqual([
      "pkg/a.py#via_from -> pkg/math_utils.py#py_add",
      "pkg/b.py#via_import -> pkg/math_utils.py#py_add",
      "pkg/c.py#via_rebound -> pkg/decoy.py#py_add",
    ]);
  });

  it("never links a missing module, an unrelated unique function, a builtin homonym or a stdlib module", async () => {
    expect(await calls({
      "math_utils.py": add,
      "only_here.py": "def lonely():\n    pass\ndef print():\n    pass\n",
      "missing.py": "from .missing_module import py_add\ndef a():\n    py_add(1, 2)\n",
      "unimported.py": "def b():\n    lonely()\n    print('x')\n",
      "stdlib.py": "import os\nfrom os import path as p\ndef c():\n    os.lonely()\n    p.lonely()\n",
    })).toEqual([]);
  });

  it("keeps a same-file definition and links nothing across files for unbound attribute calls", async () => {
    expect(await calls({
      "other.py": "def helper():\n    pass\n",
      "a.py": "def helper():\n    pass\ndef run(obj):\n    helper()\n    obj.helper()\n",
    })).toEqual(["a.py#run -> a.py#helper"]);
  });

  it("treats shadowed, rebound and redefined names conservatively (same-scope import and def stay unresolved)", async () => {
    const files = {
      "math_utils.py": add,
      "param.py": "from math_utils import py_add\ndef f(py_add):\n    py_add(1)\ndef g():\n    py_add(1)\n",
      "assigned.py": "from math_utils import py_add\ndef f(flag):\n    py_add = len\n    py_add([1])\n",
      "redefined.py": "from math_utils import py_add\ndef py_add(a, b):\n    pass\ndef f():\n    py_add(1, 2)\n",
      "twice.py": "try:\n    from math_utils import py_add\nexcept ImportError:\n    from nowhere import py_add\ndef f():\n    py_add(1, 2)\n",
      "lambda_param.py": "from math_utils import py_add\ndef f():\n    return lambda py_add: py_add(1)\n",
      "local_import.py": "def f():\n    from math_utils import py_add\n    py_add(1, 2)\ndef g():\n    py_add(1, 2)\n",
    };
    expect(await calls(files)).toEqual([
      "local_import.py#f -> math_utils.py#py_add",
      "param.py#g -> math_utils.py#py_add",
    ]);
  });

  it("does not let a method of the same name shadow an import", async () => {
    expect(await calls({
      "math_utils.py": add,
      "svc.py": "from math_utils import py_add\nclass S:\n    def py_add(self):\n        pass\n    def run(self):\n        py_add(1, 2)\n",
    })).toEqual(["svc.py#run -> math_utils.py#py_add"]);
  });

  it("keeps the global name fallback only when a wildcard import may supply the name", async () => {
    expect(await calls({
      "math_utils.py": add,
      "star.py": "from math_utils import *\ndef f():\n    py_add(1, 2)\n",
    })).toEqual(["star.py#f -> math_utils.py#py_add"]);
  });

  it("resolves a module-level definition after an import of the same name only when it is unambiguous", async () => {
    expect(await calls({
      "math_utils.py": "class Box:\n    def py_add(self):\n        pass\n" + add,
      "app.py": "from math_utils import py_add\ndef app():\n    py_add(1, 2)\n",
    })).toEqual(["app.py#app -> math_utils.py#py_add"]);
  });

  it("keeps no edge when the resolver fails, and builds a Windows-style module stub as given", async () => {
    const file = normalizePath(path.join(root, "w.py"));
    const source = "from .m import f\ndef a():\n    f()\n";
    const resolve = vi.spyOn(PathResolver.prototype, "resolve").mockRejectedValue(new Error("boom"));
    expect((await extractor.extractSource(file, "python", source)).edges).toEqual([]);
    resolve.mockImplementation(async (_from, specifier) => (specifier === ".m" ? "C:/ws/pkg/m.py" : null));
    const [edge] = (await extractor.extractSource(file, "python", source)).edges;
    expect(edge.targetId).toBe(`@@import:${JSON.stringify(["C:/ws/pkg/m.py", "f"])}`);
  });

  it("extracts nothing from an empty file and no edge from imports without calls", async () => {
    const file = normalizePath(path.join(root, "e.py"));
    expect(await extractor.extractSource(file, "python", "")).toEqual({ nodes: [], edges: [] });
    expect((await extractor.extractSource(file, "python", "import os\nfrom a import b\n")).edges).toEqual([]);
  });

  it("marks module-level (incl. decorated) defs and classes exported, not methods or nested defs", async () => {
    const file = normalizePath(path.join(root, "x.py"));
    const source = "@dec\ndef top():\n    def inner():\n        pass\nclass K:\n    def meth(self):\n        pass\n";
    const { nodes } = await extractor.extractSource(file, "python", source);
    expect(Object.fromEntries(nodes.map(n => [n.name, n.isExported]))).toEqual({ top: true, inner: false, K: true, meth: false });
  });

  it("drops the importer edge when the target loses the symbol, and rebinds it when it returns", async () => {
    const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
    const dir = path.join(root, `case${run++}`);
    await fs.mkdir(dir, { recursive: true });
    const target = normalizePath(path.join(dir, "lib.py"));
    const user = normalizePath(path.join(dir, "user.py"));
    await fs.writeFile(target, add);
    await fs.writeFile(user, "from lib import py_add\ndef u():\n    py_add(1, 2)\n");
    const index = async (file: string, source: string) => {
      const result = await extractor.extractSource(file, "python", source);
      indexer.indexFile(result.nodes, result.edges, file, "python", 1);
    };
    const edges = () => indexer.getIndexSnapshot().edges.filter(e => e.typeRelation === "CALLS").length;
    await index(target, add);
    await index(user, await fs.readFile(user, "utf8"));
    indexer.resolveExternalEdges();
    expect(edges()).toBe(1);
    await index(target, "def other():\n    pass\n");
    indexer.resolveExternalEdges();
    expect(edges()).toBe(0);
    await index(target, add);
    await index(user, await fs.readFile(user, "utf8"));
    indexer.resolveExternalEdges();
    expect(edges()).toBe(1);
    indexer.dispose();
  });
});
