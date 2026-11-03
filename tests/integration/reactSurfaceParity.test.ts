/**
 * Surface parity on the shared React corpus (#591): the CLI binary, the MCP tools and the native VS Code LM tools
 * answer the same documented queries with the same targets, relations (CALLS, REFERENCES, USES) and positions.
 * Each surface builds its own index of the corpus, the way it does in production.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  tools: new Map<string, { invoke: (options: unknown, token: unknown) => Promise<{ content: Array<{ value: string }> }> }>(),
}));

vi.mock("vscode", () => {
  class LanguageModelTextPart { constructor(public readonly value: string) {} }
  class LanguageModelToolResult { constructor(public readonly content: LanguageModelTextPart[]) {} }
  return {
    lm: { registerTool: (name: string, handler: never) => { state.tools.set(name, handler); return { dispose() {} }; } },
    workspace: { get workspaceFolders() { return [{ uri: { fsPath: state.root } }]; } },
    LanguageModelTextPart,
    LanguageModelToolResult,
    CancellationError: class extends Error {},
  };
});

import type { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import type { Spider } from "@/analyzer/Spider";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import type { CliRuntime } from "@/cli/runtime";
import type { GraphProvider } from "@/extension/GraphProvider";
import { LmToolsService } from "@/extension/services/LmToolsService";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { executeTraceFunctionExecution } from "@/mcp/tools/execution";
import { QueryCallGraphParamsSchema } from "@/mcp/types";
import { createTreeSitterHarness } from "../analyzer/callgraph/treeSitterHarness";
import { REACT_CORPUS, REACT_CORPUS_EDGES } from "../analyzer/react/reactCorpus";
import { indexWorkspace, REPO_ROOT, wasmBuilt } from "../mcp/tools/callGraphWorkspace";

const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const SOURCES = [...new Set(REACT_CORPUS_EDGES.map((edge) => edge.split(" ")[0]))];
/** Every corpus symbol with an edge, plus a component no file declares under that name (not_found). */
const SYMBOLS = [...new Set(REACT_CORPUS_EDGES.flatMap((edge) => [edge.split(" ")[0], edge.split(" ").at(-1)!])), "src/Page.tsx#Missing"].sort();
/** Every relation the call graph documents; the default filter of each surface is checked too. */
const RELATIONS = ["CALLS", "REFERENCES", "USES"];

interface CallEdge { relation: string; sourceLine: number; sourceName: string; sourceFile: string; targetName: string; targetFile: string }
interface CallGraphAnswer {
  symbol: { name: string; filePath: string; startLine: number; endLine: number } | null;
  reason?: string;
  callers: CallEdge[];
  callees: CallEdge[];
}
interface TraceAnswer { callChain: Array<{ calledSymbolId: string; resolvedRelativePath: string | null; line?: number; relation?: string }> }

/** One surface: its workspace root and the two documented queries. */
interface Surface {
  root: string;
  /** query_call_graph; without `relationTypes`, the surface's documented default filter. */
  callGraph(filePath: string, symbolName: string, relationTypes?: string[]): Promise<CallGraphAnswer>;
  trace(filePath: string, symbolName: string): Promise<TraceAnswer>;
}

/** Workspace-relative path; the LM tools may already answer with one. */
const relativeTo = (root: string, file: string) => (path.isAbsolute(file) ? path.relative(root, file) : file).replaceAll("\\", "/");

/** `fn` over `items` one after the other: the CLI surface spawns one process per query. */
const inSequence = <T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> =>
  items.reduce<Promise<R[]>>(async (done, item) => [...(await done), await fn(item)], Promise.resolve([]));

