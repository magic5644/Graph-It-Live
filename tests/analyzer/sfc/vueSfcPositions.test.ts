/**
 * Vue SFC script analysis reports the positions of the `.vue` file itself (#644): imports, call graph nodes and
 * edges, symbols and signatures, with a template before the script, two script blocks and CRLF line breaks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Parser } from "@/analyzer/Parser";
import { SignatureAnalyzer } from "@/analyzer/SignatureAnalyzer";
import type { Spider } from "@/analyzer/Spider";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { SymbolAnalyzer } from "@/analyzer/SymbolAnalyzer";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness } from "../callgraph/treeSitterHarness";
import { wasmBuilt } from "../../mcp/tools/callGraphWorkspace";

const FIXTURES = path.resolve(__dirname, "../fixtures/vue");

/** The fixture corpus: relative path → LF content, as committed (a Windows checkout may use CRLF); tsconfig.json excluded. */
function readCorpus(): Record<string, string> {
  const corpus: Record<string, string> = {};
  for (const name of fs.readdirSync(FIXTURES, { recursive: true }) as string[]) {
    const file = path.join(FIXTURES, name);
    if (fs.statSync(file).isFile() && !name.endsWith(".json")) corpus[name.replaceAll("\\", "/")] = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  }
  return corpus;
}

const CORPUS = readCorpus();
const crlf = (name: string) => CORPUS[name].replaceAll("\n", "\r\n");

describe("Vue SFC import lines (Parser)", () => {
  it.each([
    ["OptionsApi.vue", [["./utils/math", 6]]],
    ["CompositionApi.vue", [["vue", 2], ["./utils/math", 3]]],
    ["ScriptSetupTs.vue", [["@/utils", 8]]],
    ["ScriptSetupJs.vue", [["./utils/index", 5]]],
    ["TwoBlocks.vue", [["./utils/math", 10]]],
    ["TsxSetup.vue", [["./utils/math", 2]]],
    ["TemplateOnly.vue", []],
    ["Malformed.vue", [["./utils/math", 6]]],
  ])("%s reports the lines of the .vue file", (name, expected) => {
    expect(new Parser().parse(CORPUS[name], `/w/${name}`).map((i) => [i.module, i.line])).toEqual(expected);
  });

  it("counts CRLF lines like LF lines", () => {
    expect(new Parser().parse(crlf("ScriptSetupTs.vue"), "/w/Crlf.vue").map((i) => i.line)).toEqual([8]);
  });
});

