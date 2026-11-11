import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDeclaredEntryPoints,
  declaredReason,
  deepImportablePackageName,
  deepSpecifierPackages,
  pythonAllNames,
  rustAttributedFunctions,
  rustPublicModules,
  WHOLE_FILE,
  type EntryPointSources,
  type Manifest,
} from "@/analyzer/deadcode/declaredEntryPoints";
import { normalizePath } from "@/shared/path";

const ROOT = normalizePath(path.resolve("/ws"));
const abs = (relative: string): string => `${ROOT}/${relative}`;

function sources(files: string[], manifests: Array<{ file: string; text: string; layout?: Manifest["layout"] }>, extra: Partial<EntryPointSources> = {}): EntryPointSources {
  return {
    rootDir: ROOT,
    files: new Set(files.map(abs)),
    manifests: manifests.map((m) => ({ ...m, file: abs(m.file) })),
    pythonAll: new Map(),
    rustPubMods: new Map(),
    rustAttributed: new Map(),
    ...extra,
  };
}

/** `relative#name → reason` of every entry, sorted. */
function entriesOf(input: EntryPointSources): { entries: string[]; warnings: string[] } {
  const { entryPoints, warnings } = collectDeclaredEntryPoints(input);
  const entries = [...entryPoints].flatMap(([file, names]) => [...names].map(([name, reason]) => `${file.slice(ROOT.length + 1)}#${name} ${reason}`));
  return { entries: entries.sort((a, b) => a.localeCompare(b)), warnings };
}

const pkg = (json: unknown, files: string[], layout?: Manifest["layout"]): ReturnType<typeof entriesOf> =>
  entriesOf(sources(files, [{ file: "package.json", text: JSON.stringify(json), ...(layout ? { layout } : {}) }]));

