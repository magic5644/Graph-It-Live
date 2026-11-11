import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExcludedExport, UnusedSymbol } from "@/analyzer/deadcode/deadCodeConfidence";
import type { Spider } from "@/analyzer/Spider";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";

/** Declared entry points of TS/JSX, Python and Rust manifests, `require()` uses and package subpaths (#696). */
const FILES: Record<string, string> = {
  // package.json main names the build output; tsconfig maps it back to src/
  "package.json": JSON.stringify({ name: "app", main: "./dist/index.js" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "src" } }),
  "src/index.ts": "export * from './api';\nexport { named } from './named';\nexport function rootApi() { return 1; }\n",
  "src/api.ts": "export function apiFn() { return 1; }\n",
  "src/named.ts": "export function named() { return 1; }\nexport function notReexported() { return 2; }\n",
  "src/app.ts": "import { notReexported as _n } from './other';\nimport { named } from './named';\nnamed();\n",
  "src/other.ts": "export function notReexported() { return 1; }\nexport function otherDead() { return 2; }\n",
  // a JSX default export and what it calls
  "src/View.tsx": "export default function View() { return viewHelper(); }\nexport function viewHelper() { return 1; }\nexport function viewDead() { return 2; }\n",
  "src/viewUser.ts": "import { viewDead as _v } from './View';\n",
  // require(): destructured, member read, and a module object that escapes
  "src/req/target.ts": "export function viaRequire() { return 1; }\nexport function viaMember() { return 2; }\nexport function notRequired() { return 3; }\n",
  "src/req/user.ts": "const { viaRequire } = require('./target');\nviaRequire();\nexport const m = require('./target').viaMember();\n",
  "src/req/whole.ts": "export function w1() { return 1; }\nexport function w2() { return 2; }\n",
  "src/req/loader.ts": "export const load = () => require('./whole');\n",
  // a publishable package without main: npm loads index.js; a subpath at the package root
  "packages/lib/package.json": JSON.stringify({ name: "@scope/lib" }),
  "packages/lib/index.ts": "export function libApi() { return 1; }\n",
  "packages/lib/sub.ts": "export function subFn() { return 1; }\nexport function subDead() { return 2; }\n",
  "src/usesSub.ts": "import { subFn } from '@scope/lib/sub';\nimport { libApi } from '@scope/lib';\nsubFn();\nlibApi();\n",
  // a private package without main declares nothing
  "packages/priv/package.json": JSON.stringify({ name: "priv", private: true }),
  "packages/priv/index.ts": "export function privDead() { return 1; }\n",
  "src/usesPriv.ts": "import '../packages/priv/index';\n",
  // an invalid manifest is ignored
  "broken/package.json": "{ not json",
  "broken/index.ts": "export function brokenDead() { return 1; }\n",
  "src/usesBroken.ts": "import '../broken/index';\n",
  // Python: a console script and __all__
  "py/pyproject.toml": "[project]\nname = \"pyapp\"\n\n[project.scripts]\npyapp = \"pyapp.cli:main\"\n",
  "py/pyapp/__init__.py": "from pyapp.core import exported, not_all\n__all__ = ['exported']\n",
  "py/pyapp/core.py": "def exported():\n    return 1\n\ndef not_all():\n    return 2\n\ndef core_dead():\n    return 3\n",
  "py/pyapp/cli.py": "def main():\n    return 1\n\ndef cli_dead():\n    return 2\n",
  "py/run.py": "from pyapp.cli import cli_dead as _c\n",
  // Rust: the lib crate's pub items through pub mod; pub(crate) is not API
  "rsc/Cargo.toml": "[package]\nname = \"rsc\"\n",
  "rsc/src/lib.rs": "pub mod api;\nmod hidden;\npub fn public_fn() {}\npub(crate) fn crate_only() {}\n",
  "rsc/src/api.rs": "pub fn rs_api() {}\n",
  "rsc/src/hidden.rs": "pub fn hidden_fn() {}\n",
  "rsc/src/main.rs": "use rsc::api;\nfn main() { hidden(); }\n",
};

