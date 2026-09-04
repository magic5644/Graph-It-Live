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
import { toEvidence } from './GraphContextEvidence';
import type { DocumentReferenceIndexer } from './DocumentReferenceIndexer';
import { DocumentReferenceIndexer as LocalDocumentReferenceIndexer } from './DocumentReferenceIndexer';

const EXTERNAL_PREFIX = '@@external:';

/**
 * Read-only adapter that combines Spider's file dependency graph with the
 * CallGraphIndexer's symbol graph. It adds only CONTAINS edges between layers.
 */
export class GraphContextFederator {
  constructor(
    private readonly spider: Spider,
    private readonly callGraphIndexer: CallGraphIndexer,
    documentReferenceIndexer?: DocumentReferenceIndexer,
  ) {
    this.documentReferenceIndexer = documentReferenceIndexer
      ?? new LocalDocumentReferenceIndexer(spider.workspaceRoot);
  }
  private readonly documentReferenceIndexer: DocumentReferenceIndexer;

  async buildSnapshot(request: GraphContextRequest): Promise<GraphContextSnapshot> {
    const workspaceRoot = normalizePath(this.spider.workspaceRoot);
    const scope = compileFileScope(workspaceRoot, request.scope ?? '**');
    const indexSnapshot = this.callGraphIndexer.getIndexSnapshot();
    const fileState = await getFileState(indexSnapshot);
    const fileStateByPath = new Map(fileState.map(entry => [entry.path, entry]));
    const fresh = fileState.every(entry => !isStale(entry));
    const fileGraphs = await Promise.all(
      indexSnapshot.files.map(async (file) => this.spider.getReadOnlyDependencyGraph(file.path)),
    );
    const nodesById = new Map<string, GraphContextNode>();
    const edgesByKey = new Map<string, GraphContextEdge>();
    const fileNodeIdsByPath = new Map<string, string>();
    const rawNodesById = new Map(indexSnapshot.nodes.map(node => [node.id, node]));
    const symbolNodesByName = new Map<string, GraphContextNode[]>();

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
        addEdge(edgesByKey, toEvidence({
          source: sourceId,
          target: targetId,
          relation: 'IMPORTS',
          origin: 'MODULE_RESOLUTION',
          workspaceRoot,
          sourcePath,
          sourceLine: edge.sourceLine,
          stale: isStale(fileStateByPath.get(sourcePath)),
        }));
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
      const namedNodes = symbolNodesByName.get(node.name);
      if (namedNodes) namedNodes.push(nodesById.get(id) as GraphContextNode);
      else symbolNodesByName.set(node.name, [nodesById.get(id) as GraphContextNode]);
      addEdge(edgesByKey, toEvidence({
        source: fileId,
        target: id,
        relation: 'CONTAINS',
        origin: 'AST',
        workspaceRoot,
        sourcePath: filePath,
        sourceLine: node.startLine,
        sourceEndLine: node.endLine,
        stale: isStale(fileStateByPath.get(filePath)),
      }));
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
      const sourcePath = normalizePath(rawNodesById.get(edge.sourceId)?.path ?? '');
      const externalName = readExternalName(edge.targetId);
      const ambiguous = externalName === undefined
        ? false
        : (symbolNodesByName.get(externalName)?.length ?? 0) > 1;
      addEdge(edgesByKey, toEvidence({
        source: sourceId,
        target: targetId,
        relation: edge.typeRelation,
        origin: 'AST',
        workspaceRoot,
        sourcePath: sourceNode?.path,
        sourceLine: edge.sourceLine,
        ambiguous,
        stale: isStale(fileStateByPath.get(sourcePath)),
      }));
    }

    const includeDocuments = this.documentReferenceIndexer !== undefined
      && (request.scope !== undefined || hasDocumentSeed(request));
    const documents = includeDocuments
      ? await this.documentReferenceIndexer?.index(request.scope ?? '**')
      : undefined;
    for (const node of documents?.nodes ?? []) nodesById.set(node.id, node);
    for (const edge of documents?.edges ?? []) addEdge(edgesByKey, edge);
    const nodes = [...nodesById.values()].sort(compareNodes);
    const edges = [...edgesByKey.values()].sort(compareEdges);
    return {
      revision: createRevision(workspaceRoot, indexSnapshot, fileState, nodes, edges),
      fresh,
      nodes,
      edges,
    };
  }
}

function isStale(fileState: FileState | undefined): boolean {
  return fileState === undefined
    || fileState.mtimeMs === null
    || fileState.mtimeMs > fileState.indexedLastModified;
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
  const name = readExternalName(rawTargetId);
  if (name === undefined) return null;
  if (!name) return null;
  const id = `external:${name}`;
  if (!nodesById.has(id)) {
    nodesById.set(id, { id, kind: 'external', name });
  }
  return id;
}

function readExternalName(rawTargetId: string): string | undefined {
  if (!rawTargetId.startsWith(EXTERNAL_PREFIX)) return undefined;
  return rawTargetId.slice(EXTERNAL_PREFIX.length) || undefined;
}

function addEdge(edgesByKey: Map<string, GraphContextEdge>, edge: GraphContextEdge): void {
  const key = [edge.source, edge.target, edge.relation, edge.sourceLine ?? ''].join('\u0000');
  if (!edgesByKey.has(key)) edgesByKey.set(key, edge);
}

function createRevision(
  workspaceRoot: string,
  indexSnapshot: CallGraphIndexSnapshot,
  fileState: FileState[],
  documentNodes: GraphContextNode[],
  documentEdges: GraphContextEdge[],
): string {
  const state = {
    workspaceRoot,
    files: [...fileState].sort((left, right) => left.path.localeCompare(right.path)),
    indexer: indexSnapshot,
    documentNodes,
    documentEdges,
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function hasDocumentSeed(request: GraphContextRequest): boolean {
  return [...(request.seeds ?? []), ...(request.from ? [request.from] : []), ...(request.to ? [request.to] : [])]
    .some(seed => seed.id?.startsWith('document:')
      || (seed.filePath !== undefined && /\.(?:md|mdx|rst|ya?ml)$/i.test(seed.filePath)));
}

function compareNodes(left: GraphContextNode, right: GraphContextNode): number {
  return left.id.localeCompare(right.id);
}

function compareEdges(left: GraphContextEdge, right: GraphContextEdge): number {
  return [left.source, left.target, left.relation, left.sourceLine ?? -1]
    .join('\u0000')
    .localeCompare([right.source, right.target, right.relation, right.sourceLine ?? -1].join('\u0000'));
}
