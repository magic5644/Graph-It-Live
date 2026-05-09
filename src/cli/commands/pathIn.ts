/**
 * CLI Command: path-in
 *
 * Finds incoming dependencies (referencing files) for a target file.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeFindReferencingFiles } from '../../mcp/tools';
import * as path from 'node:path';
import { CliError, ExitCode } from '../errors';
import type { CliOutputFormat } from '../formatter';
import { formatOutput } from '../formatter';
import type { CliRuntime } from '../runtime';
import { parseSymbolRef } from '../symbols';

interface PathInGraphNode {
  id: string;
  path: string;
  relativePath: string;
}

interface PathInGraphEdge {
  source: string;
  target: string;
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  if (args.length < 1) {
    throw new CliError(
      'Usage: graph-it path-in <file>',
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);
  const result = await executeFindReferencingFiles({
    targetPath: ref.filePath,
  });

  const nodes: PathInGraphNode[] = [{
    id: result.targetPath,
    path: result.targetPath,
    relativePath: path.relative(runtime.workspaceRoot, result.targetPath),
  }];

  const nodeSet = new Set<string>([result.targetPath]);
  const edges: PathInGraphEdge[] = [];

  for (const referencingFile of result.referencingFiles) {
    if (!nodeSet.has(referencingFile.path)) {
      nodes.push({
        id: referencingFile.path,
        path: referencingFile.path,
        relativePath: referencingFile.relativePath,
      });
      nodeSet.add(referencingFile.path);
    }

    edges.push({
      source: referencingFile.path,
      target: result.targetPath,
    });
  }

  return formatOutput(
    {
      ...result,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
      edges,
    },
    format,
    'path',
  );
}
