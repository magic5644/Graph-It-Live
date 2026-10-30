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
import type { ArchitectureGraphContext } from "../../shared/architecture-model";
import { IGNORED_DIRECTORIES } from "../../shared/constants";
import type { CommunityMode, GraphData } from "../../shared/graph-types";
import { normalizePath } from "../../shared/path";
import { validateFileExists, validateWorkspacePath } from "../../shared/pathSecurity";
import { mapWithConcurrency } from "../../shared/concurrency";

/** Files analyzed at once: bounds memory while hiding per-file I/O latency. */
const ANALYZE_CONCURRENCY = 8;

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

export interface ArchitectureEdge {
  source: string;
  target: string;
  sourceRelative: string;
  targetRelative: string;
  /** Line of the first import of `target` in `source`, when the analysis knows it. */
  line?: number;
}

interface ArchitectureAccumulator {
  nodesByPath: Map<string, ArchitectureNode>;
  edgesByKey: Map<string, ArchitectureEdge>;
  dependencyCount: Map<string, number>;
  dependentCount: Map<string, number>;
}

export interface FailedArchitectureFile {
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
  /** Called after each analysed file, so a caller can report progress. */
  onProgress?: (analyzed: number, total: number) => void;
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
  line?: number,
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
    ...(line ? { line } : {}),
  });
  acc.dependencyCount.set(normalizedSource, (acc.dependencyCount.get(normalizedSource) ?? 0) + 1);
  acc.dependentCount.set(normalizedTarget, (acc.dependentCount.get(normalizedTarget) ?? 0) + 1);
}

/** Analyzes one file; errors become a failure record so one bad file never aborts the graph. */
async function analyzeArchitectureFile(
  workspaceRoot: string,
  normalizedPath: string,
  analyzeFile: AnalyzeFile,
): Promise<Dependency[] | FailedArchitectureFile> {
  try {
    validateWorkspacePath(normalizedPath, workspaceRoot);
    await validateFileExists(normalizedPath);
    return await analyzeFile(normalizedPath);
  } catch (err) {
    return {
      filePath: normalizedPath,
      relativePath: normalizePath(path.relative(workspaceRoot, normalizedPath)),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Registers a file and its in-workspace dependencies, in dependency order. */
function registerArchitectureFile(
  acc: ArchitectureAccumulator,
  workspaceRoot: string,
  normalizedPath: string,
  dependencies: Dependency[],
): void {
  registerNode(acc, workspaceRoot, normalizedPath);
  for (const dep of dependencies) {
    if (!isWithinWorkspace(dep.path, workspaceRoot)) {
      continue;
    }
    const normalizedDependencyPath = normalizePath(dep.path);
    registerNode(acc, workspaceRoot, normalizedDependencyPath);
    registerEdge(acc, normalizedPath, normalizedDependencyPath, workspaceRoot, dep.line);
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
  const normalizedFiles = files.map(normalizePath);
  let analyzed = 0;
  // Analyze in parallel, then register in file order so node/edge order stays deterministic.
  const results = await mapWithConcurrency(normalizedFiles, ANALYZE_CONCURRENCY, async (filePath) => {
    options.signal?.throwIfAborted();
    const result = await analyzeArchitectureFile(workspaceRoot, filePath, analyzeFile);
    analyzed++;
    options.onProgress?.(analyzed, files.length);
    return result;
  });
  for (const [index, filePath] of normalizedFiles.entries()) {
    const result = results[index];
    if (Array.isArray(result)) {
      registerArchitectureFile(acc, workspaceRoot, filePath, result);
    } else {
      registerNode(acc, workspaceRoot, filePath);
      failedFiles.push(result);
    }
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
  const context: ArchitectureGraphContext = {
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
