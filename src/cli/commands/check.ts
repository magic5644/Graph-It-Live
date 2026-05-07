/**
 * CLI Command: check
 *
 * Checks for unused symbols and/or breaking changes.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import fs from "node:fs/promises";
import path from "node:path";
import { executeFindUnusedSymbols, executeScanDeadCode } from "../../mcp/tools";
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

  // No argument → full workspace scan for dead code
  if (args.length === 0) {
    const result = await executeScanDeadCode({});
    return formatOutput(result, format, "check");
  }

  const candidatePath = path.isAbsolute(args[0])
    ? path.resolve(args[0])
    : path.resolve(runtime.workspaceRoot, args[0]);

  // Check if the argument is a directory → scoped dead code scan
  let isDirectory = false;
  try {
    const stat = await fs.stat(candidatePath);
    isDirectory = stat.isDirectory();
  } catch {
    // Not found or not accessible — treat as file reference below
  }

  if (isDirectory) {
    const result = await executeScanDeadCode({ scopePath: candidatePath });
    return formatOutput(result, format, "check");
  }

  // File argument → existing per-file unused symbol check
  const ref = parseSymbolRef(candidatePath, runtime.workspaceRoot);

  const result = await executeFindUnusedSymbols({
    filePath: ref.filePath,
  });

  return formatOutput(result, format, "check");
}
