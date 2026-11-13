import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyUnused,
  countByConfidence,
  deployManifestReferences,
  deployModuleName,
  findDynamicLoads,
  inDeepImportedPackage,
  isDeployManifest,
  isScriptRunner,
  runsAsProgram,
  urlImports,
  viteGlobs,
  expandBraces,
  writtenWorkingDirs,
  isGeneratedFile,
  isTestFile,
  loadsReaching,
  mayLoadDynamically,
  meetsConfidence,
  readsComputedAttribute,
  rustQualifiedPaths,
  rustQualifiedUse,
  writtenSourcePaths,
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
    [{ namedInDeployManifest: true }, ["named-in-deploy-manifest"]],
    [{ generated: true }, ["convention:generated"]],
    [{ publishedDeepImport: true }, ["published-deep-import"]],
    [{ testOnlyUse: true, dynamicLoads: ["src/loader.ts:3"], testFile: true }, ["test-only-use", "dynamic-import-in-workspace", "convention:test-file"]],
  ])("rates %o as medium with its reasons", (overrides, reasons) => {
    expect(classifyUnused({ ...base, ...overrides })).toMatchObject({ confidence: "medium", reasons });
  });
});

describe("bundler loads (#728)", () => {
  it("reads import.meta.glob patterns, arrays, negations and the base option", () => {
    const content = [
      "const a = import.meta.glob('./pages/*.ts');",
      "const b = import.meta.glob<string>(['./**/+assets/**', '!**/node_modules'], { eager: true, base: '../../content' });",
      "const c = import.meta.globEager(\"/src/*.{js,ts}\");",
      "const d = import.meta.glob(`./${dir}/*.ts`);",
      "const e = import.meta.glob(pattern);",
    ].join("\n");
    expect(viteGlobs(content)).toEqual([
      { patterns: ["./pages/*.ts"] },
      { patterns: ["./**/+assets/**", "!**/node_modules"], base: "../../content" },
      { patterns: ["/src/*.{js,ts}"] },
    ]);
  });

  it("does not take the base of a later call", () => {
    expect(viteGlobs("import.meta.glob('./a/*'); f({ base: './x' });")).toEqual([{ patterns: ["./a/*"] }]);
  });

  it("expands braces, nested ones too", () => {
    expect(expandBraces("*.{ts,js}")).toEqual(["*.ts", "*.js"]);
    expect(expandBraces("{a,{b,c}}/x")).toEqual(["a/x", "b/x", "a/x", "c/x"]);
    expect(expandBraces("plain")).toEqual(["plain"]);
  });

  it("reads relative new URL(..., import.meta.url) specifiers only", () => {
    const content = "new Worker(new URL('./workers/bundler/index', import.meta.url));\nnew URL(\"../a.svg\", import.meta.url);\nnew URL('https://x.dev/a.js', import.meta.url);\nnew URL(`./${n}.js`, import.meta.url);\nnew URL('./b.js', base);\n";
    expect(urlImports(content)).toEqual(["./workers/bundler/index", "../a.svg"]);
  });

  it("reads a path after an interpolated folder as relative", () => {
    expect(writtenSourcePaths("fork(`${dir}/get_donors.js`); run('/opt/x.js')")).toEqual(["get_donors.js"]);
  });
});

describe("writtenWorkingDirs (#728)", () => {
  it("reads working-directory keys and cd commands, once each", () => {
    const content = [
      "defaults:\n  run:\n    working-directory: packages/api",
      "      - working-directory: 'apps/web'\n        run: node scripts/x.mjs",
      "  workingDirectory: ignored",
      "run: cd tools && node build.mjs; cd \"tools\" && node b.mjs",
      "release:\n\tcd ../shared/x && node y.mjs",
    ].join("\n");
    expect(writtenWorkingDirs(content)).toEqual(["packages/api", "apps/web", "tools", "../shared/x"]);
  });

  it("leaves out absolute, templated and parent-only folders, and words ending in cd", () => {
    expect(writtenWorkingDirs("working-directory: /opt/app\ncd ${{ inputs.dir }}\ncd ..\ncd .\nabcd tools\nsome-cd x\n")).toEqual([]);
  });
});

describe("runsAsProgram (#726)", () => {
  it.each([
    'if __name__ == "__main__":\n    main()\n',
    "if __name__=='__main__': run()\n",
    "if (require.main === module) main();\n",
    "if (require.main == module) main();\n",
    "if (import.meta.main) await main();\n",
    "fn main() {\n}\n",
  ])("reads %j as a program", (content) => {
    expect(runsAsProgram(content)).toBe(true);
  });

  it.each(["export function main() {}\n", "const name = '__main__';\n", "def domain():\n    pass\n", "fn mainly() {}\n"])("reads %j as a module", (content) => {
    expect(runsAsProgram(content)).toBe(false);
  });
});

describe("script runners (#726)", () => {
  it.each(["Makefile", "makefile", "GNUmakefile", "rules.mk", "justfile", "Justfile", ".justfile", "publish.sh", "ci/run.SH"])("reads %s", (name) => {
    expect(isScriptRunner(name)).toBe(true);
  });

  it.each(["Makefile.am.txt", "make.ts", "justfile.md", "bash.shx", "README.md"])("ignores %s", (name) => {
    expect(isScriptRunner(name)).toBe(false);
  });
});