/** Every answer of a surface as `query: fact` lines, with 1-based lines and workspace-relative paths. */
async function answers(surface: Surface, relationTypes?: string[]): Promise<string[]> {
  const rel = (file: string) => relativeTo(surface.root, file);
  const edge = (e: CallEdge) => `${rel(e.sourceFile)}#${e.sourceName} -${e.relation}@${e.sourceLine + 1}-> ${rel(e.targetFile)}#${e.targetName}`;
  const split = (key: string) => key.split("#") as [string, string];
  const graphs = await inSequence(SYMBOLS, async (key) => {
    const [file, symbolName] = split(key);
    const graph = await surface.callGraph(path.join(surface.root, file), symbolName, relationTypes);
    const { symbol } = graph;
    return [
      `${key} symbol: ${symbol ? `${rel(symbol.filePath)}#${symbol.name}@${symbol.startLine + 1}-${symbol.endLine + 1}` : graph.reason}`,
      ...graph.callers.map((e) => `${key} caller: ${edge(e)}`),
      ...graph.callees.map((e) => `${key} callee: ${edge(e)}`),
    ];
  });
  const traces = await inSequence(SOURCES, async (key) => {
    const [file, symbolName] = split(key);
    const { callChain } = await surface.trace(path.join(surface.root, file), symbolName);
    return callChain
      .filter((e) => e.resolvedRelativePath?.startsWith("src/"))
      .map((e) => `${key} trace: -${e.relation ?? "CALLS"}@${e.line}-> ${e.resolvedRelativePath}#${e.calledSymbolId.split(":").pop()}`);
  });
  return [...graphs, ...traces].flat().sort();
}

