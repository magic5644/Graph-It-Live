/**
 * CLI Command: scan
 *
 * Indexes the workspace and shows progress.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeGetIndexStatus, executeRebuildIndex } from "../../mcp/tools";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";

export async function run(
  _args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  await runtime.ensureIndexed();

  const status = await executeGetIndexStatus();
  return formatOutput(status, format, "scan");
}
