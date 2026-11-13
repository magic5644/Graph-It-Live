/**
 * CLI Command: check
 *
 * Checks for unused symbols and/or breaking changes.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DEAD_CODE_CONFIDENCES } from "../../analyzer/deadcode/deadCodeConfidence";
import { executeFindUnusedSymbols, executeScanDeadCode } from "../../mcp/tools";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import { readChoiceOption } from "../options";
import type { CliRuntime } from "../runtime";
import { parseSymbolRef } from "../symbols";

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const minConfidence = readChoiceOption(args, "--minConfidence", DEAD_CODE_CONFIDENCES);
  const verbose = args.includes("--verbose");
  const unreferencedFiles = args.includes("--unreferencedFiles");
  const flagIndex = args.indexOf("--minConfidence");
  const positional = (flagIndex < 0 ? args : [...args.slice(0, flagIndex), ...args.slice(flagIndex + 2)])
    .filter((arg) => arg !== "--verbose" && arg !== "--unreferencedFiles");
  // No argument → full workspace scan for dead code
  if (positional.length === 0) {
    await runtime.ensureIndexed();
    const result = await runtime.progress.phase(scanLabel(unreferencedFiles), (tick) =>
      executeScanDeadCode({ minConfidence, verbose, unreferencedFiles }, undefined, tick));
    return formatOutput(result, format, "check");
  }

  const candidatePath = path.isAbsolute(positional[0])
    ? path.resolve(positional[0])
    : path.resolve(runtime.workspaceRoot, positional[0]);

  // Check if the argument is a directory → scoped dead code scan
  let isDirectory = false;
  try {
    const stat = await fs.stat(candidatePath);
    isDirectory = stat.isDirectory();
  } catch {
    // Not found or not accessible — treat as file reference below
  }

  if (!isDirectory && unreferencedFiles) {
    throw new CliError("--unreferencedFiles applies to the workspace or a folder, not to a file", ExitCode.GENERAL_ERROR);
  }
  await runtime.ensureIndexed();

  if (isDirectory) {
    const result = await runtime.progress.phase(scanLabel(unreferencedFiles), (tick) =>
      executeScanDeadCode({ scopePath: candidatePath, minConfidence, verbose, unreferencedFiles }, undefined, tick));
    return formatOutput(result, format, "check");
  }

  // File argument → existing per-file unused symbol check
  const ref = parseSymbolRef(candidatePath, runtime.workspaceRoot);

  const result = await executeFindUnusedSymbols({
    filePath: ref.filePath,
    minConfidence,
  });

  return formatOutput(result, format, "check");
}

function scanLabel(unreferencedFiles: boolean): string {
  return unreferencedFiles ? "Finding unreferenced files" : "Analyzing unused exports";
}