describe("declaredEntryPoints - package.json (#696)", () => {
  it("reads main, module, types and typings, .js read as .ts", () => {
    const { entries } = pkg(
      { name: "p", main: "./lib/a.js", module: "lib/b.mjs", types: "lib/c.d.ts", typings: "lib/d" },
      ["lib/a.ts", "lib/b.mts", "lib/c.ts", "lib/d/index.ts"],
    );
    expect(entries).toEqual([
      "lib/a.ts#* declared:package.json#main",
      "lib/b.mts#* declared:package.json#module",
      "lib/c.ts#* declared:package.json#types",
      "lib/d/index.ts#* declared:package.json#typings",
    ]);
  });

  it("reads browser and bin as a path or a map, and skips a browser module blocked with false", () => {
    expect(pkg({ name: "p", main: "a.js", browser: "b.js", bin: "c.js" }, ["a.js", "b.js", "c.js"]).entries).toEqual([
      "a.js#* declared:package.json#main",
      "b.js#* declared:package.json#browser",
      "c.js#* declared:package.json#bin",
    ]);
    expect(pkg({ name: "p", main: "a.js", browser: { "./a.js": "./b.js", fs: false }, bin: { tool: "c.cjs" } }, ["a.js", "b.js", "c.cts"]).entries).toEqual([
      "a.js#* declared:package.json#main",
      "b.js#* declared:package.json#browser[\"./a.js\"]",
      "c.cts#* declared:package.json#bin[\"tool\"]",
    ]);
  });

  it("reads exports: a string, subpaths, nested conditions, fallback arrays and patterns; null excludes", () => {
    const { entries } = pkg(
      {
        name: "p",
        exports: {
          ".": { import: { types: "./x/root.d.ts", default: "./x/root.mjs" }, require: "./x/root.cjs" },
          "./feature": ["./x/feature.js", "./x/feature-old.js"],
          "./plugins/*": "./x/plugins/*.js",
          "./internal/*": null,
        },
      },
      ["x/root.ts", "x/root.mts", "x/root.cts", "x/feature.ts", "x/feature-old.ts", "x/plugins/a.ts", "x/plugins/b/c.ts", "x/internal/z.ts"],
    );
    expect(entries).toEqual([
      "x/feature-old.ts#* declared:package.json#exports[\"./feature\"]",
      "x/feature.ts#* declared:package.json#exports[\"./feature\"]",
      "x/plugins/a.ts#* declared:package.json#exports[\"./plugins/*\"]",
      "x/plugins/b/c.ts#* declared:package.json#exports[\"./plugins/*\"]",
      "x/root.cts#* declared:package.json#exports[\".\"]",
      "x/root.mts#* declared:package.json#exports[\".\"]",
      "x/root.ts#* declared:package.json#exports[\".\"]",
    ]);
    expect(pkg({ name: "p", exports: "./i.js" }, ["i.ts"]).entries).toEqual(["i.ts#* declared:package.json#exports"]);
  });

  it("marks every candidate found: both .ts and .tsx", () => {
    expect(pkg({ name: "p", main: "a.js" }, ["a.ts", "a.tsx"]).entries).toEqual([
      "a.ts#* declared:package.json#main",
      "a.tsx#* declared:package.json#main",
    ]);
  });

  it("falls back to index.js when a publishable package declares no main, module or exports", () => {
    expect(pkg({ name: "@s/core" }, ["index.ts"]).entries).toEqual(["index.ts#* declared:package.json#main(default: index.js)"]);
    expect(pkg({ name: "@s/core", private: true }, ["index.ts"]).entries).toEqual([]);
    expect(pkg({ version: "1.0.0" }, ["index.ts"]).entries).toEqual([]);
    expect(pkg({ name: "p", module: "m.js" }, ["index.ts", "m.ts"]).entries).toEqual(["m.ts#* declared:package.json#module"]);
    expect(pkg({ name: "p", exports: "./e.js" }, ["index.ts", "e.ts"]).entries).toEqual(["e.ts#* declared:package.json#exports"]);
  });

  it("maps a build output back to its source: outDir to rootDir, a bundle folder to rootDir, a unique stem", () => {
    const layout = { outDir: abs("out"), rootDir: abs("src") };
    expect(pkg({ name: "p", main: "out/api/index.js" }, ["src/api/index.ts"], layout).entries).toEqual(["src/api/index.ts#* declared:package.json#main"]);
    expect(pkg({ name: "p", main: "dist/api/index.js" }, ["src/api/index.ts"], layout).entries).toEqual(["src/api/index.ts#* declared:package.json#main"]);
    expect(pkg({ name: "p", main: "dist/extension.js" }, ["src/extension/extension.ts", "src/other.ts"], layout).entries).toEqual([
      "src/extension/extension.ts#* declared:package.json#main",
    ]);
    // Two files with that stem: no guess.
    expect(pkg({ name: "p", main: "dist/extension.js" }, ["src/a/extension.ts", "src/b/extension.ts"], layout).entries).toEqual([]);
    // outDir without rootDir: the package folder.
    expect(pkg({ name: "p", main: "out/a.js" }, ["a.ts"], { outDir: abs("out") }).entries).toEqual(["a.ts#* declared:package.json#main"]);
  });

  it("maps only build outputs: an existing or stale non-build path is never mirrored nor matched by stem", () => {
    const layout = { outDir: abs("out"), rootDir: abs("src") };
    // bin/cli.js exists: src/cli.ts is not its source.
    expect(pkg({ name: "p", bin: "./bin/cli.js" }, ["bin/cli.js", "src/cli.ts"], layout).entries).toEqual(["bin/cli.js#* declared:package.json#bin"]);
    // lib/ is gone: no guess, even with one src/api/server.ts.
    expect(pkg({ name: "p", main: "./lib/server.js" }, ["src/api/server.ts"], layout).entries).toEqual([]);
    // build/ is a bundle folder.
    expect(pkg({ name: "p", main: "build/server.js" }, ["src/api/server.ts"], layout).entries).toEqual(["src/api/server.ts#* declared:package.json#main"]);
  });

  it("ignores an absolute declared path", () => {
    expect(pkg({ name: "p", main: "/ws/a.js", bin: "C:\\ws\\a.js" }, ["a.ts"]).entries).toEqual([]);
  });

  it("reads a manifest that starts with a BOM", () => {
    const bom = String.fromCodePoint(0xfeff);
    expect(entriesOf(sources(["a.ts"], [{ file: "package.json", text: `${bom}${JSON.stringify({ name: "p", main: "a.js" })}` }]))).toEqual({
      entries: ["a.ts#* declared:package.json#main"],
      warnings: [],
    });
    expect(entriesOf(sources(["app/cli.py"], [{ file: "pyproject.toml", text: `${bom}[project.scripts]\napp = "app.cli:main"\n` }])).entries).toEqual([
      "app/cli.py#main declared:pyproject.toml#project.scripts.app",
    ]);
  });

  it("marks every file of a package exported as ./* (npm semantics)", () => {
    expect(pkg({ name: "p", exports: { "./*": "./*" } }, ["a.ts", "lib/b.ts"]).entries).toEqual([
      "a.ts#* declared:package.json#exports[\"./*\"]",
      "lib/b.ts#* declared:package.json#exports[\"./*\"]",
    ]);
  });

  it("works on a Windows drive root, the same on every platform", () => {
    const root = "c:/ws";
    const input: EntryPointSources = {
      rootDir: root,
      files: new Set([`${root}/src/index.ts`, `${root}/pkg/index.ts`]),
      manifests: [
        { file: `${root}/package.json`, text: JSON.stringify({ name: "p", main: "out/index.js" }), layout: { outDir: normalizePath("C:\\ws\\out"), rootDir: `${root}/src` } },
        { file: `${root}/pkg/package.json`, text: JSON.stringify({ name: "q", main: "..\\..\\outside.js" }) },
        { file: `${root}/pkg2/package.json`, text: JSON.stringify({ name: "r" }) },
        { file: `${root}/pkg3/package.json`, text: JSON.stringify({ name: "s", main: "lib\\..\\..\\pkg\\index.js" }) },
      ],
      pythonAll: new Map(),
      rustPubMods: new Map(),
      rustAttributed: new Map(),
    };
    const { entryPoints } = collectDeclaredEntryPoints(input);
    expect([...entryPoints.keys()]).toEqual([`${root}/src/index.ts`, `${root}/pkg/index.ts`]);
  });

  it("reads each monorepo package through its own manifest", () => {
    const input = sources(["packages/a/index.ts", "packages/b/lib/main.ts"], [
      { file: "packages/a/package.json", text: JSON.stringify({ name: "a" }) },
      { file: "packages/b/package.json", text: JSON.stringify({ name: "b", main: "lib/main.js" }) },
    ]);
    expect(entriesOf(input).entries).toEqual([
      "packages/a/index.ts#* declared:packages/a/package.json#main(default: index.js)",
      "packages/b/lib/main.ts#* declared:packages/b/package.json#main",
    ]);
  });

  it("ignores a path that names no workspace file or leaves the root", () => {
    expect(pkg({ name: "p", main: "missing.js", bin: "../../etc/passwd" }, ["index.ts"]).entries).toEqual([]);
  });

  it("ignores an invalid manifest or a field of the wrong type with a warning naming the file, never a crash", () => {
    expect(entriesOf(sources(["index.ts"], [{ file: "package.json", text: "{ not json" }]))).toEqual({
      entries: [],
      warnings: ["package.json: not a JSON object, its entry points are ignored"],
    });
    expect(entriesOf(sources(["index.ts"], [{ file: "package.json", text: "[]" }])).warnings).toHaveLength(1);
    const wrong = pkg({ name: "p", main: 42, bin: 7, exports: { ".": 3 }, browser: { "./a.js": 1 } }, ["index.ts"]);
    expect(wrong.entries).toEqual([]);
    expect([...wrong.warnings].sort((a, b) => a.localeCompare(b))).toEqual([
      "package.json: bin is neither a path nor a map, ignored",
      "package.json: browser[\"./a.js\"] is not a path, ignored",
      "package.json: exports[\".\"] is not a path, a list or a map, ignored",
      "package.json: main is not a path, ignored",
    ]);
  });
});

