/**
 * CLI Command: trace
 *
 * Traces execution flow from a symbol.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeTraceFunctionExecution } from "../../mcp/tools";
import { CliError, ExitCode } from "../errors";
import { readIntegerOption } from "../options";
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

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);
  if (!ref.symbolName) {
    throw new CliError(
      "trace requires a symbol name: file.ts#FunctionName",
      ExitCode.GENERAL_ERROR,
    );
  }

  const maxDepth = readIntegerOption(args, "--maxDepth", { min: 1, max: 100 });

  await runtime.ensureIndexed();

  const result = await executeTraceFunctionExecution({
    filePath: ref.filePath,
    symbolName: ref.symbolName,
    maxDepth,
  });

  return formatOutput(result, format, "trace", runtime.workspaceRoot);
}