describe.skipIf(!wasmBuilt || !fs.existsSync(DIST_ENTRY))("React corpus parity across CLI, MCP and LM tools (#591)", { timeout: 300_000 }, () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
  let indexer: CallGraphIndexer;
  let spider: Spider;
  let mcp: { tmpDir: string; runtime: CliRuntime };

  async function invoke<T>(tool: string, input: Record<string, unknown>): Promise<T> {
    const result = await state.tools.get(tool)!.invoke({ input }, {});
    return JSON.parse(result.content[0].value) as T;
  }

  const lmSurface = (): Surface => ({
    root: harness.root,
    callGraph: (filePath, symbolName, relationTypes) => invoke("graph-it-live_query_call_graph", { filePath, symbolName, direction: "both", depth: 1, relationTypes }),
    trace: (filePath, symbolName) => invoke("graph-it-live_trace_function_execution", { filePath, symbolName, maxDepth: 1 }),
  });
  const mcpSurface = (): Surface => ({
    root: mcp.tmpDir,
    callGraph: (filePath, symbolName, relationTypes) => executeQueryCallGraph({ filePath, symbolName, direction: "both", depth: 1, relationTypes: relationTypes as never }),
    trace: (filePath, symbolName) => executeTraceFunctionExecution({ filePath, symbolName, maxDepth: 1 }),
  });
  const cliSurface = (root: string): Surface => {
    const tool = <T>(name: string, ...args: string[]): Promise<T> => {
      const out = execFileSync(process.execPath, [DIST_ENTRY, "tool", name, ...args, "-w", root, "--format", "json"], {
        cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      });
      return Promise.resolve(JSON.parse(out.slice(out.indexOf("{"))) as T);
    };
    return {
      root,
      callGraph: (filePath, symbolName, relationTypes) => tool("query_call_graph", `--filePath=${filePath}`, `--symbolName=${symbolName}`,
        "--direction=both", "--depth=1", ...(relationTypes ? [`--relationTypes=${JSON.stringify(relationTypes)}`] : [])),
      trace: (filePath, symbolName) => tool("trace_function_execution", `--filePath=${filePath}`, `--symbolName=${symbolName}`, "--maxDepth=1"),
    };
  };

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-lm-react-");
    state.root = harness.root;
    indexer = await harness.newIndexer();
    await harness.indexInto(indexer, REACT_CORPUS);
    spider = new SpiderBuilder().withRootDir(harness.root).withReverseIndex(true).build();
    await spider.buildFullIndex();
    const provider = {
      getSpiderForLmTools: () => spider,
      getCallGraphViewServiceForLmTools: () => ({ getCallGraphIndexerForLmTools: () => indexer }),
    } as unknown as GraphProvider;
    new LmToolsService({ provider, logger: { info() {}, warn() {}, error() {}, debug() {} } as never }).registerAll();
    // indexWorkspace writes its files under src/.
    mcp = await indexWorkspace("react-parity-", Object.fromEntries(Object.entries(REACT_CORPUS).map(([name, source]) => [name.replace(/^src\//, ""), source])));
  });
  afterAll(async () => {
    indexer.dispose();
    await spider.dispose();
    await harness.dispose();
    await mcp.runtime.dispose();
    fs.rmSync(mcp.tmpDir, { recursive: true, force: true });
  });

  it("answers the same queries with the same targets, relations and positions on every surface", async () => {
    const lm = await answers(lmSurface(), RELATIONS);
    const runtimeOnly = lm.filter((line) => !line.includes(" -USES@"));
    const corpusEdges = runtimeOnly.filter((line) => line.includes(" callee: ")).map((line) => line.split(" callee: ")[1]).sort();

    expect(corpusEdges).toEqual([...REACT_CORPUS_EDGES].sort());
    // The only type-only use: a class component's name is also a type.
    expect(lm.filter((line) => line.includes(" -USES@"))).toEqual([
      "src/ui/Button.jsx#Button callee: src/ui/Button.jsx#Button -USES@2-> src/ui/Button.jsx#Button",
      "src/ui/Button.jsx#Button caller: src/ui/Button.jsx#Button -USES@2-> src/ui/Button.jsx#Button",
    ]);
    expect(lm).toContain("src/Page.tsx#Missing symbol: not_found");
    expect(await answers(mcpSurface(), RELATIONS)).toEqual(lm);
    // Documented defaults: the LM tool returns every relation, MCP and the CLI add USES only on request.
    expect(await answers(lmSurface())).toEqual(lm);
    expect(await answers(mcpSurface())).toEqual(runtimeOnly);
    // The CLI indexes in its own process, on a copy of the MCP workspace.
    const cliRoot = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(mcp.tmpDir), "react-cli-")));
    try {
      fs.cpSync(path.join(mcp.tmpDir, "src"), path.join(cliRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(cliRoot, "package.json"), "{}");
      expect(await answers(cliSurface(cliRoot), RELATIONS)).toEqual(lm);
      expect(await answers(cliSurface(cliRoot))).toEqual(runtimeOnly);
    } finally {
      fs.rmSync(cliRoot, { recursive: true, force: true });
    }
  });

  it("labels JSX consumers as references in the LM callers and impact tools", async () => {
    const filePath = path.join(harness.root, "src/ui/Card.tsx");
    const callers = await invoke<{ callers: Array<{ callerRelativePath: string; callerSymbolId: string; relation: string; line: number }>; referenceCallerCount: number }>(
      "graph-it-live_get_symbol_callers", { filePath, symbolName: "Card" });
    const impact = await invoke<{ impactedItems: Array<{ relativePath: string; symbolId: string; relation?: string; usageType: string }> }>(
      "graph-it-live_get_impact_analysis", { filePath, symbolName: "Card" });

    expect(callers.callers.map((c) => `${c.callerSymbolId.split(":").pop()}:${c.relation}@${c.line + 1}`).sort()).toEqual([
      "Fancy:REFERENCES@3",
      "Old:REFERENCES@2",
      "Page:REFERENCES@14",
    ]);
    expect(callers.referenceCallerCount).toBe(3);
    expect(impact.impactedItems.map((i) => `${i.relativePath}:${i.relation}:${i.usageType}`).sort()).toEqual([
      "src/Fancy.tsx:REFERENCES:runtime",
      "src/Old.jsx:REFERENCES:runtime",
      "src/Page.tsx:REFERENCES:runtime",
    ]);
  });
});

// Needs no build: read from package.json and the MCP schema.
describe("query_call_graph schemas (#591)", () => {
  it("documents the same relation types in the LM tool schema as in the MCP schema", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      contributes: { languageModelTools: Array<{ name: string; inputSchema: { properties: { relationTypes?: { items: { enum: string[] } } } } }> };
    };
    const lmTool = manifest.contributes.languageModelTools.find((tool) => tool.name === "graph-it-live_query_call_graph");
    const lmRelations = lmTool?.inputSchema.properties.relationTypes?.items.enum;

    expect([...(lmRelations ?? [])].sort()).toEqual([...QueryCallGraphParamsSchema.shape.relationTypes.unwrap().element.options].sort());
  });
});