describe("declaredEntryPoints - Python (#696)", () => {
  const files = ["src/app/cli.py", "src/app/gui/__init__.py", "app2/run.py", "app2/__main__.py", "app/__init__.py"];

  it("reads pyproject scripts, gui-scripts, entry-points groups and poetry scripts, src layout included", () => {
    const text = [
      "[project]",
      'name = "app"',
      "dependencies = [",
      '  "click>=8",',
      '  ["not", "a header"],',
      "]",
      'description = """',
      "[not.a.header]",
      '"""',
      "",
      "[project.scripts]",
      'app = "app.cli:main"',
      "",
      "[project.gui-scripts]",
      "app-gui = 'app.gui:start'  # comment",
      "",
      '[project.entry-points."app.plugins"]',
      'run = "app2.run"',
      "",
      "[tool.poetry.scripts]",
      'other = "app.cli:other"',
    ].join("\n");
    expect(entriesOf(sources(files, [{ file: "pyproject.toml", text }])).entries).toEqual([
      "app2/__main__.py#* declared:__main__.py",
      "app2/run.py#* declared:pyproject.toml#project.entry-points.app.plugins.run",
      "src/app/cli.py#main declared:pyproject.toml#project.scripts.app",
      "src/app/cli.py#other declared:pyproject.toml#tool.poetry.scripts.other",
      "src/app/gui/__init__.py#start declared:pyproject.toml#project.gui-scripts.app-gui",
    ]);
  });

  it("reads setup.cfg [options.entry_points] and setup.py entry_points", () => {
    const cfg = "[metadata]\nname = app\n\n[options.entry_points]\n; comment\nconsole_scripts =\n    app = app.cli:main [extra]\ngui_scripts = app-gui = app.gui:start\n\n[other]\nx = app.cli:ignored\n";
    expect(entriesOf(sources(files, [{ file: "setup.cfg", text: cfg }])).entries).toEqual([
      "app2/__main__.py#* declared:__main__.py",
      "src/app/cli.py#main declared:setup.cfg#options.entry_points.console_scripts",
      "src/app/gui/__init__.py#start declared:setup.cfg#options.entry_points.gui_scripts",
    ]);
    const py = "from setuptools import setup\nsetup(name='app', entry_points={'console_scripts': ['app = app.cli:main', \"x=app.cli:other\"]})\n";
    expect(entriesOf(sources(files, [{ file: "setup.py", text: py }])).entries).toEqual([
      "app2/__main__.py#* declared:__main__.py",
      "src/app/cli.py#main declared:setup.py#entry_points",
      "src/app/cli.py#other declared:setup.py#entry_points",
    ]);
    // Only the entry_points argument is read: a URL elsewhere is not an entry point.
    const withUrl = "setup(url='x = app.cli:other', entry_points={'console_scripts': ['app = app.cli:main']}, extra='y = app.cli:late')\n";
    expect(entriesOf(sources(files, [{ file: "setup.py", text: withUrl }])).entries).toEqual([
      "app2/__main__.py#* declared:__main__.py",
      "src/app/cli.py#main declared:setup.py#entry_points",
    ]);
    // No entry_points: a string with a colon is not an entry point.
    expect(entriesOf(sources(["src/app/cli.py"], [{ file: "setup.py", text: "setup(url='app.cli:main = x')" }])).entries).toEqual([]);
  });

  it("reads __all__ names of a package __init__.py", () => {
    expect(pythonAllNames("__all__ = ['a', \"b\"]\n__all__ += ('c',)\nx = ['d']\n")).toEqual(["a", "b", "c"]);
    expect(pythonAllNames("def f():\n    __all__ = ['nested']\n")).toEqual([]);
    const input = sources(["app/__init__.py"], [], { pythonAll: new Map([[abs("app/__init__.py"), ["a"]]]) });
    expect(entriesOf(input).entries).toEqual(["app/__init__.py#a declared:app/__init__.py#__all__"]);
  });

  it("ignores invalid TOML with a warning and a script whose module is not in the workspace", () => {
    expect(entriesOf(sources(files, [{ file: "pyproject.toml", text: "[project.scripts\napp = 'app.cli:main'" }])).warnings).toEqual([
      "pyproject.toml: not valid TOML, its entry points are ignored",
    ]);
    expect(entriesOf(sources(["src/app/cli.py"], [{ file: "pyproject.toml", text: "[project.scripts]\napp = 'gone.cli:main'\nbad = '1:x'" }])).entries).toEqual([]);
  });
});