describe("deployment manifests (#698)", () => {
  it.each([
    "Dockerfile", "Dockerfile.lambda", "dockerfile", "Containerfile", "api.dockerfile", "serverless.yml", "template.yaml",
    "docker-compose.yml", "compose.yaml", "Procfile", "template.json", "stack.template.json",
  ])("reads %s", (name) => {
    expect(isDeployManifest(name)).toBe(true);
  });

  it.each(["pnpm-lock.yaml", "package.json", "app.ts", "tsconfig.json", "README.md"])("ignores %s", (name) => {
    expect(isDeployManifest(name)).toBe(false);
  });

  it("collects module.name and module:name pairs, every pair of a dotted path, once each", () => {
    const text = 'handler: src/handler.main\nCMD ["app.lambda_handler"]\nweb: gunicorn pkg.wsgi:application\nHandler: handler.main\n';
    expect(deployManifestReferences(text).sort()).toEqual(["app.lambda_handler", "handler.main", "pkg.wsgi", "wsgi.application"]);
  });

  it("collects nothing from text without a qualified name, and never starts a module inside a word", () => {
    expect(deployManifestReferences("FROM node\nRUN npm ci\nport: 3000\n")).toEqual([]);
    expect(deployManifestReferences("x-y.z")).toEqual(["x-y.z"]);
    expect(deployManifestReferences("1abc.def")).toEqual([]);
  });

  it("names a module by its base name, a Python package by its folder", () => {
    expect(deployModuleName(abs("src/handler.ts"))).toBe("handler");
    expect(deployModuleName(abs("svc/pkg/__init__.py"))).toBe("pkg");
    expect(deployModuleName("c:/ws/fn/app.py")).toBe("app");
  });
});

describe("generated files and deep-imported packages (#698)", () => {
  it.each([
    "/*\n * THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)\n */\nexport class A {}\n",
    "// Code generated by protoc-gen-ts. DO NOT EDIT.\nexport const a = 1;\n",
    "/** @generated */\nexport const a = 1;\n",
    "// This file is auto-generated\nexport const a = 1;\n",
    "# Autogenerated by a tool\nA = 1\n",
  ])("reads a generated header: %j", (content) => {
    expect(isGeneratedFile(content)).toBe(true);
  });

  it("reads no marker in hand-written code, nor one written far below the header", () => {
    expect(isGeneratedFile("export const generated = 1; // regenerate later\n")).toBe(false);
    expect(isGeneratedFile(`${"export const x = 1;\n".repeat(100)}// DO NOT EDIT below\n`)).toBe(false);
    expect(isGeneratedFile("")).toBe(false);
  });

  const packages = new Map([[abs("packages/kit"), true], [abs("packages/kit/nested"), false], [abs("apps/web"), false]]);

  it.each([
    ["packages/kit/src/util.ts", true],
    ["packages/kit/nested/a.ts", false],
    ["apps/web/x.ts", false],
    ["loose/file.ts", false],
  ])("finds the nearest package of %s: %s", (file, marked) => {
    expect(inDeepImportedPackage(abs(file), packages)).toBe(marked);
  });

  it("stops at the root of a Windows path with no package above it", () => {
    expect(inDeepImportedPackage("c:/ws/a/b.ts", new Map())).toBe(false);
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
    // #728: Playwright / Jest conventions
    "apps/web/playwright/login.e2e.ts", "apps/web/playwright/fixtures/users.ts", "src/x/__fixtures__/event.fixture.ts",
    "src/__mocks__/fs.ts", "cypress/support/commands.ts", "lib/x.integration-test.ts", "api/x.controller.e2e-spec.ts", "src/a.unit-test.js",
  ])("treats %s as a test file", (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each(["src/latest.ts", "src/testing.ts", "src/contest.py", "src/attest_test_helper.ts", "spec.ts", "src/protest.spec", "src/e2e.ts", "src/playwright.ts", "src/mocks/x.ts", "src/latest-test.ts", "src/contest-spec.md"])(
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

describe("writtenSourcePaths (#711)", () => {
  it.each([
    ["entryPoints: ['src/worker.ts']", ["src/worker.ts"]],
    ['"bench": "node scripts/run.mjs --fast"', ["scripts/run.mjs"]],
    ['CMD ["python", "main.py"]', ["main.py"]],
    ["new Worker('./jobs/a.js'); import('../b.tsx')", ["./jobs/a.js", "../b.tsx"]],
    ["src\\win\\a.ts and @scope/pkg/x.vue", ["a.ts", "@scope/pkg/x.vue"]],
    ["src/a.ts src/a.ts", ["src/a.ts"]],
    ["see src/a.ts.", ["src/a.ts"]],
  ])("finds the paths in %s", (content, expected) => {
    expect(writtenSourcePaths(content)).toEqual(expected);
  });

  it.each([
    ["dist/out.js.map"], ["see src/readme.md"], ["https://cdn.example/app.jsx/v2"], ["https://cdn.example/app.js"],
    ["/abs/a.ts"], ["obj.ts_value"], ["no paths here"],
  ])("finds no source path in %s", (content) => {
    expect(writtenSourcePaths(content)).toEqual([]);
  });
});
