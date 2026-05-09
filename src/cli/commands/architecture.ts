/**
 * CLI Command: architecture
 *
 * Build a complete workspace dependency architecture graph by aggregating
 * direct dependencies for every source file in the workspace.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from "node:path";
import { SourceFileCollector } from "../../analyzer/SourceFileCollector.js";
import { executeAnalyzeDependencies } from "../../mcp/tools";
import { validateFilePath } from "../../mcp/types";
import { normalizePath } from "../../shared/path.js";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";

interface ArchitectureNode {
  id: string;
  path: string;
  relativePath: string;
  extension: string;
  dependencyCount: number;
  dependentCount: number;
}

interface ArchitectureEdge {
  source: string;
  target: string;
  sourceRelative: string;
  targetRelative: string;
}

interface ArchitectureAccumulator {
  nodesByPath: Map<string, ArchitectureNode>;
  edgesByKey: Map<string, ArchitectureEdge>;
  dependencyCount: Map<string, number>;
  dependentCount: Map<string, number>;
}

interface FailedArchitectureFile {
  filePath: string;
  relativePath: string;
  reason: string;
}

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const rel = path.relative(workspaceRoot, normalizePath(filePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function parseMaxFiles(args: string[]): number {
  let maxFiles = Number.POSITIVE_INFINITY;
  const maxFilesIdx = args.indexOf("--maxFiles");
  if (maxFilesIdx >= 0 && args[maxFilesIdx + 1]) {
    const parsed = Number.parseInt(args[maxFilesIdx + 1], 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      maxFiles = parsed;
    }
  }
  return maxFiles;
}

function initializeAccumulator(): ArchitectureAccumulator {
  return {
    nodesByPath: new Map<string, ArchitectureNode>(),
    edgesByKey: new Map<string, ArchitectureEdge>(),
    dependencyCount: new Map<string, number>(),
    dependentCount: new Map<string, number>(),
  };
}

function registerNode(
  acc: ArchitectureAccumulator,
  workspaceRoot: string,
  filePath: string,
): void {
  const normalizedPath = normalizePath(filePath);
  const relativePath = normalizePath(path.relative(workspaceRoot, normalizedPath));
  acc.nodesByPath.set(normalizedPath, {
    id: normalizedPath,
    path: normalizedPath,
    relativePath,
    extension: path.extname(normalizedPath).slice(1),
    dependencyCount: 0,
    dependentCount: 0,
  });
}

function registerEdge(
  acc: ArchitectureAccumulator,
  sourcePath: string,
  targetPath: string,
  workspaceRoot: string,
): void {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedTarget = normalizePath(targetPath);
  const edgeKey = `${normalizedSource}=>${normalizedTarget}`;
  if (acc.edgesByKey.has(edgeKey)) {
    return;
  }

  acc.edgesByKey.set(edgeKey, {
    source: normalizedSource,
    target: normalizedTarget,
    sourceRelative: normalizePath(path.relative(workspaceRoot, normalizedSource)),
    targetRelative: normalizePath(path.relative(workspaceRoot, normalizedTarget)),
  });
  acc.dependencyCount.set(normalizedSource, (acc.dependencyCount.get(normalizedSource) ?? 0) + 1);
  acc.dependentCount.set(normalizedTarget, (acc.dependentCount.get(normalizedTarget) ?? 0) + 1);
}

async function collectArchitectureForFile(
  acc: ArchitectureAccumulator,
  workspaceRoot: string,
  filePath: string,
): Promise<FailedArchitectureFile | null> {
  const normalizedPath = normalizePath(filePath);
  registerNode(acc, workspaceRoot, normalizedPath);
  try {
    validateFilePath(normalizedPath, workspaceRoot);
    const analysis = await executeAnalyzeDependencies({ filePath: normalizedPath });
    for (const dep of analysis.dependencies) {
      if (!isWithinWorkspace(dep.path, workspaceRoot)) {
        continue;
      }
      const normalizedDependencyPath = normalizePath(dep.path);
      registerNode(acc, workspaceRoot, normalizedDependencyPath);
      registerEdge(acc, normalizedPath, normalizedDependencyPath, workspaceRoot);
    }
    return null;
  } catch (err) {
    return {
      filePath: normalizedPath,
      relativePath: normalizePath(path.relative(workspaceRoot, normalizedPath)),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  await runtime.ensureIndexed();

  const maxFiles = parseMaxFiles(args);

  const collector = new SourceFileCollector({ excludeNodeModules: true });
  const allFiles = await collector.collectAllSourceFiles(runtime.workspaceRoot);
  const files = Number.isFinite(maxFiles) ? allFiles.slice(0, maxFiles) : allFiles;

  const acc = initializeAccumulator();

  let skippedFiles = 0;
  const failedFiles: FailedArchitectureFile[] = [];

  for (const filePath of files) {
    const failure = await collectArchitectureForFile(
      acc,
      runtime.workspaceRoot,
      filePath,
    );
    if (failure) {
      skippedFiles += 1;
      failedFiles.push(failure);
    }
  }

  const nodes = [...acc.nodesByPath.values()].map((node) => ({
    ...node,
    dependencyCount: acc.dependencyCount.get(node.path) ?? 0,
    dependentCount: acc.dependentCount.get(node.path) ?? 0,
  }));

  const edges = [...acc.edgesByKey.values()];

  const architecture = {
    workspaceRoot: runtime.workspaceRoot,
    scannedFiles: allFiles.length,
    analyzedFiles: files.length,
    skippedFiles,
    failedFiles,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  };

  return formatOutput(architecture, format, "architecture");
}
