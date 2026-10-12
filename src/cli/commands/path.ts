/**
 * CLI Command: path
 *
 * Finds the dependency path between two files.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeCrawlDependencyGraph } from "../../mcp/tools";
import { CliError, ExitCode } from "../errors";
import { readCommunityMode, readIntegerOption } from "../options";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";
import { parseSymbolRef } from "../symbols";

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  if (args.length < 1) {
    throw new CliError(
      "Usage: graph-it path <entryFile> [--maxDepth N] [--communities path|louvain]",
      ExitCode.GENERAL_ERROR,
    );
  }

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);

  const maxDepth = readIntegerOption(args, "--maxDepth", { min: 1, max: 100 });
  const communityMode = readCommunityMode(args);

  await runtime.ensureIndexed();

  const result = await executeCrawlDependencyGraph({
    entryFile: ref.filePath,
    maxDepth,
    communityMode,
  });

  return formatOutput(result, format, "path");
}