describe("Vue SFC symbols (SymbolAnalyzer)", () => {
  const analyze = (name: string, content = CORPUS[name]) => new SymbolAnalyzer().analyzeFileContent(`/w/${name}`, content);

  it.each([
    ["OptionsApi.vue", [["default", 8, true]]],
    ["CompositionApi.vue", [["default", 5, true]]],
    ["ScriptSetupTs.vue", [["total", 10, false]]],
    ["ScriptSetupJs.vue", [["twice", 6, false]]],
    ["TwoBlocks.vue", [["LIMIT", 2, true], ["capped", 12, false]]],
    ["TsxSetup.vue", [["Badge", 4, false]]],
    ["TemplateOnly.vue", []],
  ])("%s lists its script symbols at their .vue lines", (name, expected) => {
    expect(analyze(name).symbols.map((s) => [s.name, s.line, s.isExported])).toEqual(expected);
  });

  it("keeps symbol ids and same-file targets on the .vue path, across both script blocks", () => {
    const { symbols, dependencies } = analyze("TwoBlocks.vue");

    expect(symbols.map((s) => s.id)).toEqual(["/w/TwoBlocks.vue:LIMIT", "/w/TwoBlocks.vue:capped"]);
    expect(dependencies.map((d) => `${d.sourceSymbolId} -> ${d.targetSymbolId} @ ${d.targetFilePath}`)).toEqual([
      "/w/TwoBlocks.vue:capped -> ./utils/math:add @ ./utils/math",
      "/w/TwoBlocks.vue:capped -> /w/TwoBlocks.vue:LIMIT @ /w/TwoBlocks.vue",
    ]);
  });

  it("counts CRLF lines like LF lines", () => {
    expect(analyze("Crlf.vue", crlf("ScriptSetupTs.vue")).symbols.map((s) => [s.name, s.line])).toEqual([["total", 10]]);
  });

  it("follows a lang change of the same file", () => {
    const analyzer = new SymbolAnalyzer();
    const ts = '<script setup lang="ts">\nconst n: number = 1;\n</script>';
    const tsx = '<script setup lang="tsx">\nconst Tag = () => <b>{1}</b>;\n</script>';

    expect(analyzer.analyzeFileContent("/w/Switch.vue", ts).symbols.map((s) => s.name)).toEqual(["n"]);
    expect(analyzer.analyzeFileContent("/w/Switch.vue", tsx).symbols.map((s) => [s.name, s.line])).toEqual([["Tag", 2]]);
    // The renamed analyzed file replaces the previous one: one source file per SFC.
    const project = (analyzer as unknown as { project: { getSourceFiles(): Array<{ getFilePath(): string }> } }).project;
    expect(project.getSourceFiles().map((f) => path.basename(f.getFilePath()))).toEqual(["Switch.vue.sfc.tsx"]);
    expect(analyzer.getExportedSymbols("/w/Switch.vue", '<script lang="ts">\n\nexport const k = 1;\n</script>').map((s) => [s.name, s.line])).toEqual([["k", 3]]);
  });

  it("keeps a Windows SFC path in ids and same-file targets, never the analyzed name", () => {
    const content = '<script setup lang="ts">\nfunction base() {\n  return 1;\n}\nfunction capped() {\n  return base();\n}\n</script>';
    const filePath = String.raw`C:\w\src\App.vue`;
    const { symbols, dependencies } = new SymbolAnalyzer().analyzeFileContent(filePath, content);

    expect(symbols.map((s) => s.id)).toEqual([`${filePath}:base`, `${filePath}:capped`]);
    expect(dependencies.map((d) => normalizePath(d.targetFilePath).endsWith("/w/src/App.vue"))).toEqual([true]);
    expect(JSON.stringify(dependencies)).not.toContain(".sfc.");
  });

  it("never gives an SFC the React identity", () => {
    const content = '<script setup lang="tsx">\nexport default function Card() { return <div />; }\n</script>';
    expect(analyze("Card.vue", content).symbols.map((s) => s.framework)).toEqual([undefined]);
  });
});

describe("Vue SFC signatures (SignatureAnalyzer)", () => {
  it("reports a breaking change at its .vue line when the template comes first", () => {
    const before = '<template>\n  <p />\n</template>\n\n<script lang="ts">\nexport function format(value: string): string {\n  return value;\n}\n</script>\n';
    const after = before.replace("(value: string)", "(value: string, locale: string)");

    const result = new SignatureAnalyzer().analyzeBreakingChanges("/w/Format.vue", before, after).find((r) => r.symbolName === "format");

    expect(result?.breakingChanges).toEqual([expect.objectContaining({ line: 6 })]);
  });

  it("reads a template-only SFC as an empty script, not as TypeScript", () => {
    const templateOnly = "<template>\n  <p>{{ a < b }}</p>\n</template>\n";
    expect(new SignatureAnalyzer().analyzeBreakingChanges("/w/Static.vue", templateOnly, templateOnly.replace("a < b", "b < a"))).toEqual([]);
  });
});

