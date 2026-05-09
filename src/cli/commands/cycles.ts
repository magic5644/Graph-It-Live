/**
 * CLI Command: cycles
 *
 * Lists confirmed dependency cycles that include a target file.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from 'node:path';
import { normalizePath } from '../../shared/path.js';
import { executeCrawlDependencyGraph } from '../../mcp/tools';
import { CliError, ExitCode } from '../errors';
import type { CliOutputFormat } from '../formatter';
import { formatOutput } from '../formatter';
import type { CliRuntime } from '../runtime';
import { parseSymbolRef } from '../symbols';

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  if (args.length < 1) {
    throw new CliError(
      'Usage: graph-it cycles <file>',
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  const targetFile = parseSymbolRef(args[0], runtime.workspaceRoot).filePath;
  const graph = await executeCrawlDependencyGraph({
    entryFile: targetFile,
    maxDepth: 50,
  });

  const confirmedCycles = graph.circularDependencies.filter((cycle) =>
    cycle.includes(targetFile),
  );

  const result = {
    filePath: targetFile,
    relativePath: normalizePath(path.relative(runtime.workspaceRoot, targetFile)),
    cycleCount: confirmedCycles.length,
    confirmedCycles: confirmedCycles.map((cycle) =>
      cycle.map((absPath) => normalizePath(path.relative(runtime.workspaceRoot, absPath))),
    ),
  };

  return formatOutput(result, format, 'cycles');
}
