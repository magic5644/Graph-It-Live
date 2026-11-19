import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AstWorkerHost } from "@/analyzer/ast/AstWorkerHost";
import { IndexCache, restoreOrBuildIndex, SymbolAnalysisCache, SYMBOL_CACHE_SCHEMA } from "@/analyzer/cache/IndexCache";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { normalizePath } from "@/analyzer/types";

const GRAPH = {
  symbols: [{ name: "a", kind: "FunctionDeclaration", line: 1, isExported: true, id: "/w/a.ts:a" }],
  dependencies: [{ sourceSymbolId: "/w/a.ts:a", targetSymbolId: "./b:b", targetFilePath: "./b" }],
};

describe("SymbolAnalysisCache", () => {
  let tmpDir: string;
  let cacheDir: string;
  let file: string;
  const symbolsJson = () => path.join(cacheDir, "symbols.json");
  const open = () => new SymbolAnalysisCache(cacheDir);

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-symbol-cache-")));
    cacheDir = path.join(tmpDir, ".graph-it", "cache");
    file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips both analyses of an unchanged file across instances, ignored by git", () => {
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.setInternalGraph(file, "v1", new Map([["a", new Set(["b"])]]));
    cache.save();

    const restored = open();
    expect(restored.getGraph(file, "v1")).toEqual(GRAPH);
    expect(restored.getInternalGraph(file, "v1")).toEqual(new Map([["a", new Set(["b"])]]));
    expect(fs.readFileSync(path.join(tmpDir, ".graph-it", ".gitignore"), "utf-8")).toBe("*\n");
  });

  it("finds a file under any spelling of its path", () => {
    const cache = open();
    cache.setGraph(file.replaceAll("/", path.sep), "v1", GRAPH);

    expect(cache.getGraph(normalizePath(file), "v1")).toEqual(GRAPH);
  });

  it("misses when the content changed, and a new analysis replaces every old one", () => {
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.setInternalGraph(file, "v1", new Map());

    expect(cache.getGraph(file, "v2")).toBeUndefined();
    cache.setGraph(file, "v2", GRAPH);
    expect(cache.getInternalGraph(file, "v2")).toBeUndefined();
    expect(cache.getGraph(file, "v1")).toBeUndefined();
  });

  it("hands out copies: a caller mutating a result never changes the cache", () => {
    const cache = open();
    const graph = structuredClone(GRAPH);
    cache.setGraph(file, "v1", graph);
    graph.symbols.pop();
    cache.getGraph(file, "v1")?.symbols.pop();

    expect(cache.getGraph(file, "v1")).toEqual(GRAPH);
  });

  it.each([
    ["another format", (data: Record<string, unknown>) => ({ ...data, schema: SYMBOL_CACHE_SCHEMA + 1 })],
    ["another analyzer version", (data: Record<string, unknown>) => ({ ...data, version: "not-this-version" })],
    ["no entries", (data: Record<string, unknown>) => ({ ...data, entries: undefined })],
  ])("starts empty on a file of %s", (_label, edit) => {
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.save();
    fs.writeFileSync(symbolsJson(), JSON.stringify(edit(JSON.parse(fs.readFileSync(symbolsJson(), "utf-8")))));

    expect(open().getGraph(file, "v1")).toBeUndefined();
  });

  it("starts empty on a corrupt or missing file", () => {
    expect(open().getGraph(file, "v1")).toBeUndefined();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(symbolsJson(), "{ truncated");
    expect(open().getGraph(file, "v1")).toBeUndefined();
  });

  it("never caches a Vue file whose template is another file", () => {
    const vue = path.join(tmpDir, "x.vue");
    const content = '<template src="./x.html"></template>\n<script>export default {}</script>';
    const cache = open();
    cache.setGraph(vue, content, GRAPH);
    cache.setGraph(vue, "<template><div/></template>", GRAPH);

    expect(cache.getGraph(vue, content)).toBeUndefined();
    expect(cache.getGraph(vue, "<template><div/></template>")).toEqual(GRAPH);
  });

  it("drops deleted files on save, and writes nothing when nothing changed", () => {
    const gone = path.join(tmpDir, "gone.ts");
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.setGraph(gone, "v1", GRAPH);
    cache.save();
    expect(open().getGraph(gone, "v1")).toBeUndefined();
    expect(open().getGraph(file, "v1")).toEqual(GRAPH);

    fs.rmSync(symbolsJson());
    cache.getGraph(file, "v1");
    cache.save();
    expect(fs.existsSync(symbolsJson())).toBe(false);
  });

  it("does not throw when the cache directory cannot be written", () => {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.writeFileSync(cacheDir, "not a directory");
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);

    expect(() => cache.save()).not.toThrow();
  });

  it("is removed by IndexCache.clear()", () => {
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.save();

    new IndexCache(tmpDir, []).clear();

    expect(fs.existsSync(symbolsJson())).toBe(false);
  });

  // #774: a warm `init` re-analyzed every file in the AST worker. Counts worker calls, never wall clock.
  describe("dead-code scan across runs", () => {
    const sources: Record<string, string> = {
      "src/a.ts": "export function used() { return 1; }\nexport function unused() { return used(); }\n",
      "src/b.ts": 'import { used } from "./a";\nexport const b = used();\n',
      "src/lib.py": "def helper():\n    return 1\n",
      "src/main.py": "from lib import helper\nhelper()\n",
      "src/lib.rs": "pub fn rusty() -> i32 { 1 }\n",
      "src/Widget.vue": '<script lang="ts">\nexport const size = 1;\n</script>\n<template><div /></template>\n',
      "src/main.go": "package main\n\nfunc Exported() {}\n",
    };

    beforeEach(() => {
      fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
      for (const [name, content] of Object.entries(sources)) {
        fs.mkdirSync(path.dirname(path.join(tmpDir, name)), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, name), content);
      }
    });

    /** One process run: open the shared cache, scan, and report the AST worker calls by file. */
    const run = async (useCache = true) => {
      const analyzed = vi.spyOn(AstWorkerHost.prototype, "analyzeFile");
      const internal = vi.spyOn(AstWorkerHost.prototype, "getInternalExportDependencyGraph");
      const spider = new SpiderBuilder().withRootDir(tmpDir).withExtensionPath(process.cwd()).withReverseIndex(true).build();
      try {
        await restoreOrBuildIndex(spider, {
          cache: useCache ? await IndexCache.open(tmpDir) : null,
          reverseIndexOptions: { excludeNodeModules: true, ignoreTypeImports: false },
          buildFullIndex: () => spider.buildFullIndex(),
        });
        const { entries } = await spider.scanDeadCode();
        const relative = (calls: unknown[][]) => calls.map(([p]) => path.relative(tmpDir, p as string).replaceAll("\\", "/")).sort();
        return { entries, analyzed: relative(analyzed.mock.calls), internal: relative(internal.mock.calls) };
      } finally {
        await spider.dispose();
        vi.restoreAllMocks();
      }
    };

    it("analyzes each file once, then nothing while unchanged, then only the changed file", async () => {
      const cold = await run();
      expect(cold.analyzed).toEqual(expect.arrayContaining(["src/Widget.vue", "src/a.ts", "src/lib.py", "src/lib.rs"]));
      expect(cold.analyzed).not.toContain("src/main.go");
      expect(cold.internal.length).toBeGreaterThan(0);

      const warm = await run();
      expect(warm).toEqual({ entries: cold.entries, analyzed: [], internal: [] });

      fs.appendFileSync(path.join(tmpDir, "src/a.ts"), "export function added() { return 2; }\n");
      const changed = await run();
      expect(new Set(changed.analyzed)).toEqual(new Set(["src/a.ts"]));
      expect(changed.internal).toEqual(["src/a.ts"]);
      expect(changed.entries.find((e) => normalizePath(e.filePath).endsWith("/src/a.ts"))?.unusedSymbols.map((s) => s.name)).toContain("added");
    }, 120_000);

    it("analyzes everything again and writes nothing without a cache (--no-cache)", async () => {
      const first = await run(false);
      const second = await run(false);

      expect(second.analyzed).toEqual(first.analyzed);
      expect(second.analyzed.length).toBeGreaterThan(0);
      expect(fs.existsSync(symbolsJson())).toBe(false);
    }, 120_000);
  });
});
