/**
 * CLI Command: scan
 *
 * Indexes the workspace and shows progress.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeGetIndexStatus } from "../../mcp/tools";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";

export async function run(
  _args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  await runtime.ensureIndexed();

  // cacheSize counts the in-memory analysis cache: 0 right after a restore from .graph-it/cache,
  // which reads as an empty index; reverseIndexStats.indexedFiles is the indexed file count.
  const { cacheSize: _cacheSize, ...status } = await executeGetIndexStatus();
  return formatOutput(status, format, "scan");
}
