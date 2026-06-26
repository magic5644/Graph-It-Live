import * as path from "node:path";
import { z } from "zod/v4";
import { workerState } from "../shared/state.js";
import type { WikiGenerateResult } from "../../shared/wiki-types.js";
import { normalizePath } from "../../shared/path.js";

// NO vscode imports — VS Code agnostic

export const GenerateWikiSchema = z.object({
  workspaceRoot: z
    .string()
    .optional()
    .describe(
      "Absolute path to workspace root. Defaults to the configured workspace.",
    ),
  outputDir: z
    .string()
    .optional()
    .describe(
      "Absolute path to wiki output directory. Defaults to <workspaceRoot>/wiki.",
    ),
  topHubsLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Number of top hub files to include (default: 10, max: 50)."),
  scope: z
    .string()
    .optional()
    .describe(
      "Relative path within workspace to restrict wiki to (e.g. 'src/'). Defaults to entire workspace.",
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      "Relative glob-like patterns to exclude (e.g. ['tests/**', '**/*.test.ts']). When omitted, default exclusions apply: tests/, dist/, *.test.ts, etc.",
    ),
});

export type GenerateWikiParams = z.infer<typeof GenerateWikiSchema>;

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

export async function executeGenerateWiki(
  params: GenerateWikiParams,
): Promise<GenerateWikiMcpResult> {
  const config = workerState.getConfig();
  const workspaceRoot = normalizePath(params.workspaceRoot ?? config.rootDir);

  await ensureCallGraphReady(workspaceRoot);

  const indexer = workerState.callGraphIndexer;
  if (!indexer) {
    throw new Error(
      "Call graph indexer not initialized. The workspace may not have supported source files.",
    );
  }

  const resolvedOutputDir = normalizePath(
    params.outputDir ?? path.join(workspaceRoot, "wiki"),
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
  });

  const result: WikiGenerateResult = await generator.generate();

  // Constraint #0: return relative paths to workspaceRoot
  return {
    articlesCount: result.articlesCount,
    indexPath: path.relative(workspaceRoot, result.indexPath).replace(/\\/g, "/"),
    articlesDir: path.relative(workspaceRoot, result.articlesDir).replace(/\\/g, "/"),
    topHubs: result.topHubs,
    scopeNote: result.scopeNote,
  };
}
