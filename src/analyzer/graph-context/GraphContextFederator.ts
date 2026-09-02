import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Spider } from '@/analyzer/Spider';
import {
  CallGraphIndexer,
  type CallGraphIndexSnapshot,
} from '@/analyzer/callgraph/CallGraphIndexer';
import { normalizePath } from '@/shared/path';
import type {
  GraphContextEdge,
  GraphContextNode,
  GraphContextRequest,
  GraphContextSnapshot,
} from '@/shared/graph-context-types';
import { compileFileScope } from './FileScopeMatcher';

const EXTERNAL_PREFIX = '@@external:';

/**
 * Read-only adapter that combines Spider's file dependency graph with the
 * CallGraphIndexer's symbol graph. It adds only CONTAINS edges between layers.
 */
export class GraphContextFederator {
  constructor(
    private readonly spider: Spider,
    private readonly callGraphIndexer: CallGraphIndexer,
  ) {}

  async buildSnapshot(request: GraphContextRequest): Promise<GraphContextSnapshot> {
    const workspaceRoot = normalizePath(this.spider.workspaceRoot);
    const scope = compileFileScope(workspaceRoot, request.scope ?? '**');
    const indexSnapshot = this.callGraphIndexer.getIndexSnapshot();
    const fileState = await getFileState(indexSnapshot);
    const fileGraphs = await Promise.all(
      indexSnapshot.files.map(async (file) => this.spider.getReadOnlyDependencyGraph(file.path)),
    );
    const nodesById = new Map<string, GraphContextNode>();
    const edgesByKey = new Map<string, GraphContextEdge>();
    const fileNodeIdsByPath = new Map<string, string>();

    for (const graph of fileGraphs) {
      for (const rawPath of graph.nodes) {
        const filePath = normalizePath(rawPath);
        if (!scope.matches(filePath)) continue;
        const relativePath = toWorkspaceRelativePath(filePath, workspaceRoot);
        if (!relativePath) continue;

        const id = `file:${relativePath}`;
        fileNodeIdsByPath.set(filePath, id);
        nodesById.set(id, {
          id,
          kind: 'file',
          name: path.posix.basename(relativePath),
          path: relativePath,
        });
      }
    }

    for (const graph of fileGraphs) {
      for (const edge of graph.edges) {
        const sourcePath = normalizePath(edge.source);
        const targetPath = normalizePath(edge.target);
        const sourceId = fileNodeIdsByPath.get(sourcePath);
        const targetId = fileNodeIdsByPath.get(targetPath);
        if (!sourceId || !targetId) continue;
        addEdge(edgesByKey, {
          source: sourceId,
          target: targetId,
          relation: 'IMPORTS',
          confidence: 'EXTRACTED',
          sourcePath: toWorkspaceRelativePath(sourcePath, workspaceRoot) ?? undefined,
        });
      }
    }

    const symbolIds = new Map<string, string>();
    for (const node of indexSnapshot.nodes) {
      const filePath = normalizePath(node.path);
      const fileId = fileNodeIdsByPath.get(filePath);
      if (!fileId) continue;
      const relativePath = toWorkspaceRelativePath(filePath, workspaceRoot);
      if (!relativePath) continue;

      const kind = isTestPath(relativePath) ? 'test' : 'symbol';
      const id = `${kind}:${relativePath}:${node.name}:${node.startLine}`;
      symbolIds.set(node.id, id);
      nodesById.set(id, {
        id,
        kind,
        name: node.name,
        path: relativePath,
        startLine: node.startLine,
        endLine: node.endLine,
        language: node.lang,
      });
      addEdge(edgesByKey, {
        source: fileId,
        target: id,
        relation: 'CONTAINS',
        confidence: 'EXTRACTED',
      });
    }

    for (const edge of indexSnapshot.edges) {
      const sourceId = symbolIds.get(edge.sourceId);
      if (!sourceId) continue;
      const targetId = symbolIds.get(edge.targetId) ?? addExternalTarget(
        edge.targetId,
        nodesById,
      );
      if (!targetId) continue;

      const sourceNode = nodesById.get(sourceId);
      addEdge(edgesByKey, {
        source: sourceId,
        target: targetId,
        relation: edge.typeRelation,
        confidence: 'EXTRACTED',
        sourcePath: sourceNode?.path,
        sourceLine: edge.sourceLine,
      });
    }

    return {
      revision: createRevision(workspaceRoot, indexSnapshot, fileState),
      fresh: fileState.every((entry) => entry.mtimeMs !== null && entry.mtimeMs <= entry.indexedLastModified),
      nodes: [...nodesById.values()].sort(compareNodes),
      edges: [...edgesByKey.values()].sort(compareEdges),
    };
  }
}

interface FileState {
  path: string;
  indexedLastModified: number;
  mtimeMs: number | null;
}

async function getFileState(indexSnapshot: CallGraphIndexSnapshot): Promise<FileState[]> {
  return Promise.all(indexSnapshot.files.map(async (file) => {
    try {
      return {
        path: normalizePath(file.path),
        indexedLastModified: file.lastModified,
        mtimeMs: (await stat(file.path)).mtimeMs,
      };
    } catch {
      return {
        path: normalizePath(file.path),
        indexedLastModified: file.lastModified,
        mtimeMs: null,
      };
    }
  }));
}

function toWorkspaceRelativePath(filePath: string, workspaceRoot: string): string | null {
  const normalizedPath = normalizePath(filePath);
  const relativePath = normalizePath(path.relative(workspaceRoot, normalizedPath));
  if (!relativePath || relativePath === '.' || relativePath === '..' || relativePath.startsWith('../')) {
    return null;
  }
  return path.isAbsolute(relativePath) ? null : relativePath;
}

function isTestPath(relativePath: string): boolean {
  return relativePath.startsWith('test/')
    || relativePath.startsWith('tests/')
    || /\.(test|spec)\.[^/]+$/.test(relativePath);
}

function addExternalTarget(rawTargetId: string, nodesById: Map<string, GraphContextNode>): string | null {
  if (!rawTargetId.startsWith(EXTERNAL_PREFIX)) return null;
  const name = rawTargetId.slice(EXTERNAL_PREFIX.length);
  if (!name) return null;
  const id = `external:${name}`;
  if (!nodesById.has(id)) {
    nodesById.set(id, { id, kind: 'external', name });
  }
  return id;
}

function addEdge(edgesByKey: Map<string, GraphContextEdge>, edge: GraphContextEdge): void {
  const key = [edge.source, edge.target, edge.relation, edge.sourceLine ?? ''].join('\u0000');
  if (!edgesByKey.has(key)) edgesByKey.set(key, edge);
}

function createRevision(
  workspaceRoot: string,
  indexSnapshot: CallGraphIndexSnapshot,
  fileState: FileState[],
): string {
  const state = {
    workspaceRoot,
    files: [...fileState].sort((left, right) => left.path.localeCompare(right.path)),
    indexer: indexSnapshot,
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function compareNodes(left: GraphContextNode, right: GraphContextNode): number {
  return left.id.localeCompare(right.id);
}

function compareEdges(left: GraphContextEdge, right: GraphContextEdge): number {
  return [left.source, left.target, left.relation, left.sourceLine ?? -1]
    .join('\u0000')
    .localeCompare([right.source, right.target, right.relation, right.sourceLine ?? -1].join('\u0000'));
}
