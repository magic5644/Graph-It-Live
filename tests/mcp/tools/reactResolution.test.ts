/**
 * React resolution through the MCP tools the CLI and the LM tools share (#575): query_call_graph (tree-sitter)
 * and trace_function_execution / get_impact_analysis (ts-morph) report the corpus edges with the same targets,
 * relations and lines, after incremental updates and from a restored (warm) index too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { executeTraceFunctionExecution } from "@/mcp/tools/execution";
import { executeGetImpactAnalysis } from "@/mcp/tools/impact";
import { executeScanDeadCode } from "@/mcp/tools/deadcode";
import { executeInvalidateFiles } from "@/mcp/tools/workspace";
import { REACT_CORPUS, REACT_CORPUS_EDGES } from "../../analyzer/react/reactCorpus";
import { indexWorkspace, REPO_ROOT, wasmBuilt } from "./callGraphWorkspace";

/** Corpus files relative to `src/`, as indexWorkspace writes them. */
const FILES = Object.fromEntries(Object.entries(REACT_CORPUS).map(([name, source]) => [name.replace(/^src\//, ""), source]));
const SOURCES = [...new Set(REACT_CORPUS_EDGES.map((edge) => edge.split(" ")[0]))];

describe.skipIf(!wasmBuilt)("React resolution through the MCP tools (#575)", { timeout: 60_000 }, () => {
  let tmpDir: string;
  let runtime: CliRuntime;

  const abs = (relative: string) => path.join(tmpDir, relative);
  const rel = (file: string) => path.relative(tmpDir, file).replaceAll("\\", "/");
  const split = (key: string) => key.split("#") as [string, string];

  /** Corpus sources whose file still exists. */
  const sources = () => SOURCES.filter((key) => fs.existsSync(abs(split(key)[0])));

  /** Callees of every corpus source from query_call_graph's default filter, with 1-based lines. */
  async function callGraphEdges(): Promise<string[]> {
    const perSource = await Promise.all(sources().map(async (key) => {
      const [file, symbolName] = split(key);
      const { callees } = await executeQueryCallGraph({ filePath: abs(file), symbolName, direction: "callees", depth: 1 });
      return callees.map((e) => `${rel(e.sourceFile)}#${e.sourceName} -${e.relation}@${e.sourceLine + 1}-> ${rel(e.targetFile)}#${e.targetName}`);
    }));
    return perSource.flat().sort();
  }

  /** One-hop trace of every corpus source, workspace targets only. */
  async function traceEdges(): Promise<string[]> {
    const perSource = await Promise.all(sources().map(async (key) => {
      const [file, symbolName] = split(key);
      const { callChain } = await executeTraceFunctionExecution({ filePath: abs(file), symbolName, maxDepth: 1 });
      return callChain
        .filter((e) => e.resolvedRelativePath?.startsWith("src/"))
        .map((e) => `${key} -${e.relation ?? "CALLS"}@${e.line}-> ${e.resolvedRelativePath}#${e.calledSymbolId.split(":").pop()}`);
    }));
    return perSource.flat().sort();
  }

  /** Expected corpus edges with `from` targets replaced by `to` (null drops them). */
  const expectedWith = (from: string, to: string | null) =>
    REACT_CORPUS_EDGES.flatMap((edge) => {
      if (!edge.endsWith(` ${from}`)) return [edge];
      return to ? [edge.replace(` ${from}`, ` ${to}`)] : [];
    }).sort();

  /** Rewrite (or, with null, delete) corpus files, then invalidate them the way a file watcher does. */
  function edit(files: Record<string, string | null>): void {
    for (const [file, source] of Object.entries(files)) {
      if (source === null) fs.rmSync(abs(file));
      else fs.writeFileSync(abs(file), source);
    }
    executeInvalidateFiles({ filePaths: Object.keys(files).map(abs) });
  }

  beforeEach(async () => {
    ({ tmpDir, runtime } = await indexWorkspace("react-mcp-", FILES));
  });
  afterEach(async () => {
    await runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists JSX consumers as runtime references in get_impact_analysis", async () => {
    const { impactedItems, runtimeImpactCount, summary } = await executeGetImpactAnalysis({ filePath: abs("src/ui/Card.tsx"), symbolName: "Card" });

    expect(impactedItems.map((i) => `${i.relativePath}#${i.symbolId.split(":").pop()}:${i.relation}:${i.usageType}`).sort()).toEqual([
      "src/Fancy.tsx#Fancy:REFERENCES:runtime",
      "src/Old.jsx#Old:REFERENCES:runtime",
      "src/Page.tsx#Page:REFERENCES:runtime",
    ]);
    expect(runtimeImpactCount).toBe(3);
    expect(impactedItems.map((i) => `${i.relativePath}:${i.line}`).sort()).toEqual(["src/Fancy.tsx:3", "src/Old.jsx:2", "src/Page.tsx:14"]);
    expect(summary).toContain("props-contract compatibility is not checked");
  });

  it("keeps JSX-only corpus consumers out of dead code without crediting unresolved names", async () => {
    const result = await executeScanDeadCode({});
    const unused = result.entries.flatMap((entry) => entry.unusedSymbols.map((s) => `${rel(entry.filePath)}#${s.name}`));
    for (const key of ["src/ui/Card.tsx#Card", "src/ui/Card.tsx#Panel", "src/ui/Button.jsx#Button", "src/Fancy.tsx#Fancy", "src/Fancy.tsx#Field"]) {
      expect(unused).not.toContain(key);
    }
    expect(unused).toContain("src/other.tsx#Missing");
  });

  it.each(["jsx", "tsx"])("credits local JSX root references and default framework candidates in %s", async (extension) => {
    const file = `src/entry.${extension}`;
    edit({ [file]: `import { createRoot } from 'react-dom/client';
export function App() { return <main />; }
export function Unused() { return <aside />; }
export default function Route() { return <App />; }
createRoot(document.getElementById('root')).render(<App />);
` });
    await workerState.spider!.buildFullIndex();
    expect((await workerState.spider!.getSymbolGraph(abs(file))).symbols.filter((s) => s.isExported).map((s) => s.name)).toEqual(["App", "Unused", "Route"]);
    const unused = await workerState.spider!.findUnusedSymbols(abs(file));
    expect(unused.map((s) => s.name)).toEqual(["Unused"]);
  });

  it.each([
    { extension: "jsx", source: `export function Unused() { return <Unused />; }`, expected: ["Unused"] },
    { extension: "tsx", source: `export function Unused() { return <Unused />; }`, expected: ["Unused"] },
    { extension: "jsx", source: `export function Unused() { return null; }
function local(Unused) { return <Unused />; }`, expected: ["Unused"] },
    { extension: "tsx", source: `const value = 1; export default value;`, expected: ["value"] },
    { extension: "ts", source: `export default function Route() { return null; }`, expected: ["Route"] },
    { extension: "js", source: `export default function Route() { return null; }`, expected: ["Route"] },
  ])("does not invent an entry point or consumer for $source ($extension)", async ({ extension, source, expected }) => {
    const file = `src/unused.${extension}`;
    edit({ [file]: source });
    expect((await workerState.spider!.findUnusedSymbols(abs(file))).map((s) => s.name)).toEqual(expected);
  });

  it.each<{ title: string; files: Record<string, string | null>; expected: () => string[] }>([
    {
      title: "follows a renamed default export to its new name",
      files: { "src/ui/Card.tsx": "export function Card() { return <section />; }\nexport default function Board() { return <aside />; }\n" },
      expected: () => expectedWith("src/ui/Card.tsx#Panel", "src/ui/Card.tsx#Board"),
    },
    {
      title: "drops the edges to a removed component",
      files: { "src/ui/Card.tsx": "export default function Panel() { return <aside />; }\n" },
      expected: () => expectedWith("src/ui/Card.tsx#Card", null),
    },
    {
      title: "keeps barrel consumers linked when the component moves down a line",
      files: { "src/ui/Card.tsx": `// moved\n${REACT_CORPUS["src/ui/Card.tsx"]}` },
      expected: () => [...REACT_CORPUS_EDGES].sort(),
    },
    {
      title: "re-links an importer that renders another component",
      files: { "src/Old.jsx": "import Panel from './ui/Card';\nexport function Old() { return <div><Panel /></div>; }\n" },
      expected: () => REACT_CORPUS_EDGES
        .map((edge) => (edge.startsWith("src/Old.jsx#Old ") ? "src/Old.jsx#Old -REFERENCES@2-> src/ui/Card.tsx#Panel" : edge))
        .sort(),
    },
    {
      title: "drops the edges of a deleted importer",
      files: { "src/Old.jsx": null },
      expected: () => REACT_CORPUS_EDGES.filter((edge) => !edge.startsWith("src/Old.jsx#")).sort(),
    },
    {
      title: "leaves a component unresolved once its barrel exports it under another name",
      files: { "src/ui/index.ts": "export * from './Card';\nexport { Button as Btn } from './Button';\n" },
      expected: () => expectedWith("src/ui/Button.jsx#Button", null),
    },
  ])("$title after an incremental update, in both pipelines", async ({ files, expected }) => {
    edit(files);

    expect(await callGraphEdges()).toEqual(expected());
    expect(await traceEdges()).toEqual(expected());
  });

  it("returns the same edges from a restored index as from the cold one", async () => {
    const cold = await callGraphEdges();
    await runtime.dispose();

    runtime = new CliRuntime(tmpDir);
    await runtime.init();
    workerState.config = { ...workerState.getConfig(), extensionPath: REPO_ROOT };
    await runtime.ensureIndexed({ silent: true });

    expect(await callGraphEdges()).toEqual(cold);
    expect(cold).toEqual([...REACT_CORPUS_EDGES].sort());
  });
});
