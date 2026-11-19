import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AstWorkerHost } from "@/analyzer/ast/AstWorkerHost";
import { IndexCache, restoreOrBuildIndex } from "@/analyzer/cache/IndexCache";
import { ANALYZER_VERSION, SymbolAnalysisCache, SYMBOL_CACHE_SCHEMA } from "@/analyzer/cache/SymbolAnalysisCache";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { normalizePath } from "@/analyzer/types";

const GRAPH = {
  symbols: [{ name: "a", kind: "FunctionDeclaration", line: 1, isExported: true, id: "/w/a.ts:a" }],
  dependencies: [{ sourceSymbolId: "/w/a.ts:a", targetSymbolId: "./b:b", targetFilePath: "./b" }],
};

describe("SymbolAnalysisCache", () => {
  let tmpDir: string;
  let cacheDir: string;
  let file: string;
  const symbolsFile = () => path.join(cacheDir, "symbols.cache");
  const open = (build = "build-1") => new SymbolAnalysisCache(cacheDir, build);

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
    ["another format", (lines: string[]) => [JSON.stringify({ ...JSON.parse(lines[0]), schema: SYMBOL_CACHE_SCHEMA + 1 }), ...lines.slice(1)]],
    ["another analyzer version", (lines: string[]) => [JSON.stringify({ ...JSON.parse(lines[0]), version: "not-this-version" }), ...lines.slice(1)]],
    ["another analyzer build", (lines: string[]) => [JSON.stringify({ ...JSON.parse(lines[0]), build: "build-2" }), ...lines.slice(1)]],
    ["a corrupt header", (lines: string[]) => ["{ truncated", ...lines.slice(1)]],
  ])("starts empty on a file of %s", (_label, edit) => {
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.save();
    fs.writeFileSync(symbolsFile(), edit(fs.readFileSync(symbolsFile(), "utf-8").split("\n")).join("\n"));

    expect(open().getGraph(file, "v1")).toBeUndefined();
  });

  it("starts empty on a missing file, and skips a truncated last entry", () => {
    expect(open().getGraph(file, "v1")).toBeUndefined();
    const other = path.join(tmpDir, "b.ts");
    fs.writeFileSync(other, "");
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.setGraph(other, "v1", GRAPH);
    cache.save();
    const text = fs.readFileSync(symbolsFile(), "utf-8");
    fs.writeFileSync(symbolsFile(), text.slice(0, text.lastIndexOf("\t")));

    const restored = open();
    expect(restored.getGraph(file, "v1")).toEqual(GRAPH);
    expect(restored.getGraph(other, "v1")).toBeUndefined();
  });

  it("starts empty when another analyzer build wrote the file", () => {
    const cache = open("build-1");
    cache.setGraph(file, "v1", GRAPH);
    cache.save();

    expect(open("build-2").getGraph(file, "v1")).toBeUndefined();
    expect(open("build-1").getGraph(file, "v1")).toEqual(GRAPH);
  });

  /** Saves one file's two analyses, applies `damage` to its line's fields, and reopens. */
  const damaged = (damage: (fields: string[]) => string[]) => {
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.setInternalGraph(file, "v1", new Map([["a", new Set(["b", "c"])]]));
    cache.save();
    const [header, line] = fs.readFileSync(symbolsFile(), "utf-8").split("\n");
    fs.writeFileSync(symbolsFile(), `${header}\n${damage(line.split("\t")).join("\t")}`);
    return open();
  };

  // Review #774: a damaged field threw later, and the unused-export check returned [] for the file.
  it.each([
    ["cut inside the internal graph", (f: string[]) => [f[0], f[1], f[2], f[3].slice(0, 7)], { graph: true, internal: false }],
    ["cut inside the symbol graph", (f: string[]) => [f[0], f[1], f[2].slice(0, 20), f[3]], { graph: false, internal: true }],
    ["payloads of the wrong shape", (f: string[]) => [f[0], f[1], '{"symbols":1}', '[["a",[2]]]'], { graph: false, internal: false }],
    ["unparsable payloads", (f: string[]) => [f[0], f[1], "not json", "{"], { graph: false, internal: false }],
  ])("treats an entry with %s as a miss for that analysis only, then saves it again", (_label, damage, intact) => {
    const cache = damaged(damage);
    const internal = new Map([["a", new Set(["b", "c"])]]);

    expect(cache.getGraph(file, "v1")).toEqual(intact.graph ? GRAPH : undefined);
    expect(cache.getInternalGraph(file, "v1")).toEqual(intact.internal ? internal : undefined);
    if (!intact.graph) cache.setGraph(file, "v1", GRAPH);
    cache.save();
    const restored = open();
    expect(restored.getGraph(file, "v1")).toEqual(GRAPH);
    expect(restored.getInternalGraph(file, "v1")).toEqual(intact.internal ? internal : undefined);
  });

  it("skips a line whose key is damaged, keeping the others", () => {
    const cache = damaged((f) => ['"/no-end', ...f.slice(1)]);

    expect(cache.getGraph(file, "v1")).toBeUndefined();
  });

  it("reads a file rewritten with CRLF line ends", () => {
    const other = path.join(tmpDir, "b.ts");
    fs.writeFileSync(other, "");
    const cache = open();
    cache.setGraph(file, "v1", GRAPH);
    cache.setInternalGraph(file, "v1", new Map([["a", new Set(["b"])]]));
    cache.setGraph(other, "v1", GRAPH);
    cache.save();
    fs.writeFileSync(symbolsFile(), fs.readFileSync(symbolsFile(), "utf-8").replaceAll("\n", "\r\n"));

    const restored = open();
    expect(restored.getInternalGraph(file, "v1")).toEqual(new Map([["a", new Set(["b"])]]));
    expect(restored.getGraph(other, "v1")).toEqual(GRAPH);
  });

  // Golden: a change of this layout must bump SYMBOL_CACHE_SCHEMA (and update this test).
  it("writes the format of SYMBOL_CACHE_SCHEMA 2", () => {
    expect(SYMBOL_CACHE_SCHEMA).toBe(2);
    const key = normalizePath(file);
    const cache = open();
    cache.setGraph(file, "export const a = 1;\n", {
      symbols: [{ name: "a", kind: "VariableDeclaration", line: 1, isExported: true, id: `${key}:a` }],
      dependencies: [],
    });
    cache.setInternalGraph(file, "export const a = 1;\n", new Map([[`${key}:a`, new Set<string>()]]));
    cache.save();

    expect(fs.readFileSync(symbolsFile(), "utf-8")).toBe(
      `{"schema":2,"version":${JSON.stringify(ANALYZER_VERSION)},"build":"build-1"}\n` +
        `${JSON.stringify(key)}\t037ecd1db38c230c248787e60fd7bfc0cb0101b187b59535b6e7483be762d350\t` +
        '{"symbols":[{"name":"a","kind":"VariableDeclaration","line":1,"isExported":true,"id":"\u0001:a"}],"dependencies":[]}\t' +
        '[["\u0001:a",[]]]',
    );
  });

  it("leaves a whole file when two processes save in turn: the last writer wins", () => {
    const other = path.join(tmpDir, "b.ts");
    fs.writeFileSync(other, "");
    const first = open();
    const second = open();
    first.setGraph(file, "v1", GRAPH);
    second.setGraph(other, "v1", GRAPH);
    first.save();
    second.save();

    const restored = open();
    expect(restored.getGraph(other, "v1")).toEqual(GRAPH);
    expect(restored.getGraph(file, "v1")).toBeUndefined();
    expect(fs.readdirSync(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // Quotes and tabs need JSON escaping; Windows forbids both in file names.
  it.skipIf(process.platform === "win32")("stores each file's own path once, whatever characters it holds", () => {
    const odd = path.join(tmpDir, 'dir "quoted" tab\there', "a.ts");
    fs.mkdirSync(path.dirname(odd), { recursive: true });
    fs.writeFileSync(odd, "");
    const key = normalizePath(odd);
    const graph = { symbols: [{ ...GRAPH.symbols[0], id: `${key}:a` }], dependencies: [{ ...GRAPH.dependencies[0], sourceSymbolId: `${key}:a` }] };
    const cache = open();
    cache.setGraph(odd, "v1", graph);
    cache.setInternalGraph(odd, "v1", new Map([[`${key}:a`, new Set([`${key}:b`])]]));
    cache.save();

    const restored = open();
    expect(restored.getGraph(odd, "v1")).toEqual(graph);
    expect(restored.getInternalGraph(odd, "v1")).toEqual(new Map([[`${key}:a`, new Set([`${key}:b`])]]));
    const line = fs.readFileSync(symbolsFile(), "utf-8").split("\n")[1];
    expect(line.split(JSON.stringify(key)).length - 1).toBe(1);
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

    fs.rmSync(symbolsFile());
    cache.getGraph(file, "v1");
    cache.save();
    expect(fs.existsSync(symbolsFile())).toBe(false);
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

    expect(fs.existsSync(symbolsFile())).toBe(false);
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
      "src/ext.ts": 'import { x, y, z } from "external-pkg";\nimport { used } from "./a";\nimport { b } from "./b";\nexport const e = x() + y() + z() + used() + b;\n',
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
        const resolved = vi.spyOn(PathResolver.prototype, "resolve");
        const { entries } = await spider.scanDeadCode();
        const external = resolved.mock.calls.filter(([, specifier]) => specifier === "external-pkg").length;
        const relative = (calls: unknown[][]) => calls.map(([p]) => path.relative(tmpDir, p as string).replaceAll("\\", "/")).sort((a, b) => a.localeCompare(b));
        return { entries, analyzed: relative(analyzed.mock.calls), internal: relative(internal.mock.calls), external };
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
      expect(warm.entries).toEqual(cold.entries);
      expect([warm.analyzed, warm.internal]).toEqual([[], []]);
      // An unresolvable specifier is resolved once per scan (and once more by the barrel lookup), not per
      // dependency and target file (#774): 3 dependencies x 2 target files resolved it 9 times.
      expect(cold.external).toBeLessThanOrEqual(2);
      expect(warm.external).toBeLessThanOrEqual(2);

      fs.appendFileSync(path.join(tmpDir, "src/a.ts"), "export function added() { return 2; }\n");
      const changed = await run();
      expect(new Set(changed.analyzed)).toEqual(new Set(["src/a.ts"]));
      expect(changed.internal).toEqual(["src/a.ts"]);
      expect(changed.entries.find((e) => normalizePath(e.filePath).endsWith("/src/a.ts"))?.unusedSymbols.map((s) => s.name)).toContain("added");
    }, 120_000);

    it("analyzes a file again when its cached entry is damaged, never reporting it empty", async () => {
      const cold = await run();
      const lines = fs.readFileSync(symbolsFile(), "utf-8").split("\n");
      const index = lines.findIndex((line) => line.startsWith(JSON.stringify(normalizePath(path.join(tmpDir, "src/a.ts")))));
      const fields = lines[index].split("\t");
      lines[index] = [fields[0], fields[1], fields[2].slice(0, 30), fields[3].slice(0, 5)].join("\t");
      fs.writeFileSync(symbolsFile(), lines.join("\n"));

      const repaired = await run();

      expect(repaired.entries).toEqual(cold.entries);
      expect([repaired.analyzed, repaired.internal]).toEqual([["src/a.ts"], ["src/a.ts"]]);
      expect((await run()).analyzed).toEqual([]);
    }, 120_000);

    it("analyzes everything again and writes nothing without a cache (--no-cache)", async () => {
      const first = await run(false);
      const second = await run(false);

      expect(second.analyzed).toEqual(first.analyzed);
      expect(second.analyzed.length).toBeGreaterThan(0);
      expect(fs.existsSync(symbolsFile())).toBe(false);
    }, 120_000);
  });
});
