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
      // The template's `{{ capped(12) }}`, owned by the file scope.
      "/w/TwoBlocks.vue:(file) -> /w/TwoBlocks.vue:capped @ /w/TwoBlocks.vue",
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

  it("records the template's uses of imports and declarations at their .vue lines, owned by the file scope", () => {
    const fileUses = analyze("Parent.vue").dependencies.filter((d) => d.sourceSymbolId === "/w/Parent.vue:(file)")
      .map((d) => `${d.targetSymbolId} ${d.relation ?? "call"}@${d.line}`);

    // The v-for `format` alias shadows the import; the defineProps/defineEmits macros are no dependency.
    expect(fileUses).toEqual([
      "/w/Parent.vue:save REFERENCES@19",
      "./utils/format:track REFERENCES@19",
      "./Child.vue:default REFERENCES@19",
      "/w/Parent.vue:props REFERENCES@20",
      "./ChildRow.vue:default REFERENCES@20",
      "/w/Parent.vue:save call@21",
      "./utils/format:format call@21",
      "/w/Parent.vue:count REFERENCES@21",
      "/w/Parent.vue:LazyPanel REFERENCES@22",
    ]);
  });

  it("counts every script binding as used by a template it reads only in part", () => {
    const pug = '<script setup lang="ts">\nimport { format } from "./utils/format";\nconst label = "x";\n</script>\n\n<template lang="pug">\np {{ format(label) }}\n</template>\n';
    const fileUses = analyze("Pug.vue", pug).dependencies.filter((d) => d.sourceSymbolId === "/w/Pug.vue:(file)")
      .map((d) => `${d.targetSymbolId} ${d.relation}@${d.line}`);
    expect(fileUses).toEqual(["./utils/format:format REFERENCES@6", "/w/Pug.vue:label REFERENCES@6"]);
  });

  it("gives a template-only SFC and a static template no dependency", () => {
    expect(analyze("TemplateOnly.vue").dependencies).toEqual([]);
    expect(analyze("ChildRow.vue").dependencies).toEqual([]);
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
        // Each SFC with a template has a component node, named after the file, at its `<template>` element.
        "Child.vue#Child 8-10:0",
        "ChildRow.vue#ChildRow 0-2:0",
        "CompositionApi.vue#CompositionApi 12-14:0",
        "CompositionApi.vue#setup 5-8:2",
        "CompositionApi.vue#sum 6-6:10",
        "Malformed.vue#Malformed 0-2:0",
        "OptionsApi.vue#OptionsApi 0-2:0",
        "OptionsApi.vue#run 10-12:4",
        "Parent.vue#LazyPanel 8-8:6",
        "Parent.vue#Parent 16-24:0",
        "Parent.vue#save 11-13:9",
        "ScriptSetupJs.vue#ScriptSetupJs 0-2:0",
        "ScriptSetupJs.vue#twice 5-7:9",
        "ScriptSetupTs.vue#ScriptSetupTs 0-4:0",
        "ScriptSetupTs.vue#total 9-11:9",
        "TemplateOnly.vue#TemplateOnly 0-2:0",
        "TsxSetup.vue#Badge 3-3:6",
        "TwoBlocks.vue#TwoBlocks 4-6:0",
        "TwoBlocks.vue#capped 11-13:9",
        "UnusedImport.vue#UnusedImport 4-6:0",
        "format.ts#format 0-2:16",
        "format.ts#track 4-4:16",
        "math.ts#add 0-2:16",
      ]);
      // The alias + barrel import (`@/utils`) and the tsx block resolve like the others.
      expect(harness.describe(indexer).edges.sort()).toEqual([
        "CompositionApi.vue#CompositionApi -CALLS@13-> CompositionApi.vue#sum",
        "CompositionApi.vue#sum -CALLS@6-> utils/math.ts#add",
        "OptionsApi.vue#OptionsApi -REFERENCES@1-> OptionsApi.vue#run",
        "OptionsApi.vue#run -CALLS@11-> utils/math.ts#add",
        // defineAsyncComponent(() => import('./ChildRow.vue')) loads ChildRow's component, like React's lazy().
        "Parent.vue#LazyPanel -REFERENCES@8-> ChildRow.vue#ChildRow",
        // `save()` calls, `@save="save"` passes: one edge per relation. The v-for `format` alias, the
        // `<Transition>` built-in, the unbound `<GlobalWidget>` and the defineProps/defineEmits macros link nowhere.
        "Parent.vue#Parent -CALLS@20-> Parent.vue#save",
        "Parent.vue#Parent -CALLS@20-> utils/format.ts#format",
        "Parent.vue#Parent -REFERENCES@18-> Child.vue#Child",
        "Parent.vue#Parent -REFERENCES@18-> Parent.vue#save",
        "Parent.vue#Parent -REFERENCES@18-> utils/format.ts#track",
        "Parent.vue#Parent -REFERENCES@19-> ChildRow.vue#ChildRow",
        "Parent.vue#Parent -REFERENCES@21-> Parent.vue#LazyPanel",
        "ScriptSetupJs.vue#ScriptSetupJs -CALLS@1-> ScriptSetupJs.vue#twice",
        "ScriptSetupJs.vue#twice -CALLS@6-> utils/math.ts#add",
        "ScriptSetupTs.vue#ScriptSetupTs -CALLS@2-> ScriptSetupTs.vue#total",
        "ScriptSetupTs.vue#total -CALLS@10-> utils/math.ts#add",
        "TsxSetup.vue#Badge -CALLS@3-> utils/math.ts#add",
        "TwoBlocks.vue#TwoBlocks -CALLS@5-> TwoBlocks.vue#capped",
        "TwoBlocks.vue#capped -CALLS@12-> utils/math.ts#add",
      ]);
    } finally {
      indexer.dispose();
    }
  });

  it("indexes a CRLF SFC at the same lines and columns", async () => {
    const { nodes, edges } = await harness.index({ "utils/math.ts": CORPUS["utils/math.ts"], "Crlf.vue": crlf("ScriptSetupTs.vue") });

    expect(nodes.find((n) => n.key === "Crlf.vue#total")).toMatchObject({ startLine: 9, endLine: 11 });
    expect(nodes.find((n) => n.key === "Crlf.vue#Crlf")).toMatchObject({ startLine: 0, endLine: 4 });
    expect(edges.sort()).toEqual(["Crlf.vue#Crlf -CALLS@2-> Crlf.vue#total", "Crlf.vue#total -CALLS@10-> utils/math.ts#add"]);
  });

  it("indexes a Svelte SFC (block regex) at its .svelte lines", async () => {
    const svelte = '<script context="module">\n  export const prerender = true;\n</script>\n\n<h1>{title}</h1>\n\n<script lang="ts">\n  import { add } from "./utils/math";\n  function shout(): number {\n    return add(1, 2);\n  }\n</script>\n\n{#if title}<p>{shout()}</p>{/if}\n';
    const { nodes, edges } = await harness.index({ "utils/math.ts": CORPUS["utils/math.ts"], "Page.svelte": svelte });

    expect(nodes.find((n) => n.key === "Page.svelte#shout")).toMatchObject({ startLine: 8, endLine: 10 });
    expect(edges).toEqual(["Page.svelte#shout -CALLS@9-> utils/math.ts#add"]);
  });

  it("never links a compiler macro, even to a same-named workspace function", async () => {
    const sfc = '<script setup lang="ts">\nfunction props() {\n  return withDefaults(defineProps<{ a?: number }>(), { a: 1 });\n}\n</script>\n<template>\n  <p>{{ props() }}</p>\n</template>\n';
    const { edges } = await harness.index({ "utils/macros.ts": "export function defineProps() {}\nexport function withDefaults() {}\n", "Macro.vue": sfc });

    expect(edges).toEqual(["Macro.vue#Macro -CALLS@6-> Macro.vue#props"]);
  });

  it("links a template use of a type-only or unresolvable import nowhere", async () => {
    const sfc = '<script setup lang="ts">\nimport type Child from "./Child.vue";\nimport Missing from "./Missing.vue";\n</script>\n<template>\n  <Child /><Missing />\n</template>\n';
    const { edges } = await harness.index({ "Child.vue": CORPUS["Child.vue"], "Types.vue": sfc });

    expect(edges).toEqual([]);
  });

  it("follows a template edit and a changed component import on re-index, without stale edges", async () => {
    const indexer = await harness.newIndexer();
    try {
      const files = { "Child.vue": CORPUS["Child.vue"], "ChildRow.vue": CORPUS["ChildRow.vue"] };
      await harness.indexInto(indexer, { ...files, "Host.vue": '<script setup>\nimport Child from "./Child.vue";\n</script>\n<template>\n  <Child />\n</template>\n' });
      expect(harness.describe(indexer).edges).toEqual(["Host.vue#Host -REFERENCES@4-> Child.vue#Child"]);

      await harness.indexInto(indexer, { "Host.vue": '<script setup>\nimport Row from "./ChildRow.vue";\n</script>\n<template>\n  <p />\n  <Row />\n</template>\n' });
      expect(harness.describe(indexer).edges).toEqual(["Host.vue#Host -REFERENCES@5-> ChildRow.vue#ChildRow"]);
    } finally {
      indexer.dispose();
    }
  });

  it("marks the SFC component node Vue in the database, and links the uses of an HTML <template src> at its element", async () => {
    const indexer = await harness.newIndexer();
    try {
      // Not a call graph language: written beside the indexed files, read by the `.vue` that names it.
      fs.writeFileSync(path.join(harness.root, "card.html"), "<div>\n  <Child />\n</div>\n");
      await harness.indexInto(indexer, {
        "Child.vue": CORPUS["Child.vue"],
        "Card.vue": '<script setup>\nimport Child from "./Child.vue";\n</script>\n<template src="./card.html"></template>\n',
        "plain.ts": "export function plain(): void {}\n",
      });
      const framed = indexer.getIndexSnapshot().nodes.filter((n) => n.framework).map((n) => `${path.basename(n.path)}#${n.name} ${n.framework}`);
      expect(framed.sort()).toEqual(["Card.vue#Card vue", "Child.vue#Child vue"]);
      expect(harness.describe(indexer).edges).toEqual(["Card.vue#Card -REFERENCES@3-> Child.vue#Child"]);
    } finally {
      indexer.dispose();
    }
  });

  it("resolves defineAsyncComponent(() => import('./X.vue')) in a plain module too, like React's lazy()", async () => {
    const routes = 'import { defineAsyncComponent } from "vue";\nexport const LazyRow = defineAsyncComponent(() => import("./ChildRow.vue"));\n';
    const { edges } = await harness.index({ "ChildRow.vue": CORPUS["ChildRow.vue"], "routes.ts": routes });

    expect(edges).toEqual(["routes.ts#LazyRow -REFERENCES@1-> ChildRow.vue#ChildRow"]);
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
    fs.writeFileSync(path.join(root, "Pug.vue"), '<script setup lang="ts">\nimport { format } from "./utils/format";\n</script>\n<template lang="pug">\np {{ format(1) }}\n</template>\n');
    fs.writeFileSync(path.join(root, "Ext.vue"), '<script setup lang="ts">\nimport { format } from "./utils/format";\nimport { add } from "./utils/math";\n</script>\n<template src="./ext.html"></template>\n');
    fs.writeFileSync(path.join(root, "ext.html"), "<p>{{ format(1) }}</p>\n");
    fs.writeFileSync(path.join(root, "Page.svelte"), '<script>\n  import { format } from "./utils/format";\n  export const unused = 1;\n</script>\n<p>{format(1)}</p>\n');
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

  it("credits an export or a component used only by a template", async () => {
    expect(await spider.findUnusedSymbols(file("utils/format.ts"))).toEqual([]);
    expect(await spider.verifyDependencyUsage(file("Parent.vue"), file("utils/format.ts"))).toBe(true);
    const batch = await spider.verifyDependencyUsageBatch(file("Parent.vue"), [file("Child.vue"), file("ChildRow.vue"), file("utils/format.ts")]);
    expect([...batch.values()]).toEqual([true, true, true]);
  });

  it("reads an external <template src> in the AST worker too: an import only the HTML uses is used, another is not (#646)", async () => {
    const batch = await spider.verifyDependencyUsageBatch(file("Ext.vue"), [file("utils/format.ts"), file("utils/math.ts")]);
    expect([...batch.values()]).toEqual([true, false]);
  });

  it("reports an import that neither the script nor the template uses", async () => {
    expect(await spider.verifyDependencyUsage(file("UnusedImport.vue"), file("utils/format.ts"))).toBe(false);
    const batch = await spider.verifyDependencyUsageBatch(file("UnusedImport.vue"), [file("utils/format.ts")]);
    expect([...batch.values()]).toEqual([false]);
  });

  it("treats a .vue default export as an entry point, and checks its other exports", async () => {
    expect(await spider.findUnusedSymbols(file("OptionsApi.vue"))).toEqual([]);
    // CHILD_VERSION is exported from a plain <script> block and used by nobody; the setup block passes LIMIT.
    expect((await spider.findUnusedSymbols(file("Child.vue"))).map((s) => s.name)).toEqual(["CHILD_VERSION"]);
    expect(await spider.findUnusedSymbols(file("TwoBlocks.vue"))).toEqual([]);
  });

  it("keeps an import used by a template read only in part (pug) used", async () => {
    expect(await spider.verifyDependencyUsage(file("Pug.vue"), file("utils/format.ts"))).toBe(true);
  });

  it("keeps Svelte conservative: its markup is not analyzed", async () => {
    expect(await spider.verifyDependencyUsage(file("Page.svelte"), file("utils/format.ts"))).toBe(true);
    expect(await spider.findUnusedSymbols(file("Page.svelte"))).toEqual([]);
  });
});
