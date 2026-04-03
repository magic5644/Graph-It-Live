/**
 * CLI Command: path
 *
 * Finds the dependency path between two files.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeCrawlDependencyGraph } from "../../mcp/tools";
import { CliError, ExitCode } from "../errors";
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
      "Usage: graph-it path <entryFile> [--maxDepth N]",
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);

  // Optional --maxDepth
  let maxDepth: number | undefined;
  const depthIdx = args.indexOf("--maxDepth");
  if (depthIdx >= 0 && args[depthIdx + 1]) {
    maxDepth = Number.parseInt(args[depthIdx + 1], 10);
  }

  const result = await executeCrawlDependencyGraph({
    entryFile: ref.filePath,
    maxDepth,
  });

  return formatOutput(result, format, "path");
}
