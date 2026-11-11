import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyUnused,
  countByConfidence,
  findDynamicLoads,
  isTestFile,
  loadsReaching,
  mayLoadDynamically,
  meetsConfidence,
  readsComputedAttribute,
  rustQualifiedPaths,
  rustQualifiedUse,
} from "@/analyzer/deadcode/deadCodeConfidence";
import { confidenceHint, filterByConfidence } from "@/analyzer/deadcode/DeadCodeScanner";
import { normalizePath } from "@/shared/path";

const ROOT = normalizePath(path.resolve("/ws"));
const abs = (relative: string) => normalizePath(path.join(ROOT, relative));
const loadsOf = (relative: string, content: string) => findDynamicLoads(abs(relative), relative, content, ROOT);

describe("classifyUnused", () => {
  const base = { importers: ["src/app.ts", "src/b.ts", "src/c.ts", "src/d.ts"], testOnlyUse: false, dynamicLoads: [], testFile: false };

  it("rates an export no importer uses as high, with the importer count and the first three", () => {
    expect(classifyUnused(base)).toEqual({
      confidence: "high",
      reasons: ["importers-use-other-exports"],
      evidence: { importers: 4, firstImporters: ["src/app.ts", "src/b.ts", "src/c.ts"] },
    });
  });

  it("rates a file nothing imports as low, whatever else applies, and lists the other reasons after no-importer", () => {
    expect(classifyUnused({ ...base, importers: [], testOnlyUse: true, dynamicLoads: ["x.ts:1"], testFile: true })).toMatchObject({
      confidence: "low",
      reasons: ["no-importer", "test-only-use", "dynamic-import-in-workspace", "convention:test-file"],
      evidence: { importers: 0, firstImporters: [], dynamicLoads: ["x.ts:1"] },
    });
  });

  it.each([
    [{ testOnlyUse: true }, ["test-only-use"]],
    [{ dynamicLoads: ["src/loader.ts:3"] }, ["dynamic-import-in-workspace"]],
    [{ testFile: true }, ["convention:test-file"]],
    [{ testOnlyUse: true, dynamicLoads: ["src/loader.ts:3"], testFile: true }, ["test-only-use", "dynamic-import-in-workspace", "convention:test-file"]],
  ])("rates %o as medium with its reasons", (overrides, reasons) => {
    expect(classifyUnused({ ...base, ...overrides })).toMatchObject({ confidence: "medium", reasons });
  });
});

describe("confidence filters", () => {
  it("orders the levels high > medium > low", () => {
    expect(meetsConfidence("high", "medium")).toBe(true);
    expect(meetsConfidence("medium", "high")).toBe(false);
    expect(meetsConfidence("low", "low")).toBe(true);
  });

  it("counts every item and lists those at the threshold or above", () => {
    const items = [{ confidence: "high" }, { confidence: "low" }, { confidence: "low" }] as Parameters<typeof filterByConfidence>[0];
    expect(countByConfidence(items)).toEqual({ high: 1, medium: 0, low: 2 });
    expect(filterByConfidence(items, "medium").listed).toHaveLength(1);
    expect(confidenceHint({ high: 1, medium: 0, low: 2 }, "high")).toBe("2 low-confidence item(s) not listed: pass minConfidence low to list them.");
    expect(confidenceHint({ high: 1, medium: 0, low: 2 }, "low")).toBeUndefined();
    expect(confidenceHint({ high: 1, medium: 0, low: 0 }, "high")).toBeUndefined();
  });
});

