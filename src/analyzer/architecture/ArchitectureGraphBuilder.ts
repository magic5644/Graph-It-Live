/**
 * Workspace architecture graph shared by `graph-it architecture`, the
 * explore_architecture MCP tool and the extension, so all report the same groups and counts.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { computeNodeMetadata } from "../NodeMetadataBuilder";
import { SourceFileCollector } from "../SourceFileCollector";
import { DEFAULT_IGNORE_PATTERNS } from "../SourceFileFilters";
import type { Dependency } from "../types";
import { IGNORED_DIRECTORIES } from "../../shared/constants";
import type { CommunityMode, GraphData } from "../../shared/graph-types";
import { normalizePath } from "../../shared/path";
import { validateFileExists, validateWorkspacePath } from "../../shared/pathSecurity";

/** Direct dependencies of one file, e.g. `(f) => spider.analyze(f)`. */
export type AnalyzeFile = (filePath: string) => Promise<Dependency[]>;

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

export interface ArchitectureGraphOptions {
  maxFiles?: number;
  communityMode?: CommunityMode;
  /** Last scan timestamp, when the caller knows it. */
  indexedAt?: string;
  signal?: AbortSignal;
}

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const rel = path.relative(workspaceRoot, normalizePath(filePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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
  analyzeFile: AnalyzeFile,
): Promise<FailedArchitectureFile | null> {
  const normalizedPath = normalizePath(filePath);
  registerNode(acc, workspaceRoot, normalizedPath);
  try {
    validateWorkspacePath(normalizedPath, workspaceRoot);
    await validateFileExists(normalizedPath);
    for (const dep of await analyzeFile(normalizedPath)) {
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

/**
 * Hash of what group ids and pages depend on: same graph, same revision on every OS,
 * since paths are workspace-relative and normalized.
 */
function architectureRevision(
  communityMode: CommunityMode,
  nodes: { relativePath: string; communityId: number }[],
  edges: ArchitectureEdge[],
): string {
  // Code-unit order, not localeCompare: collation varies with the machine's locale. Entries are unique.
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : 1);
  const content = JSON.stringify([
    communityMode,
    nodes.map(node => `${node.relativePath}\t${node.communityId}`).sort(byCodeUnit),
    edges.map(edge => `${edge.sourceRelative}\t${edge.targetRelative}`).sort(byCodeUnit),
  ]);
  return createHash("sha256").update(content).digest("hex");
}

/** Builds the workspace imports graph with community metadata, plus what was analysed. */
export async function buildArchitectureGraph(
  workspaceRoot: string,
  analyzeFile: AnalyzeFile,
  options: ArchitectureGraphOptions = {},
) {
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const collector = new SourceFileCollector({ excludeNodeModules: true });
  const allFiles = await collector.collectAllSourceFiles(workspaceRoot);
  const files = Number.isFinite(maxFiles) ? allFiles.slice(0, maxFiles) : allFiles;

  const acc = initializeAccumulator();
  const failedFiles: FailedArchitectureFile[] = [];
  for (const filePath of files) {
    options.signal?.throwIfAborted();
    const failure = await collectArchitectureForFile(acc, workspaceRoot, filePath, analyzeFile); // NOSONAR S9382: one file at a time bounds memory and keeps node/edge order deterministic
    if (failure) failedFiles.push(failure);
  }

  const edges = [...acc.edgesByKey.values()];
  const graphData: GraphData = { nodes: [...acc.nodesByPath.keys()], edges };
  computeNodeMetadata(graphData, workspaceRoot, options.communityMode);

  const nodes = [...acc.nodesByPath.values()].map((node) => ({
    ...node,
    dependencyCount: acc.dependencyCount.get(node.path) ?? 0,
    dependentCount: acc.dependentCount.get(node.path) ?? 0,
    communityId: graphData.nodeMetadata?.[node.path]?.communityId ?? 0,
    communityKey: graphData.nodeMetadata?.[node.path]?.communityKey ?? "",
  }));

  const communityMode = options.communityMode ?? "path";
  const context = {
    communityMode,
    revision: architectureRevision(communityMode, nodes, edges),
    graphKind: "imports",
    scope: "workspace",
    exclusions: [...IGNORED_DIRECTORIES, ".*/", ".gitignore", ".graphitignore", ...DEFAULT_IGNORE_PATTERNS].join(", "),
    indexedAt: options.indexedAt,
    maxFiles: Number.isFinite(maxFiles) ? maxFiles : undefined,
    truncated: files.length < allFiles.length,
    failedFiles: failedFiles.length,
  };

  return {
    graphData,
    nodes,
    edges,
    scannedFiles: allFiles.length,
    analyzedFiles: files.length,
    failedFiles,
    context,
  };
}

export type ArchitectureGraph = Awaited<ReturnType<typeof buildArchitectureGraph>>;
