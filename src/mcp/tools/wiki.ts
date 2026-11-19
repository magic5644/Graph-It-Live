import * as path from "node:path";
import { workerState } from "../shared/state.js";
import type { WikiGenerateResult } from "../../shared/wiki-types.js";
import { normalizePath } from "../../shared/path.js";
import { validateWorkspacePath } from "../../shared/pathSecurity.js";

// NO vscode imports — VS Code agnostic

import type { GenerateWikiParams } from "../types.js";

export { GenerateWikiParamsSchema as GenerateWikiSchema, type GenerateWikiParams } from "../types.js";

export interface GenerateWikiMcpResult {
  articlesCount: number;
  /** Relative to workspaceRoot — e.g. "wiki/index.md" */
  indexPath: string;
  /** Relative to workspaceRoot — e.g. "wiki/articles" */
  articlesDir: string;
  topHubs: Array<{ name: string; score: number }>;
  /** Human-readable description of applied scope/exclusion rules. */
  scopeNote?: string;
}

// ---------------------------------------------------------------------------
// Lazy call graph initialization (same pattern as query.ts)
// ---------------------------------------------------------------------------

async function ensureCallGraphReady(workspaceRoot: string): Promise<void> {
  if (
    workerState.callGraphIndexer &&
    workerState.callGraphIndexedRoot === workspaceRoot
  ) {
    return;
  }

  const { executeQueryCallGraph } = await import("./callgraph.js");
  try {
    await executeQueryCallGraph({
      filePath: workspaceRoot,
      symbolName: "__init_only__",
      direction: "both",
      depth: 1,
    });
  } catch {
    // Ignore — we only need the side-effect of initializing the indexer
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * @param overwrite - replace existing files that the wiki did not generate; the
 *   CLI's `--force`, never exposed to MCP clients.
 */
export async function executeGenerateWiki(
  params: GenerateWikiParams,
  overwrite = false,
): Promise<GenerateWikiMcpResult> {
  const config = workerState.getConfig();
  const workspaceRoot = normalizePath(config.rootDir);

  await ensureCallGraphReady(workspaceRoot);

  const indexer = workerState.callGraphIndexer;
  if (!indexer) {
    throw new Error(
      "Call graph indexer not initialized. The workspace may not have supported source files.",
    );
  }

  // Checked here, not only in the MCP worker, because the CLI calls this directly.
  const resolvedOutputDir = normalizePath(
    validateWorkspacePath(params.outputDir ?? "wiki", workspaceRoot),
  );

  const { WikiGenerator } = await import(
    "../../analyzer/wiki/WikiGenerator.js"
  );

  const generator = new WikiGenerator({
    db: indexer.getDb(),
    outputDir: resolvedOutputDir,
    workspaceRoot,
    topHubsLimit: params.topHubsLimit ?? 10,
    scope: params.scope,
    exclude: params.exclude,
    overwrite,
  });

  const result: WikiGenerateResult = await generator.generate();

  // Constraint #0: return relative paths to workspaceRoot
  return {
    articlesCount: result.articlesCount,
    indexPath: path.relative(workspaceRoot, result.indexPath).replaceAll("\\", "/"),
    articlesDir: path.relative(workspaceRoot, result.articlesDir).replaceAll("\\", "/"),
    topHubs: result.topHubs,
    scopeNote: result.scopeNote,
  };
}
