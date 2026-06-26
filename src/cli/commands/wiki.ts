/**
 * graph-it wiki — Generate a navigable markdown wiki from the call graph.
 *
 * Usage:
 *   graph-it wiki [--output <dir>] [--scope <rel-path>] [--exclude <pattern>]...
 *                 [--top N] [--format markdown|json|toon]
 *
 * By default, tests/, dist/, *.test.ts etc. are excluded automatically.
 * Limitations (scope, truncation) are documented in the generated wiki itself.
 */

import path from "node:path";
import { normalizePath } from "../../shared/path.js";
import type { CliOutputFormat } from "../formatter.js";
import type { CliRuntime } from "../runtime.js";
import { executeGenerateWiki } from "../../mcp/tools/wiki.js";

// ---------------------------------------------------------------------------
// Flag helpers
// ---------------------------------------------------------------------------

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("-")) {
    return args[idx + 1];
  }
  return undefined;
}

function parseFlagMulti(args: string[], flag: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("-")) {
      results.push(args[i + 1]);
    }
  }
  return results;
}

function parseOutputDir(args: string[]): string {
  return parseFlag(args, "--output") ?? "wiki";
}

function parseTop(args: string[]): number {
  const raw = parseFlag(args, "--top");
  if (!raw) return 10;
  const parsed = Number.parseInt(raw, 10);
  return !Number.isNaN(parsed) && parsed >= 1 && parsed <= 50 ? parsed : 10;
}

function parseWikiFormat(
  args: string[],
  topLevelFormat: CliOutputFormat,
): "markdown" | "json" | "toon" {
  const raw = parseFlag(args, "--format");
  if (raw === "markdown" || raw === "json" || raw === "toon") return raw;
  if (topLevelFormat === "json") return "json";
  if (topLevelFormat === "toon") return "toon";
  return "markdown";
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const outputDir = parseOutputDir(args);
  const topHubsLimit = parseTop(args);
  const wikiFormat = parseWikiFormat(args, format);
  const scope = parseFlag(args, "--scope");
  const exclude = parseFlagMulti(args, "--exclude");

  await runtime.ensureIndexed();

  const workspaceRoot = normalizePath(runtime.workspaceRoot);
  const absoluteOutputDir = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(workspaceRoot, outputDir);

  const result = await executeGenerateWiki({
    workspaceRoot,
    outputDir: absoluteOutputDir,
    topHubsLimit,
    scope,
    exclude: exclude.length > 0 ? exclude : undefined,
  });

  switch (wikiFormat) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "toon": {
      const lines = [
        `wiki articles=${result.articlesCount}`,
        `index=${result.indexPath}`,
        `dir=${result.articlesDir}`,
        `topHubs: ${result.topHubs.map((h) => `${h.name}(${h.score})`).join(", ")}`,
      ];
      if (result.scopeNote) lines.push(`scope: ${result.scopeNote}`);
      return lines.join("\n");
    }
    case "markdown":
    default: {
      const lines = [
        `# Wiki generated`,
        ``,
        `- **Articles**: ${result.articlesCount}`,
        `- **Index**: \`${result.indexPath}\``,
        `- **Articles dir**: \`${result.articlesDir}\``,
      ];
      if (result.scopeNote) {
        lines.push(`- **Scope**: ${result.scopeNote}`);
      }
      lines.push(``, `## Top hub files`);
      lines.push(...result.topHubs.map((h) => `- ${h.name} (score: ${h.score})`));
      return lines.join("\n");
    }
  }
}