const key = (root: string, filePath: string, name: string): string => `${path.relative(root, filePath).replaceAll("\\", "/")}#${name}`;

describe("Spider - declared entry points (#696)", { timeout: 60_000 }, () => {
  let root: string;
  let spider: Spider;
  let items: Map<string, UnusedSymbol>;
  let excluded: Map<string, ExcludedExport>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "gitl-declared-"));
    for (const [relative, content] of Object.entries(FILES)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), content);
    }
    spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
    const result = await spider.scanDeadCode();
    items = new Map(result.entries.flatMap((entry) => entry.unusedSymbols.map((symbol) => [key(root, entry.filePath, symbol.name), symbol] as const)));
    excluded = new Map(result.excluded.map((item) => [key(root, item.filePath, item.name), item] as const));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const reasonOf = (id: string): string | undefined => excluded.get(id)?.reason;

  it("excludes the exports of a declared entry and what it re-exports, with the manifest field", () => {
    expect(reasonOf("src/index.ts#rootApi")).toBe("declared:package.json#main");
    expect(reasonOf("src/api.ts#apiFn")).toBe("declared:package.json#main");
    expect(items.has("src/index.ts#rootApi")).toBe(false);
    expect(items.has("src/api.ts#apiFn")).toBe(false);
  });

  it("still reports an export no entry re-exports", () => {
    expect(items.get("src/other.ts#otherDead")?.confidence).toBe("high");
    expect(excluded.has("src/other.ts#otherDead")).toBe(false);
  });

  it("lists a JSX default export and what it calls as convention:framework-default-export", () => {
    expect(reasonOf("src/View.tsx#View")).toBe("convention:framework-default-export");
    expect(reasonOf("src/View.tsx#viewHelper")).toBe("convention:framework-default-export");
    expect(items.has("src/View.tsx#View")).toBe(false);
  });

  it("counts require() uses: destructured, a member read, and an escaping module object", () => {
    expect(items.has("src/req/target.ts#viaRequire")).toBe(false);
    expect(items.has("src/req/target.ts#viaMember")).toBe(false);
    expect(items.get("src/req/target.ts#notRequired")?.confidence).toBe("high");
    expect(items.has("src/req/whole.ts#w1")).toBe(false);
    expect(items.has("src/req/whole.ts#w2")).toBe(false);
  });

  it("reads a publishable package without main as index.js and resolves a subpath at the package root", () => {
    expect(items.has("packages/lib/sub.ts#subFn")).toBe(false);
    expect(items.get("packages/lib/sub.ts#subDead")?.confidence).toBe("high");
    expect(items.has("packages/lib/index.ts#libApi")).toBe(false);
  });

  it("declares nothing for a private package or an invalid manifest", () => {
    expect(items.get("packages/priv/index.ts#privDead")?.confidence).toBe("high");
    expect(items.get("broken/index.ts#brokenDead")?.confidence).toBe("high");
  });

  it("excludes a Python console script and the __all__ names of a package", () => {
    expect(reasonOf("py/pyapp/cli.py#main")).toBe("declared:py/pyproject.toml#project.scripts.pyapp");
    expect(items.get("py/pyapp/core.py#core_dead")).toBeDefined();
    expect(items.has("py/pyapp/core.py#exported")).toBe(false);
    expect(items.has("py/pyapp/cli.py#main")).toBe(false);
  });

  it("excludes the pub items a Rust lib crate reaches, not pub(crate) ones nor a private module", () => {
    expect(reasonOf("rsc/src/lib.rs#public_fn")).toBe("declared:rsc/Cargo.toml#lib");
    expect(reasonOf("rsc/src/api.rs#rs_api")).toBe("declared:rsc/Cargo.toml#lib");
    expect(excluded.has("rsc/src/lib.rs#crate_only")).toBe(false);
    expect(excluded.has("rsc/src/hidden.rs#hidden_fn")).toBe(false);
  });

  it("applies the same exclusions to a single-file check", async () => {
    const unused = await spider.findUnusedSymbols(path.join(root, "src/index.ts"));
    expect(unused.map((s) => s.name)).toEqual([]);
  });
});