describe("declaredEntryPoints - Rust (#696)", () => {
  it("declares the default lib crate and the modules it reaches through pub mod, not private mod", () => {
    const files = ["c/src/lib.rs", "c/src/api.rs", "c/src/api/inner.rs", "c/src/private.rs", "c/src/nested/mod.rs", "c/src/main.rs", "c/src/bin/tool.rs", "c/src/bin/multi/main.rs", "c/src/bin/multi/helper.rs"];
    const rustPubMods = new Map([
      [abs("c/src/lib.rs"), ["api", "nested", "missing"]],
      [abs("c/src/api.rs"), ["inner"]],
    ]);
    const input = sources(files, [{ file: "c/Cargo.toml", text: '[package]\nname = "c"\n\n[dependencies]\nserde = { version = "1" }\n' }], { rustPubMods });
    expect(entriesOf(input).entries).toEqual([
      "c/src/api.rs#* declared:c/Cargo.toml#lib",
      "c/src/api/inner.rs#* declared:c/Cargo.toml#lib",
      "c/src/bin/multi/main.rs#main declared:c/Cargo.toml#bin",
      "c/src/bin/tool.rs#main declared:c/Cargo.toml#bin",
      "c/src/lib.rs#* declared:c/Cargo.toml#lib",
      "c/src/main.rs#main declared:c/Cargo.toml#bin",
      "c/src/nested/mod.rs#* declared:c/Cargo.toml#lib",
    ]);
  });

  it("reads [lib] path and [[bin]] path; a workspace-only Cargo.toml declares nothing", () => {
    // A crate root owns its folder, whatever its name: `pub mod sub;` is crates/x/sub.rs.
    const files = ["crates/core/main.rs", "crates/x/mylib.rs", "crates/x/sub.rs", "crates/x/mylib/sub.rs"];
    const rustPubMods = new Map([[abs("crates/x/mylib.rs"), ["sub"]]]);
    const text = '[workspace]\nmembers = ["crates/*"]\n\n[[bin]]\nname = "rg"\npath = "crates/core/main.rs"\n\n[lib]\npath = "crates/x/mylib.rs"\n';
    expect(entriesOf(sources(files, [{ file: "Cargo.toml", text }], { rustPubMods })).entries).toEqual([
      "crates/core/main.rs#main declared:Cargo.toml#bin",
      "crates/x/mylib.rs#* declared:Cargo.toml#lib",
      "crates/x/sub.rs#* declared:Cargo.toml#lib",
    ]);
    expect(entriesOf(sources(["src/lib.rs"], [{ file: "Cargo.toml", text: '[workspace]\nmembers = ["a"]\n' }])).entries).toEqual([]);
  });

  it("declares functions marked by a runtime attribute", () => {
    const content = "#[no_mangle]\npub extern \"C\" fn ffi() {}\n#[unsafe(no_mangle)]\npub fn ffi2() {}\n#[proc_macro_derive(X)]\n// doc\n#[allow(dead_code)]\npub fn derive_x() {}\n#[test]\nfn t() {}\n#[derive(Debug)]\npub struct S;\n#[bench]\npub struct NotAFn;\npub fn after() {}\n";
    expect(rustAttributedFunctions(content)).toEqual([
      { name: "ffi", attribute: "no_mangle" },
      { name: "ffi2", attribute: "no_mangle" },
      { name: "derive_x", attribute: "proc_macro_derive" },
      { name: "t", attribute: "test" },
    ]);
    const input = sources(["src/ffi.rs"], [], { rustAttributed: new Map([[abs("src/ffi.rs"), [{ name: "ffi", attribute: "no_mangle" }]]]) });
    expect(entriesOf(input).entries).toEqual(["src/ffi.rs#ffi attribute:#[no_mangle]"]);
  });

  it("reads public module declarations only", () => {
    expect(rustPublicModules("pub mod a;\n  pub mod b ;\nmod c;\npub(crate) mod d;\npub mod e { }\n// pub mod f;\n")).toEqual(["a", "b"]);
  });
});

