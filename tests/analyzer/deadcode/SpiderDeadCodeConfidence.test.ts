import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UnusedSymbol } from "@/analyzer/deadcode/deadCodeConfidence";
import type { Spider } from "@/analyzer/Spider";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";

/** One workspace with every confidence level in TS, Python and Rust (#695). */
const FILES: Record<string, string> = {
  // high / test-only / low
  "src/lib.ts": "export function used() { return 1; }\nexport function unusedHigh() { return 2; }\nexport function testOnly() { return 3; }\n",
  "src/app.ts": "import { used } from './lib';\nused();\n",
  "src/lib.test.ts": "import { testOnly } from './lib';\ntestOnly();\n",
  "src/entry.ts": "export function main() { return 0; }\n",
  // a computed import reaching src/plugins/
  "src/plugins/p.ts": "export function a() { return 1; }\nexport function b() { return 2; }\n",
  "src/host.ts": "import { a } from './plugins/p';\na();\n",
  "src/loader.ts": "export async function load(name: string) { return import(`./plugins/${name}.js`); }\n",
  // a test helper
  "tests/helpers.ts": "export function usedHelper() { return 1; }\nexport function deadHelper() { return 2; }\n",
  "tests/x.test.ts": "import { usedHelper } from './helpers';\nusedHelper();\n",
  // types used only in an interface or a type alias; a namespace import used as a whole; a dynamic import's members
  "src/types.ts": "export interface Used { a: number }\nexport enum Kind { A }\nexport interface Dead { b: number }\n",
  "src/model.ts": "import type { Used, Kind } from './types';\nexport interface Model { u: Used }\nexport type Tagged = { k: Kind };\n",
  "src/ns/all.ts": "export const one = 1;\nexport const two = 2;\n",
  "src/ns/user.ts": "import * as all from './all';\nexport const list = Object.values(all);\n",
  "src/lazy/mod.ts": "export function run() { return 1; }\nexport function stop() { return 2; }\n",
  "src/lazy/caller.ts": "export async function go() { const m = await import('./mod'); return m.run(); }\n",
  // an export the file itself uses: deleting it would break the file
  "src/own.ts": "export function helperUsedHere() { return 1; }\nexport function unusedApi() { return helperUsedHere(); }\nexport const other = 1;\n// unusedApi in a comment does not count\n",
  "src/own-user.ts": "import { other } from './own';\nconsole.log(other);\n",
  // only re-exported by a barrel nothing imports
  "src/api/impl.ts": "export function onlyBarrel() { return 1; }\n",
  "src/api/index.ts": "export * from './impl';\n",
  // Python: a method is never an export
  "py/__init__.py": "",
  "py/mod.py": "def used():\n    return 1\n\ndef dead():\n    return 2\n\nclass K:\n    def method(self):\n        return 3\n",
  "py/main.py": "from py.mod import used, K\nused()\nK()\n",
  // Python: an importer reading attributes by computed name
  "py/plugins.py": "def p1():\n    return 1\n\ndef p2():\n    return 2\n",
  "py/reader.py": "import py.plugins as plugins\n\ndef run(name):\n    plugins.p1()\n    return getattr(plugins, name)\n",
  // Python: same-file calls, file-scope calls, decorated definitions and what they call
  "py/views.py": "def helper():\n    return 1\n\ndef used():\n    return helper()\n\nVALUE = setup()\n\ndef setup():\n    return 2\n\n@register\ndef view():\n    return inner()\n\ndef inner():\n    return 3\n\ndef unused_view():\n    return 4\n",
  "py/app.py": "from py.views import used\nused()\n",
  // Python: a `src/` layout package imported by its top-level name
  "svc/src/svc_pkg/__init__.py": "def create_app():\n    return 1\n\ndef dead_factory():\n    return 2\n",
  "svc/run.py": "from svc_pkg import create_app\ncreate_app()\n",
  "svc/src/svc_pkg/views.py": "from . import dead_factory as _unused\n",
  // Rust: an impl member is never an export; qualified paths, inline modules, names written elsewhere
  "rs/main.rs": "mod helpers;\nmod complete;\n\nfn main() {\n    helpers::rs_used();\n    complete::bash::generate();\n    let _s = helpers::make();\n}\n",
  "rs/other.rs": "use crate::helpers as h;\npub fn take(_s: h::Shape) {}\n",
  "rs/helpers.rs": "pub fn rs_used() { convert::to_str(); }\npub fn rs_dead() {}\npub struct S;\nimpl S { pub fn new() -> S { S } }\npub struct Shape;\npub fn make() -> Shape { Shape }\nmod convert {\n    pub(super) fn to_str() {}\n}\n",
  "rs/complete/mod.rs": "pub mod bash;\n",
  "rs/complete/bash.rs": "pub fn generate() {}\npub fn bash_dead() {}\n",
  // Lambda handlers in files imported for their other exports, named only by deployment manifests (#698)
  "lambda/handler.ts": "export function shared() { return 1; }\nexport async function main() { return 2; }\nexport function unusedHere() { return 3; }\n",
  "lambda/consumer.ts": "import { shared } from './handler';\nshared();\n",
  "serverless.yml": "functions:\n  api:\n    handler: lambda/handler.main\n",
  "pyfn/__init__.py": "",
  "pyfn/app.py": "def util():\n    return 1\n\ndef lambda_handler(event, context):\n    return 2\n\ndef app_dead():\n    return 3\n",
  "pyfn/main.py": "from pyfn.app import util\nutil()\n",
  // a published package without exports the workspace imports by deep path, a private one, and a generated file (#698)
  "packages/kit/package.json": '{"name":"@acme/kit","version":"1.0.0"}',
  "packages/kit/util.ts": "export function kitUsed() { return 1; }\nexport function kitDeep() { return 2; }\n",
  "packages/priv/package.json": '{"name":"@acme/priv","private":true}',
  "packages/priv/util.ts": "export function privUsed() { return 1; }\nexport function privDead() { return 2; }\n",
  "apps/use.ts": "import { kitUsed } from '../packages/kit/util';\nimport { privUsed } from '../packages/priv/util';\nimport '@acme/kit/util';\nimport '@acme/priv/util';\nkitUsed();\nprivUsed();\n",
  "src/gen/schema.ts": "/*\n * THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)\n */\nexport class Used {}\nexport class Unused {}\n",
  "src/gen/user.ts": "import { Used } from './schema';\nexport const u = new Used();\n",
  "pyfn/Dockerfile": "FROM public.ecr.aws/lambda/python:3.12\nCMD [\"app.lambda_handler\"]\n",
};

