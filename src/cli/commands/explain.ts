/**
 * CLI Command: explain
 *
 * Explains the logic of a file using LSP-based intra-file call hierarchy.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeAnalyzeFileLogic } from "../../mcp/tools";
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
      "Usage: graph-it explain <file>",
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);

  const result = await executeAnalyzeFileLogic({
    filePath: ref.filePath,
  });

  return formatOutput(result, format, "explain");
}
