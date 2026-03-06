import * as nodePath from "node:path";
import { LspCallHierarchyAnalyzer } from "../../analyzer/LspCallHierarchyAnalyzer";
import { detectLanguageFromExtension } from "../../shared/utils/languageDetection";
import { convertSpiderToLspFormat, getRelativePath, validateFileExists } from "../shared/helpers";
import { workerState } from "../shared/state";
import type { GenerateCodemapParams } from "../types";

// ============================================================================
// Result type
// ============================================================================

export interface GenerateCodemapResult {
  filePath: string;
  relativePath: string;
  language: string;
  /** Total line count */
  lineCount: number;

  /** Exported symbols (public API) */
  exports: CodemapSymbol[];
  /** Internal (non-exported) symbols */
  internals: CodemapSymbol[];

  /** Files this file imports */
  dependencies: CodemapDependency[];
  /** Files that import this file (reverse deps) */
  dependents: CodemapDependent[];

  /** Intra-file call flow edges (caller → callee) */
  callFlow: CodemapCallEdge[];
  /** Whether cycles were detected in the call flow */
  hasCycle: boolean;
  /** Symbol IDs involved in cycles */
  cycleSymbols: string[];

  analysisTimeMs: number;
}

interface CodemapSymbol {
  name: string;
  kind: string;
  line: number;
  category: string;
}

interface CodemapDependency {
  module: string;
  resolvedPath: string | null;
  relativePath: string | null;
  type: string;
  line: number;
}

interface CodemapDependent {
  path: string;
  relativePath: string;
  type: string;
  line: number;
}

interface CodemapCallEdge {
  caller: string;
  callee: string;
  line: number;
}

// ============================================================================
// Execution
// ============================================================================

export async function executeGenerateCodemap(
  params: GenerateCodemapParams,
): Promise<GenerateCodemapResult> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  const startTime = Date.now();

  await validateFileExists(filePath);

  const ext = nodePath.extname(filePath).toLowerCase();
  const language = detectLanguageFromExtension(ext);
  const relativePath = getRelativePath(filePath, config.rootDir);

  // --- 1. Line count (lightweight) ---
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(filePath, "utf-8");
  const lineCount = content.split("\n").length;

  // --- 2. Symbol graph (functions, classes, exports) ---
  const { symbols, dependencies: symbolDeps } =
    await spider.getSymbolGraph(filePath);

  const exports: CodemapSymbol[] = symbols
    .filter((s) => s.isExported)
    .map(toCodemapSymbol);
  const internals: CodemapSymbol[] = symbols
    .filter((s) => !s.isExported)
    .map(toCodemapSymbol);

  // --- 3. File-level dependencies (imports) ---
  const deps = await spider.analyze(filePath);
  const dependencies: CodemapDependency[] = deps.map((d) => ({
    module: d.module,
    resolvedPath: d.path,
    relativePath: d.path ? getRelativePath(d.path, config.rootDir) : null,
    type: d.type,
    line: d.line,
  }));

  // --- 4. Reverse dependencies (who imports this file) ---
  let dependents: CodemapDependent[] = [];
  try {
    const refs = await spider.findReferencingFiles(filePath);
    dependents = refs.map((r) => ({
      path: r.path,
      relativePath: getRelativePath(r.path, config.rootDir),
      type: r.type,
      line: r.line,
    }));
  } catch {
    // Reverse index may not be ready yet — non-fatal
  }

  // --- 5. Intra-file call flow ---
  let callFlow: CodemapCallEdge[] = [];
  let hasCycle = false;
  let cycleSymbols: string[] = [];

  try {
    const lspData = convertSpiderToLspFormat(
      { symbols, dependencies: symbolDeps },
      filePath,
    );
    const analyzer = new LspCallHierarchyAnalyzer();
    const graph = analyzer.buildIntraFileGraph(filePath, lspData);

    callFlow = graph.edges.map((e) => ({
      caller: stripFilePath(e.source),
      callee: stripFilePath(e.target),
      line: e.line,
    }));
    hasCycle = graph.hasCycle;
    cycleSymbols = (graph.cycleNodes ?? []).map(stripFilePath);
  } catch {
    // Call hierarchy analysis failed — non-fatal, return partial result
  }

  const analysisTimeMs = Date.now() - startTime;

  return {
    filePath,
    relativePath,
    language,
    lineCount,
    exports,
    internals,
    dependencies,
    dependents,
    callFlow,
    hasCycle,
    cycleSymbols,
    analysisTimeMs,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function toCodemapSymbol(s: {
  name: string;
  kind: string;
  line: number;
  category: string;
}): CodemapSymbol {
  return { name: s.name, kind: s.kind, line: s.line, category: s.category };
}

/** Strip the "filePath:" prefix from symbol IDs like "/a/b.ts:myFunc" → "myFunc" */
function stripFilePath(symbolId: string): string {
  const colonIndex = symbolId.lastIndexOf(":");
  return colonIndex >= 0 ? symbolId.slice(colonIndex + 1) : symbolId;
}