describe("declaredReason (#696)", () => {
  it("returns the whole-file reason first, then the name's", () => {
    const entryPoints = new Map([
      ["/a.ts", new Map([[WHOLE_FILE, "declared:package.json#main"]])],
      ["/b.py", new Map([["run", "declared:pyproject.toml#project.scripts.x"]])],
    ]);
    expect(declaredReason(entryPoints, "/a.ts", "anything")).toBe("declared:package.json#main");
    expect(declaredReason(entryPoints, "/b.py", "run")).toBe("declared:pyproject.toml#project.scripts.x");
    expect(declaredReason(entryPoints, "/b.py", "other")).toBeUndefined();
    expect(declaredReason(entryPoints, "/c.ts", "x")).toBeUndefined();
  });

  it("keeps the first reason when two manifests declare one file", () => {
    const input = sources(["index.ts"], [
      { file: "package.json", text: JSON.stringify({ name: "p", main: "index.js", types: "index.d.ts" }) },
    ]);
    expect(entriesOf(input).entries).toEqual(["index.ts#* declared:package.json#main"]);
  });
});

describe("published packages imported by deep path (#698)", () => {
  it.each([
    ['{"name":"@acme/kit"}', "@acme/kit"],
    ['\uFEFF{"name":"kit","private":false,"main":"index.js"}', "kit"],
    ['{"name":"kit","private":true}', undefined],
    ['{"name":"kit","exports":{".":"./index.js"}}', undefined],
    ['{"name":"kit","exports":"./index.js"}', undefined],
    ['{"private":false}', undefined],
    ["not json", undefined],
    ["[1]", undefined],
  ])("reads %s as %s", (text, name) => {
    expect(deepImportablePackageName(text)).toBe(name);
  });

  it("collects the package heading each quoted deep specifier, scoped or not, never a relative path", () => {
    const code = [
      "import { a } from '@acme/kit/util';",
      'const b = require("lodash/fp");',
      "const c = await import(`@acme/kit/deep/x`);",
      "import d from './local/x';",
      "import e from '../up/y';",
      "import f from 'plain';",
      "import g from '@scope/only';",
      "const url = 'https://example.com/x';",
    ].join("\n");
    expect(deepSpecifierPackages(code).sort()).toEqual(["@acme/kit", "lodash"]);
  });

  it("returns nothing for code without a deep specifier", () => {
    expect(deepSpecifierPackages("export const x = 1;\n")).toEqual([]);
  });
});
