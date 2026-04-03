/**
 * CLI Command: trace
 *
 * Traces execution flow from a symbol.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeTraceFunctionExecution } from "../../mcp/tools";
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
  if (args.length === 0) {
    throw new CliError(
      "Usage: graph-it trace <file#SymbolName> [--maxDepth N]",
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);
  if (!ref.symbolName) {
    throw new CliError(
      "trace requires a symbol name: file.ts#FunctionName",
      ExitCode.GENERAL_ERROR,
    );
  }

  // Optional --maxDepth
  let maxDepth: number | undefined;
  const depthIdx = args.indexOf("--maxDepth");
  if (depthIdx >= 0 && args[depthIdx + 1]) {
    maxDepth = Number.parseInt(args[depthIdx + 1], 10);
  }

  const result = await executeTraceFunctionExecution({
    filePath: ref.filePath,
    symbolName: ref.symbolName,
    maxDepth,
  });

  return formatOutput(result, format, "trace");
}