describe("isTestFile", () => {
  it.each([
    "src/a.test.ts", "src/a.spec.tsx", "tests/util.rs", "test/helper.js", "src/__tests__/x.ts", "pkg/tests/fixtures/f.py",
    "tests/test_app.py", "app/test_views.py", "app/views_test.py", "conftest.py", "app\\tests\\x.py",
  ])("treats %s as a test file", (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each(["src/latest.ts", "src/testing.ts", "src/contest.py", "src/attest_test_helper.ts", "spec.ts", "src/protest.spec"])(
    "treats %s as production code",
    (file) => {
      expect(isTestFile(file)).toBe(false);
    },
  );
});

describe("findDynamicLoads", () => {
  it("ignores static loads, which the import graph has already", () => {
    expect(loadsOf("src/a.ts", "import('./x');\nrequire(\"./y\");\nconst t = import(`./z`);\ntype T = import('./w').W;\n")).toEqual([]);
  });

  it("bounds a template or concatenated relative prefix to its directory", () => {
    expect(loadsOf("src/a.ts", "const p = await import(`./plugins/${name}.js`);\nrequire('../lib/x-' + id);\n")).toEqual([
      { at: "src/a.ts:1", scope: abs("src/plugins") },
      { at: "src/a.ts:2", scope: abs("lib") },
    ]);
  });

  it("bounds a fully computed specifier to the caller's directory", () => {
    expect(loadsOf("src/load/a.ts", "require(name);\nimport(pathToFileURL(p).href);\nimport(`${base}/x`);\n")).toEqual([
      { at: "src/load/a.ts:1", scope: abs("src/load") },
      { at: "src/load/a.ts:2", scope: abs("src/load") },
      { at: "src/load/a.ts:3", scope: abs("src/load") },
    ]);
  });

  it("ignores a URL prefix other than file:, which loads nothing from the workspace", () => {
    expect(loadsOf("src/a.mjs", "await import(`data:text/javascript;base64,${b}`);\nimport(`node:${m}`);\nimport('https://cdn/' + m);\nimport(`file:///x/${m}`);\n")).toEqual([
      { at: "src/a.mjs:4", scope: ROOT },
    ]);
  });

  it("lets a bare or aliased prefix reach the whole workspace", () => {
    expect(loadsOf("src/load/a.ts", "import(`@/plugins/${n}`);\nrequire('plugins/' + n);\n")).toEqual([
      { at: "src/load/a.ts:1", scope: ROOT },
      { at: "src/load/a.ts:2", scope: ROOT },
    ]);
  });

  it("skips calls in comments and strings, and member calls", () => {
    expect(loadsOf("src/a.ts", "// require(name)\n/* import(x) */\nconst s = 'require(name)';\nmodule.require(name);\nobj.import(x);\n")).toEqual([]);
  });

  it("reads Python computed module names, by prefix or fully computed", () => {
    expect(loadsOf("pkg/a.py", "import importlib\nimportlib.import_module(f\"pkg.plugins.{n}\")\nimport_module('pkg.ext.' + n)\n__import__(name)\n# __import__(other)\nimportlib.import_module('pkg.static')\n")).toEqual([
      { at: "pkg/a.py:2", pathFragment: "pkg/plugins" },
      { at: "pkg/a.py:3", pathFragment: "pkg/ext" },
      { at: "pkg/a.py:4", scope: abs("pkg") },
    ]);
  });

  it("bounds a fully computed Python name to the caller's directory, a prefix without a dot to the workspace", () => {
    expect(loadsOf("pkg/a.py", "import_module(f\"{n}\")\nimport_module('plugins' + n)\n")).toEqual([
      { at: "pkg/a.py:1", scope: abs("pkg") },
      { at: "pkg/a.py:2", scope: ROOT },
    ]);
  });

  it("keeps a Python load on a line with a # inside a string, skips one after a comment #", () => {
    expect(loadsOf("pkg/a.py", "x = '#'; __import__(name)\ny = \"a\\\"#\"; __import__(name)\n# __import__(name)\n")).toEqual([
      { at: "pkg/a.py:1", scope: abs("pkg") },
      { at: "pkg/a.py:2", scope: abs("pkg") },
    ]);
  });

  it("does not crash on an unterminated specifier", () => {
    expect(loadsOf("src/a.ts", "import(`./x/${")).toEqual([{ at: "src/a.ts:1", scope: abs("src/x") }]);
    expect(loadsOf("pkg/a.py", "import_module('pkg.x")).toEqual([]);
  });
});

describe("loadsReaching", () => {
  const loads = [
    { at: "src/a.ts:1", scope: abs("src/plugins") },
    { at: "pkg/a.py:2", pathFragment: "pkg/plugins" },
  ];

  it("returns the loads whose directory or Python path holds the file", () => {
    expect(loadsReaching(abs("src/plugins/x/y.ts"), loads)).toEqual(["src/a.ts:1"]);
    expect(loadsReaching(abs("lib/pkg/plugins/p.py"), loads)).toEqual(["pkg/a.py:2"]);
    expect(loadsReaching(abs("src/plugins-old/y.ts"), loads)).toEqual([]);
    expect(loadsReaching(abs("src/other.ts"), loads)).toEqual([]);
  });
});

describe("pre-checks", () => {
  it.each([
    ["import(x)", true], ["require (x)", true], ["importlib.import_module(n)", true], ["__import__(n)", true],
    ["import { a } from './a'", false], ["const required = 1", false],
  ])("mayLoadDynamically(%s) is %s", (content, expected) => {
    expect(mayLoadDynamically(content)).toBe(expected);
  });

  it.each([
    ["getattr(mod, name)", true], ["getattr(pkg.sub, key)", true], ["getattr(mod, 'static')", false],
    ["getattr(self, name)", false], ["getattr(cls, name)", false], ["x = 1", false], ["getattr(mod,  'static')", false],
  ])("readsComputedAttribute(%s) is %s", (content, expected) => {
    expect(readsComputedAttribute(content)).toBe(expected);
  });
});

describe("Rust qualified paths", () => {
  it("lists every consecutive pair of a path, spaces allowed", () => {
    expect(rustQualifiedPaths("complete::bash::generate();\nlet x = a :: b;\nVec::<u8>::new();").sort()).toEqual(
      ["a::b", "bash::generate", "complete::bash"].sort(),
    );
  });

  it.each([
    ["src/complete/bash.rs", "", "bash::generate", true],
    ["src/complete/mod.rs", "", "complete::generate", true],
    ["src/util.rs", "mod convert {\n}\n", "convert::generate", true],
    ["src/util.rs", "", "super::generate", true],
    ["src/lib.rs", "", "crate::generate", true],
    ["src/util.rs", "", "crate::generate", false],
    ["src/util.rs", "", "self::generate", false],
    ["src/util.rs", "", "other::generate", false],
  ])("rustQualifiedUse(%s) with %s reaches generate: %s", (file, content, pair, expected) => {
    expect(rustQualifiedUse(abs(file), content, "generate", new Set([pair]))).toBe(expected);
  });
});