describe.skipIf(!wasmBuilt)("Vue SFC call graph (GraphExtractor)", { timeout: 120_000 }, () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;

  beforeAll(async () => {
    harness = await createTreeSitterHarness("vue-sfc-");
    fs.copyFileSync(path.join(FIXTURES, "tsconfig.json"), path.join(harness.root, "tsconfig.json"));
  });
  afterAll(() => harness.dispose());

  it("indexes nodes and edges at the 0-based lines and columns of the .vue files", async () => {
    const indexer = await harness.newIndexer();
    try {
      await harness.indexInto(indexer, CORPUS);
      const nodes = indexer.getIndexSnapshot().nodes.map((n) => `${path.basename(n.path)}#${n.name} ${n.startLine}-${n.endLine}:${n.startCol}`);

      expect(nodes.sort()).toEqual([
        "CompositionApi.vue#setup 5-8:2",
        "CompositionApi.vue#sum 6-6:10",
        "OptionsApi.vue#run 10-12:4",
        "ScriptSetupJs.vue#twice 5-7:9",
        "ScriptSetupTs.vue#total 9-11:9",
        "TsxSetup.vue#Badge 3-3:6",
        "TwoBlocks.vue#capped 11-13:9",
        "math.ts#add 0-2:16",
      ]);
      // The alias + barrel import (`@/utils`) and the tsx block resolve like the others.
      expect(harness.describe(indexer).edges.sort()).toEqual([
        "CompositionApi.vue#sum -CALLS@6-> utils/math.ts#add",
        "OptionsApi.vue#run -CALLS@11-> utils/math.ts#add",
        "ScriptSetupJs.vue#twice -CALLS@6-> utils/math.ts#add",
        "ScriptSetupTs.vue#total -CALLS@10-> utils/math.ts#add",
        "TsxSetup.vue#Badge -CALLS@3-> utils/math.ts#add",
        "TwoBlocks.vue#capped -CALLS@12-> utils/math.ts#add",
      ]);
    } finally {
      indexer.dispose();
    }
  });

  it("indexes a CRLF SFC at the same lines and columns", async () => {
    const { nodes, edges } = await harness.index({ "utils/math.ts": CORPUS["utils/math.ts"], "Crlf.vue": crlf("ScriptSetupTs.vue") });

    expect(nodes.find((n) => n.key === "Crlf.vue#total")).toMatchObject({ startLine: 9, endLine: 11 });
    expect(edges).toEqual(["Crlf.vue#total -CALLS@10-> utils/math.ts#add"]);
  });

  it("indexes a Svelte SFC (block regex) at its .svelte lines", async () => {
    const svelte = '<script context="module">\n  export const prerender = true;\n</script>\n\n<h1>{title}</h1>\n\n<script lang="ts">\n  import { add } from "./utils/math";\n  function shout(): number {\n    return add(1, 2);\n  }\n</script>\n\n{#if title}<p>{shout()}</p>{/if}\n';
    const { nodes, edges } = await harness.index({ "utils/math.ts": CORPUS["utils/math.ts"], "Page.svelte": svelte });

    expect(nodes.find((n) => n.key === "Page.svelte#shout")).toMatchObject({ startLine: 8, endLine: 10 });
    expect(edges).toEqual(["Page.svelte#shout -CALLS@9-> utils/math.ts#add"]);
  });

  it("parses lang=tsx with the tsx grammar: JSX is not a syntax error", async () => {
    const jsx = '<script setup lang="tsx">\nconst Row = () => <tr><td>{cell()}</td></tr>;\nfunction cell() { return 1; }\n</script>\n';
    const { edges } = await harness.index({ "Row.vue": jsx });

    expect(edges).toEqual(["Row.vue#Row -CALLS@1-> Row.vue#cell"]);
  });
});

describe.skipIf(!wasmBuilt)("Vue SFC through Spider", { timeout: 120_000 }, () => {
  let root: string;
  let spider: Spider;
  const file = (name: string) => normalizePath(path.join(root, name));

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vue-spider-")));
    fs.cpSync(FIXTURES, root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
  }, 120_000);
  afterAll(async () => {
    await spider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the script symbols of a .vue file", async () => {
    const graph = await spider.getSymbolGraph(file("TwoBlocks.vue"));
    expect(graph.symbols.map((s) => [s.name, s.line])).toEqual([["LIMIT", 2], ["capped", 12]]);
  });

  it("credits an export used by a .vue script", async () => {
    expect((await spider.findUnusedSymbols(file("utils/math.ts"))).map((s) => s.name)).toEqual([]);
  });

  it("stays conservative where the template is not analyzed yet: no unused import or export in an SFC", async () => {
    expect(await spider.findUnusedSymbols(file("TwoBlocks.vue"))).toEqual([]);
    expect(await spider.verifyDependencyUsage(file("TemplateOnly.vue"), file("utils/math.ts"))).toBe(true);
    const batch = await spider.verifyDependencyUsageBatch(file("TemplateOnly.vue"), [file("utils/math.ts")]);
    expect([...batch.values()]).toEqual([true]);
  });
});
