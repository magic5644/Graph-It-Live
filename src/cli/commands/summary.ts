/**
 * CLI Command: summary
 *
 * Renders a workspace overview (index status + codemap).
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeGetIndexStatus, executeGenerateCodemap } from "../../mcp/tools";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";
import { parseSymbolRef } from "../symbols";

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  await runtime.ensureIndexed();

  const status = await executeGetIndexStatus();

  // If a file argument is provided, also generate a codemap for it
  if (args.length > 0) {
    const ref = parseSymbolRef(args[0], runtime.workspaceRoot);
    const codemap = await executeGenerateCodemap({ filePath: ref.filePath });
    return formatOutput({ indexStatus: status, codemap }, format, "summary");
  }

  return formatOutput(status, format, "summary");
}
