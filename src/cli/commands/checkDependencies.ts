/**
 * CLI Command: check-dependencies
 *
 * Checks both outgoing and incoming dependencies for a target file.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from 'node:path';
import { executeAnalyzeDependencies, executeFindReferencingFiles } from '../../mcp/tools';
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
      'Usage: graph-it check-dependencies <file>',
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  const targetFile = parseSymbolRef(args[0], runtime.workspaceRoot).filePath;
  const [outgoing, incoming] = await Promise.all([
    executeAnalyzeDependencies({ filePath: targetFile }),
    executeFindReferencingFiles({ targetPath: targetFile }),
  ]);

  const result = {
    filePath: targetFile,
    relativePath: path.relative(runtime.workspaceRoot, targetFile),
    outgoing: {
      dependencyCount: outgoing.dependencyCount,
      dependencies: outgoing.dependencies,
    },
    incoming: {
      referencingFileCount: incoming.referencingFileCount,
      referencingFiles: incoming.referencingFiles,
    },
  };

  return formatOutput(result, format, 'check-dependencies');
}
