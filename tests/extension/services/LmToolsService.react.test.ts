/**
 * The native VS Code LM tools report the React corpus like the MCP tools and the CLI (#575): same targets,
 * relations and lines, from a real Spider (trace, callers, impact) and a real call graph index.
 */
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
import type { GraphProvider } from "@/extension/GraphProvider";
import { LmToolsService } from "@/extension/services/LmToolsService";
import { createTreeSitterHarness } from "../../analyzer/callgraph/treeSitterHarness";
import { REACT_CORPUS, REACT_CORPUS_EDGES } from "../../analyzer/react/reactCorpus";

const SOURCES = [...new Set(REACT_CORPUS_EDGES.map((edge) => edge.split(" ")[0]))];

describe("native LM tools on the React corpus (#575)", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
  let indexer: CallGraphIndexer;
  let spider: Spider;

  // The LM tools already answer with workspace-relative paths.
  const rel = (file: string) => (path.isAbsolute(file) ? path.relative(state.root, file) : file).replaceAll("\\", "/");
  async function invoke<T>(tool: string, input: Record<string, unknown>): Promise<T> {
    const result = await state.tools.get(tool)!.invoke({ input }, {});
    return JSON.parse(result.content[0].value) as T;
  }

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
  });
  afterAll(async () => {
    indexer.dispose();
    await spider.dispose();
    await harness.dispose();
  });

  it("returns the corpus edges from the call graph tool and the trace tool alike", async () => {
    const callGraph: string[] = [];
    const trace: string[] = [];
    for (const key of SOURCES) {
      const [file, symbolName] = key.split("#");
      const filePath = path.join(harness.root, file);
      const { callees } = await invoke<{ callees: Array<{ relation: string; sourceLine: number; sourceName: string; sourceFile: string; targetName: string; targetFile: string }> }>(
        "graph-it-live_query_call_graph", { filePath, symbolName, direction: "callees", depth: 1 });
      // The LM tool returns every relation; USES is type-only, outside the shared runtime baseline.
      for (const e of callees.filter((c) => c.relation !== "USES")) {
        callGraph.push(`${rel(e.sourceFile)}#${e.sourceName} -${e.relation}@${e.sourceLine + 1}-> ${rel(e.targetFile)}#${e.targetName}`);
      }
      const { callChain } = await invoke<{ callChain: Array<{ calledSymbolId: string; resolvedRelativePath: string | null; line?: number; relation?: string }> }>(
        "graph-it-live_trace_function_execution", { filePath, symbolName, maxDepth: 1 });
      for (const e of callChain.filter((c) => c.resolvedRelativePath?.startsWith("src/"))) {
        trace.push(`${key} -${e.relation ?? "CALLS"}@${e.line}-> ${e.resolvedRelativePath}#${e.calledSymbolId.split(":").pop()}`);
      }
    }

    expect(callGraph.sort()).toEqual([...REACT_CORPUS_EDGES].sort());
    expect(trace.sort()).toEqual([...REACT_CORPUS_EDGES].sort());
  });

  it("labels JSX consumers as references in the callers and impact tools", async () => {
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