describe("Spider - dead-code confidence (#695)", { timeout: 60_000 }, () => {
  let root: string;
  let spider: Spider;
  let items: Map<string, UnusedSymbol>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "gitl-confidence-"));
    for (const [relative, content] of Object.entries(FILES)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), content);
    }
    spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
    const result = await spider.scanDeadCode();
    items = new Map(
      result.entries.flatMap((entry) =>
        entry.unusedSymbols.map((symbol) => [`${path.relative(root, entry.filePath).replaceAll("\\", "/")}#${symbol.name}`, symbol] as const)),
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each([
    ["src/lib.ts#unusedHigh", "high", ["importers-use-other-exports"]],
    ["src/types.ts#Dead", "high", ["importers-use-other-exports"]],
    ["src/lazy/mod.ts#stop", "high", ["importers-use-other-exports"]],
    ["src/lib.ts#testOnly", "medium", ["test-only-use"]],
    ["src/entry.ts#main", "low", ["no-importer"]],
    ["src/plugins/p.ts#b", "medium", ["dynamic-import-in-workspace"]],
    ["tests/helpers.ts#deadHelper", "medium", ["convention:test-file"]],
    ["src/api/impl.ts#onlyBarrel", "low", ["no-importer"]],
    ["py/mod.py#dead", "high", ["importers-use-other-exports"]],
    ["py/plugins.py#p2", "medium", ["dynamic-import-in-workspace"]],
    ["rs/helpers.rs#rs_dead", "high", ["importers-use-other-exports"]],
    ["rs/complete/bash.rs#bash_dead", "high", ["importers-use-other-exports"]],
    ["rs/helpers.rs#Shape", "medium", ["named-in-own-file", "name-written-elsewhere"]],
    ["py/views.py#view", "medium", ["convention:decorated"]],
    ["py/views.py#inner", "medium", ["convention:decorated", "named-in-own-file"]],
    ["src/own.ts#helperUsedHere", "medium", ["named-in-own-file"]],
    ["src/own.ts#unusedApi", "high", ["importers-use-other-exports"]],
    ["py/views.py#unused_view", "high", ["importers-use-other-exports"]],
    ["lambda/handler.ts#main", "medium", ["named-in-deploy-manifest"]],
    ["lambda/handler.ts#unusedHere", "high", ["importers-use-other-exports"]],
    ["pyfn/app.py#lambda_handler", "medium", ["named-in-deploy-manifest"]],
    ["pyfn/app.py#app_dead", "high", ["importers-use-other-exports"]],
    ["packages/kit/util.ts#kitDeep", "medium", ["published-deep-import"]],
    ["packages/priv/util.ts#privDead", "high", ["importers-use-other-exports"]],
    ["src/gen/schema.ts#Unused", "medium", ["convention:generated"]],
  ])("rates %s as %s (%s)", (key, confidence, reasons) => {
    expect(items.get(key)).toMatchObject({ confidence, reasons });
  });

  it("gives the importers as evidence, workspace-relative, test files included", () => {
    expect(items.get("src/lib.ts#unusedHigh")?.evidence).toEqual({ importers: 2, firstImporters: ["src/app.ts", "src/lib.test.ts"] });
    expect(items.get("src/plugins/p.ts#b")?.evidence).toMatchObject({ dynamicLoads: ["src/loader.ts:1"] });
    expect(items.get("py/plugins.py#p2")?.evidence).toMatchObject({ dynamicLoads: ["py/reader.py:getattr"] });
  });

  it("never reports a used export, a method, a nested function or an impl member", () => {
    for (const key of [
      "src/lib.ts#used", "src/plugins/p.ts#a", "tests/helpers.ts#usedHelper", "py/mod.py#used", "py/mod.py#K", "py/mod.py#method",
      "rs/helpers.rs#rs_used", "rs/helpers.rs#new", "rs/complete/bash.rs#generate", "rs/helpers.rs#to_str",
      "py/views.py#helper", "py/views.py#setup", "svc/src/svc_pkg/__init__.py#create_app",
      "src/types.ts#Used", "src/types.ts#Kind", "src/ns/all.ts#one", "src/ns/all.ts#two", "src/lazy/mod.ts#run",
    ]) {
      expect(items.has(key), key).toBe(false);
    }
  });

  it("returns the same items and levels for one file as the scan", async () => {
    const single = await spider.findUnusedSymbols(path.join(root, "src/lib.ts"));
    expect(single.map((s) => [s.name, s.confidence]).sort()).toEqual([["testOnly", "medium"], ["unusedHigh", "high"]]);
  });

  it("reads a changed loader again for a later single-file check", async () => {
    const loader = path.join(root, "src/loader.ts");
    await fs.writeFile(loader, "export const nothing = 1;\n");
    try {
      const single = await spider.findUnusedSymbols(path.join(root, "src/plugins/p.ts"));
      expect(single.find((s) => s.name === "b")).toMatchObject({ confidence: "high" });
    } finally {
      await fs.writeFile(loader, FILES["src/loader.ts"]);
    }
  });
});
