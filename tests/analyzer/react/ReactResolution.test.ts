import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Spider } from "@/analyzer/Spider";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness, writeFiles } from "../callgraph/treeSitterHarness";
import { REACT_CORPUS, REACT_CORPUS_EDGES } from "./reactCorpus";

type Harness = Awaited<ReturnType<typeof createTreeSitterHarness>>;

/** `src/x.tsx#Name` of an absolute symbol id (`/abs/src/x.tsx:Name`), or null outside `root`. */
function symbolKey(root: string, symbolId: string): string | null {
  const colon = symbolId.lastIndexOf(":");
  const file = normalizePath(symbolId.slice(0, colon));
  if (!file.startsWith(`${normalizePath(root)}/`) || file.includes("/node_modules/")) return null;
  return `${path.relative(root, file).replaceAll("\\", "/")}#${symbolId.slice(colon + 1)}`;
}

/** Corpus edges as the ts-morph pipeline (trace) reports them, one hop from every top-level symbol. */
async function tsMorphEdges(spider: Spider, root: string): Promise<string[]> {
  const edges: string[] = [];
  for (const file of Object.keys(REACT_CORPUS)) {
    const filePath = normalizePath(path.join(root, file));
    const { symbols } = await spider.getSymbolGraph(filePath);
    for (const symbol of symbols.filter((s) => !s.parentSymbolId)) {
      const { callChain } = await spider.traceFunctionExecution(filePath, symbol.name, 1);
      for (const entry of callChain) {
        const target = symbolKey(root, entry.calledSymbolId);
        if (target) edges.push(`${symbolKey(root, entry.callerSymbolId)} -${entry.relation ?? "CALLS"}@${entry.line}-> ${target}`);
      }
    }
  }
  return edges.sort();
}

/**
 * Corpus edges as the tree-sitter call graph stores them, with 1-based lines like the symbol pipeline.
 * Type-only USES edges (a class name is a type) are not part of the runtime baseline both pipelines share.
 */
function treeSitterEdges(edges: string[]): string[] {
  return edges
    .map((edge) => edge.replace(/@(\d+)->/, (_match, line: string) => `@${Number(line) + 1}->`))
    .filter((edge) => !edge.includes(" -USES@"))
    .sort();
}

describe("React component resolution is the same in both analyzer pipelines (#575)", () => {
  let harness: Harness;
  let spider: Spider;

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-react-");
    await writeFiles(harness.root, REACT_CORPUS);
    spider = new SpiderBuilder().withRootDir(harness.root).withReverseIndex(true).build();
    await spider.buildFullIndex();
  });
  afterAll(async () => {
    await spider.dispose?.();
    await harness.dispose();
  });

  it("links every component, hook, handler and render prop of the corpus in the call graph", async () => {
    const { edges } = await harness.index(REACT_CORPUS);

    expect(treeSitterEdges(edges)).toEqual([...REACT_CORPUS_EDGES].sort());
  });

  it("traces the same targets, relations and lines with the symbol analyzer", async () => {
    expect(await tsMorphEdges(spider, harness.root)).toEqual([...REACT_CORPUS_EDGES].sort());
  });

  it("names a default-exported component by its declared name, keeping its default export kind", async () => {
    const { symbols } = await spider.getSymbolGraph(path.join(harness.root, "src/ui/Card.tsx"));

    expect(symbols.map((s) => [s.name, s.isExported, s.isDefaultExport ?? false])).toEqual([
      ["Card", true, false],
      ["Panel", true, true],
    ]);
  });

  it("lists JSX-only consumers as dependents through barrels, default imports and lazy(), labelled as references", async () => {
    const dependents = (file: string, name: string) => spider.getSymbolDependents(path.join(harness.root, file), name)
      .then((deps) => deps.map((d) => `${symbolKey(harness.root, d.sourceSymbolId)}:${d.relation ?? "CALLS"}`).sort());

    expect(await dependents("src/ui/Card.tsx", "Card")).toEqual([
      "src/Fancy.tsx#Fancy:REFERENCES",
      "src/Old.jsx#Old:REFERENCES",
      "src/Page.tsx#Page:REFERENCES",
    ]);
    expect(await dependents("src/ui/Card.tsx", "Panel")).toEqual(["src/Page.tsx#Lazy:REFERENCES", "src/Page.tsx#Page:REFERENCES"]);
    expect(await dependents("src/hooks.js", "save")).toEqual(["src/Page.tsx#Page:REFERENCES"]);
    expect(await dependents("src/hooks.js", "track")).toEqual(["src/Page.tsx#Page:CALLS"]);
  });

  it("never reports a component consumed only through JSX as unused", async () => {
    const unused = async (file: string) => (await spider.findUnusedSymbols(path.join(harness.root, file))).map((s) => s.name);

    expect(await unused("src/ui/Card.tsx")).toEqual([]);
    expect(await unused("src/Fancy.tsx")).toEqual([]);
    expect(await unused("src/ui/Button.jsx")).toEqual([]);
    expect(await unused("src/other.tsx")).toEqual(["Missing"]);
  });
});

describe("trace targets of imports whose declaration cannot be found (#575)", () => {
  let root: string;
  let spider: Spider;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-trace-")));
    await writeFiles(root, {
      "cjs.js": "module.exports = { legacy() {} };\n",
      "es.ts": "export function kept() {}\n",
      "Panel.tsx": "export default function Panel() { return null; }\n",
      "barrel.ts": "export * from './es';\n",
      "app.ts": `import { legacy } from './cjs';
import { kept, gone } from './es';
import { Panel } from './Panel';
import { lost } from './barrel';
export function app() { legacy(); kept(); gone(); Panel(); lost(); }
`,
    });
    spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
  });
  afterAll(async () => {
    await spider.dispose?.();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps a CommonJS module as target and reports a name missing from an ES module or barrel as unresolved", async () => {
    const { callChain } = await spider.traceFunctionExecution(path.join(root, "app.ts"), "app", 1);

    expect(callChain.map((e) => [e.calledSymbolId.split(":").pop(), e.resolvedFilePath && path.relative(root, e.resolvedFilePath)])).toEqual([
      ["legacy", "cjs.js"],
      ["kept", "es.ts"],
      ["gone", null],
      ["Panel", null],
      ["lost", null],
    ]);
  });
});
