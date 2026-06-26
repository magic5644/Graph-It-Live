/**
 * CLI Command: query
 *
 * Query the codebase with natural language using the call graph index.
 * Returns a TOON-format subgraph by default, JSON, or human-readable text.
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
import type { CliOutputFormat } from "../formatter.js";
import type { CliRuntime } from "../runtime.js";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

function parseDepth(args: string[]): number {
  const idx = args.indexOf("--depth");
  if (idx >= 0 && args[idx + 1]) {
    const parsed = Number.parseInt(args[idx + 1], 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 5) {
      return parsed;
    }
  }
  return 2;
}

function parseTokenBudget(args: string[]): number {
  const idx = args.indexOf("--token-budget");
  if (idx >= 0 && args[idx + 1]) {
    const parsed = Number.parseInt(args[idx + 1], 10);
    if (!Number.isNaN(parsed) && parsed >= 500 && parsed <= 16000) {
      return parsed;
    }
  }
  return 4000;
}

/**
 * Parse --format from command args.
 * Returns "toon" | "json" | "text" when the flag is present, undefined otherwise.
 * This allows the caller to fall back to the top-level CLI format when absent.
 */
function parseQueryFormatFromArgs(args: string[]): "toon" | "json" | "text" | undefined {
  const idx = args.indexOf("--format");
  if (idx >= 0 && args[idx + 1]) {
    const val = args[idx + 1];
    if (val === "toon" || val === "json" || val === "text") {
      return val;
    }
  }
  return undefined;
}

/** Flags that consume the next argument as their value. */
const FLAG_WITH_VALUE = new Set(["--depth", "--token-budget", "--format"]);

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
  lines.push(`Question: ${result.question}`);
  lines.push(`Keywords: ${result.extractedKeywords.join(", ") || "(none)"}`);
  lines.push(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
  if (result.meta.truncated) {
    lines.push("(result truncated — increase --token-budget for more)");
  }
  lines.push("");

  if (result.nodes && result.nodes.length > 0) {
    lines.push("Matching nodes:");
    for (const node of result.nodes) {
      const rel = normalizePath(path.relative(workspaceRoot, node.path));
      lines.push(`  - ${node.name} (${rel})`);
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
  // --format in args overrides the top-level CLI format (e.g. REPL session default)
  const queryFormat: 'toon' | 'json' | 'text' =
    parseQueryFormatFromArgs(args) ?? (format === 'json' ? 'json' : format === 'toon' ? 'toon' : 'toon');

  await runtime.ensureIndexed();

  // Normalize workspaceRoot for cross-platform path usage
  const normalizedRoot = normalizePath(runtime.workspaceRoot);

  // Check LLM availability and hint if unavailable
  const llmClient = await resolveLlmClient();
  if (llmClient === null) {
    process.stderr.write(
      "No LLM configured. Using keyword heuristic. " +
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY for better results.\n",
    );
  }

  const params: QueryNaturalLanguageParams = {
    question,
    depth,
    tokenBudget,
    outputFormat: queryFormat === "text" ? "json" : queryFormat,
  };

  const result = await executeQueryNaturalLanguage(params);

  switch (queryFormat) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "text":
      return formatTextOutput(result, normalizedRoot);
    case "toon":
    default:
      return result.toon ?? JSON.stringify(result, null, 2);
  }
}
