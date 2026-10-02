/**
 * CLI Command: query
 *
 * Query the codebase with natural language using the call graph index.
 * Returns human-readable text by default, or a TOON / JSON subgraph.
 *
 * Usage: graph-it query "<question>" [--depth N] [--token-budget N] [--format toon|json|text]
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as path from "node:path";
import { resolveLlmClient } from "../../analyzer/llm/LlmClientFactory.js";
import { executeQueryNaturalLanguage } from "../../mcp/tools";
import type { QueryNaturalLanguageParams } from "../../mcp/tools/query.js";
import { normalizePath } from "../../shared/path.js";
import { CliError, ExitCode } from "../errors.js";
import { readIntegerOption } from "../options.js";
import type { CliOutputFormat } from "../formatter.js";
import { relativizeWorkspacePaths } from "../formatter.js";
import type { CliRuntime } from "../runtime.js";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

function parseDepth(args: string[]): number {
  return readIntegerOption(args, "--depth", { min: 1, max: 5 }) ?? 2;
}

function parseTokenBudget(args: string[]): number {
  return readIntegerOption(args, "--token-budget", { min: 500, max: 16000 }) ?? 4000;
}

/** Flags that consume the next argument as their value. */
const FLAG_WITH_VALUE = new Set(["--depth", "--token-budget"]);

/**
 * Extract the question: all positional non-flag arguments joined as a sentence.
 * Supports both quoted single-arg form ("how does X work") and unquoted multi-word
 * form (how does X work) so REPL users don't need quotes.
 * Skips values that belong to known flags (e.g. --depth 3 → skip "3").
 */
function parseQuestion(args: string[]): string | undefined {
  const parts: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (FLAG_WITH_VALUE.has(arg)) {
        i += 2;
      } else {
        i += 1;
      }
    } else {
      parts.push(arg);
      i += 1;
    }
  }
  const joined = parts.join(" ").trim();
  return joined.length > 0 ? joined : undefined;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatTextOutput(
  result: Awaited<ReturnType<typeof executeQueryNaturalLanguage>>,
  workspaceRoot: string,
): string {
  const lines: string[] = [];
  lines.push(`Question: ${result.question}`, `Keywords: ${result.extractedKeywords.join(", ") || "(none)"}`, `Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
  if (result.meta.truncated) {
    lines.push("(result truncated — increase --token-budget for more)");
  }
  lines.push("");

  if (result.nodes && result.nodes.length > 0) {
    lines.push("Matching nodes:");
    for (const node of result.nodes) {
      const rel = normalizePath(path.relative(workspaceRoot, node.path));
      // Emit file:line so the next step is a targeted read rather than a grep.
      const location = node.startLine === undefined ? rel : `${rel}:${node.startLine}`;
      lines.push(`  - ${node.name} (${location})`);
    }
  } else if (result.toon) {
    lines.push(result.toon);
  } else {
    lines.push("(no nodes returned)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const question = parseQuestion(args);

  if (!question) {
    throw new CliError(
      'Usage: graph-it query "<question>" [--depth N] [--token-budget N] [--format toon|json|text]',
      ExitCode.GENERAL_ERROR,
    );
  }

  const depth = parseDepth(args);
  const tokenBudget = parseTokenBudget(args);
  // main() and the REPL strip --format from args and pass it here; formats
  // query cannot render (markdown, mermaid) fall back to text.
  const queryFormat = format === "json" || format === "toon" ? format : "text";

  await runtime.ensureIndexed();

  // Normalize workspaceRoot for cross-platform path usage
  const normalizedRoot = normalizePath(runtime.workspaceRoot);

  // Resolve an LLM for keyword extraction, and hint when none is available.
  const llmClient = await resolveLlmClient();
  if (llmClient === null) {
    process.stderr.write(
      "No LLM configured. Using keyword heuristic. " +
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or GRAPH_IT_LLM_PROVIDER=copilot-cli " +
        "to use the GitHub Copilot CLI, for better results.\n",
    );
  }

  const params: QueryNaturalLanguageParams = {
    question,
    depth,
    tokenBudget,
    outputFormat: queryFormat === "text" ? "json" : queryFormat,
  };

  const result = await executeQueryNaturalLanguage(params, llmClient);

  switch (queryFormat) {
    case "text":
      return formatTextOutput(result, normalizedRoot);
    case "json":
      // Every query format is LLM-facing, so drop the repeated workspace root
      // here too — unlike the other commands, whose --format json is a stable
      // contract for scripts and keeps absolute paths.
      return relativizeWorkspacePaths(JSON.stringify(result, null, 2), normalizedRoot);
    case "toon":
    default:
      return relativizeWorkspacePaths(
        result.toon ?? JSON.stringify(result, null, 2),
        normalizedRoot,
      );
  }
}
