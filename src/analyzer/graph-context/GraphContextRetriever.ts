import { estimateTokens } from '@/shared/toon';
import type { QueryEngine } from '@/analyzer/QueryEngine';
import { normalizePath } from '@/shared/path';
import type {
  GraphContextCandidate,
  GraphContextEdge,
  GraphContextMode,
  GraphContextNode,
  GraphContextPath,
  GraphContextRelation,
  GraphContextRequest,
  GraphContextResponse,
  GraphContextSeed,
  GraphContextSnapshot,
} from '@/shared/graph-context-types';
import { compileFileScope } from './FileScopeMatcher';
import { GraphContextCommunities } from './GraphContextCommunities';
import { toEvidence } from './GraphContextEvidence';
import { findShortestPath } from './GraphContextPathFinder';
import { resolveSeeds } from './GraphContextResolver';
import { GraphContextScorer } from './GraphContextScorer';

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_NODES = 200;
const MAX_SEARCH_SEEDS = 20;
const MAX_OVERVIEW_HUBS = 10;
const MAX_OVERVIEW_COMMUNITIES = 10;

export interface GraphContextSnapshotProvider {
  buildSnapshot(request: GraphContextRequest): Promise<GraphContextSnapshot>;
}

export interface GraphContextDependentsProvider {
  findReferencingFiles(targetPath: string): Promise<Array<{ path: string }>>;
  getSymbolDependents(
    filePath: string,
    symbolName: string,
  ): Promise<Array<{ sourceSymbolId: string }>>;
}

export interface GraphContextRetrieverOptions {
  snapshotProvider: GraphContextSnapshotProvider;
  queryEngine?: Pick<QueryEngine, 'scoreSeedNodes'>;
  dependentsProvider?: GraphContextDependentsProvider;
  workspaceRoot: string;
  /** Build the complete ranked candidate pool when an outer adapter owns pagination. */
  collectAllCandidates?: boolean;
}

interface TraversalEntry {
  nodeId: string;
  depth: number;
  score: number;
}

interface RetrievalSelection {
  seeds: GraphContextNode[];
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
  paths: GraphContextPath[];
  ambiguous: GraphContextCandidate[];
  eligibleNodeCount: number;
  eligibleEdgeCount: number;
  suggestionSnapshot?: GraphContextSnapshot;
  nextQueries?: string[];
}

/** Retrieves a ranked graph response before token-budget selection is applied. */
export class GraphContextRetriever {
  private readonly scorer: GraphContextScorer;

  constructor(private readonly options: GraphContextRetrieverOptions) {
    this.scorer = new GraphContextScorer({
      queryEngine: options.queryEngine,
      workspaceRoot: options.workspaceRoot,
    });
  }

  async retrieve(request: GraphContextRequest): Promise<GraphContextResponse> {
    const mode = request.mode ?? 'search';
    const federatedSnapshot = await this.options.snapshotProvider.buildSnapshot(request);
    const snapshot = scopeSnapshot(
      federatedSnapshot,
      request.scope,
    );
    const selection = mode === 'path'
      ? this.retrievePath(request, snapshot)
      : mode === 'overview'
        ? this.retrieveOverview(request, snapshot)
        : await this.retrieveTraversal(request, snapshot, mode);
    const omitted = {
      nodes: Math.max(0, selection.eligibleNodeCount - selection.nodes.length),
      edges: Math.max(0, selection.eligibleEdgeCount - selection.edges.length),
    };

    const ambiguityCandidates = collectAmbiguousEdgeCandidates(
      federatedSnapshot,
      selection,
      request.scope,
    );
    const selectionWithAmbiguity = {
      ...selection,
      ambiguous: dedupeCandidates([...selection.ambiguous, ...ambiguityCandidates]),
    };
    const generatedNextQueries = buildNextQueries(
      selection.suggestionSnapshot ?? snapshot,
      selectionWithAmbiguity,
      request,
    );
    const response: GraphContextResponse = {
      indexRevision: snapshot.revision,
      fresh: snapshot.fresh,
      mode,
      seeds: selection.seeds,
      nodes: selection.nodes,
      edges: selection.edges,
      paths: selection.paths,
      ambiguous: selectionWithAmbiguity.ambiguous,
      omitted,
      nextQueries: [...new Set([
        ...generatedNextQueries.slice(0, selection.nextQueries?.length ? 4 : 5),
        ...(selection.nextQueries ?? []),
      ])].slice(0, 5),
      tokenEstimate: 0,
      truncated: omitted.nodes > 0 || omitted.edges > 0,
    };
    response.tokenEstimate = estimateTokens(JSON.stringify(response));
    return response;
  }

  private async retrieveTraversal(
    request: GraphContextRequest,
    snapshot: GraphContextSnapshot,
    mode: Exclude<GraphContextMode, 'path' | 'overview'>,
  ): Promise<RetrievalSelection> {
    const { seeds: resolvedSeeds, ambiguous } = resolveRequestedSeeds(request.seeds, snapshot);
    const scoredSearchSeeds = request.question
      ? this.scorer.scoreSearchNodes(request.question, snapshot.nodes, request.scope)
      : [];
    const hasRequestedSeeds = (request.seeds?.length ?? 0) > 0;
    const requestedMaxNodes = request.maxNodes ?? DEFAULT_MAX_NODES;
    const generatedSeedLimit = Math.min(
      MAX_SEARCH_SEEDS,
      Math.max(0, requestedMaxNodes - resolvedSeeds.length),
    );
    const searchSeeds = mode === 'search' || (!hasRequestedSeeds && resolvedSeeds.length === 0)
      ? selectGeneratedSeeds(scoredSearchSeeds, resolvedSeeds, generatedSeedLimit)
      : [];
    const seeds = mergeSeeds(resolvedSeeds, searchSeeds);
    const depth = mode === 'neighbors' ? 1 : normalizeDepth(request.depth);
    const retrievalSnapshot = mode === 'impact' || mode === 'refactor'
      ? await augmentWithDependents(
        snapshot,
        seeds,
        depth,
        this.options.dependentsProvider,
        this.options.workspaceRoot,
      )
      : snapshot;
    const direction = mode === 'impact' || mode === 'refactor' ? 'incoming' : 'both';
    const maxNodes = this.options.collectAllCandidates
      ? retrievalSnapshot.nodes.length
      : Math.max(requestedMaxNodes, resolvedSeeds.length);
    const traversal = traverseSnapshot(
      retrievalSnapshot,
      seeds,
      depth,
      direction,
      request.relations,
      mode,
      request.question ?? '',
      this.scorer,
      maxNodes,
    );
    const selectedEntries = traversal.entries;
    const selectedIds = new Set(selectedEntries.map(entry => entry.nodeId));
    const seedIds = new Set(seeds.map(seed => seed.id));
    const nodeById = new Map(retrievalSnapshot.nodes.map(node => [node.id, node]));
    const nodes = selectedEntries.flatMap((entry): GraphContextNode[] => {
      const graphNode = nodeById.get(entry.nodeId);
      if (!graphNode) return [];
      return [{
        ...graphNode,
        score: mode === 'impact' ? impactScore(entry.depth) : entry.score,
        isSeed: seedIds.has(entry.nodeId) || undefined,
      }];
    });
    const edges = traversal.edgeIndexes
      .map(index => retrievalSnapshot.edges[index])
      .filter(edge => selectedIds.has(edge.source) && selectedIds.has(edge.target));

    return {
      seeds: seeds.map(seed => ({ ...seed, isSeed: true })),
      nodes,
      edges,
      paths: [],
      ambiguous,
      eligibleNodeCount: traversal.eligibleNodeCount,
      eligibleEdgeCount: traversal.eligibleEdgeCount,
      suggestionSnapshot: retrievalSnapshot,
    };
  }

  private retrievePath(
    request: GraphContextRequest,
    snapshot: GraphContextSnapshot,
  ): RetrievalSelection {
    if (!request.from || !request.to) return emptySelection();

    const fromResolution = resolveSeeds(request.from, snapshot);
    const toResolution = resolveSeeds(request.to, snapshot);
    const ambiguous = collectAmbiguous([fromResolution.candidates, toResolution.candidates], [
      fromResolution.ambiguous,
      toResolution.ambiguous,
    ]);
    const endpoints = [fromResolution.selected, toResolution.selected]
      .filter((node): node is GraphContextNode => node !== undefined);
    const endpointIds = new Set(endpoints.map(endpoint => endpoint.id));
    const pathSnapshot = withoutAmbiguousEdges(snapshot);
    const path = findShortestPath(pathSnapshot, request.from, request.to, {
      directed: request.directed,
      maxHops: normalizeDepth(request.depth),
      relations: request.relations,
    });
    if (!path) {
      const contextNodes = collectPathContextNodes(
        pathSnapshot,
        fromResolution.selected?.id,
        normalizeDepth(request.depth),
        request.directed ?? true,
        request.relations,
      );
      const contextNodeIds = new Set([
        ...endpointIds,
        ...contextNodes.map(contextNode => contextNode.id),
      ]);
      const nodes = snapshot.nodes
        .filter(node => contextNodeIds.has(node.id))
        .map(node => ({ ...node, score: 1, isSeed: endpointIds.has(node.id) || undefined }));
      return {
        ...emptySelection(),
        seeds: endpoints.map(node => ({ ...node, isSeed: true })),
        nodes,
        ambiguous,
        eligibleNodeCount: nodes.length,
      };
    }

    const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
    const nodes = path.nodeIds.flatMap((id, index): GraphContextNode[] => {
      const graphNode = nodeById.get(id);
      return graphNode ? [{
        ...graphNode,
        score: impactScore(Math.min(index, path.hops - index)),
        isSeed: endpointIds.has(id) || undefined,
      }] : [];
    });
    const edges = path.edgeIndexes.map(index => pathSnapshot.edges[index]);
    const responsePath: GraphContextPath = {
      nodeIds: [...path.nodeIds],
      edgeIndexes: edges.map((_edge, index) => index),
      hops: path.hops,
    };

    return {
      seeds: endpoints.map(node => ({ ...node, isSeed: true })),
      nodes,
      edges,
      paths: [responsePath],
      ambiguous,
      eligibleNodeCount: nodes.length,
      eligibleEdgeCount: edges.length,
    };
  }

  private retrieveOverview(
    request: GraphContextRequest,
    snapshot: GraphContextSnapshot,
  ): RetrievalSelection {
    const topology = new GraphContextCommunities(snapshot);
    const graphStats = topology.graphStats;
    const hubLimit = Math.min(
      MAX_OVERVIEW_HUBS,
      this.options.collectAllCandidates
        ? MAX_OVERVIEW_HUBS
        : request.maxNodes ?? Math.min(DEFAULT_MAX_NODES, 20),
    );
    const hubs = topology.topHubs(hubLimit);
    const communityNodes = Array.from(
      { length: Math.min(graphStats.communityCount, MAX_OVERVIEW_COMMUNITIES) },
      (_unused, index): GraphContextNode => {
        const communityId = index + 1;
        const memberCount = topology.getCommunity(communityId)?.nodes.length ?? 0;
        return {
          id: `community:${communityId}`,
          kind: 'community',
          name: `Community ${communityId} (${memberCount} nodes)`,
          score: memberCount,
        };
      },
    );
    const hubNodes = hubs.map(hub => ({ ...hub.node, score: hub.totalDegree }));
    const nodes = [...hubNodes, ...communityNodes];
    const hubIds = new Set(hubNodes.map(node => node.id));
    const communityIds = new Set(communityNodes.map(node => node.id));
    const edges = snapshot.edges.filter(edge => (
      relationAllowed(edge.relation, request.relations)
      && hubIds.has(edge.source)
      && hubIds.has(edge.target)
    ));
    if (relationAllowed('BELONGS_TO', request.relations)) {
      for (const hub of hubs) {
        const communityId = `community:${hub.communityId}`;
        if (hub.communityId === 0 || !communityIds.has(communityId)) continue;
        edges.push({
          source: hub.node.id,
          target: communityId,
          relation: 'BELONGS_TO',
          confidence: 'INFERRED',
          evidence: { reason: 'Deterministic federated graph community assignment' },
        });
      }
    }
    const seeds = nodes.length === 0 ? [] : [{ ...nodes[0], isSeed: true }];
    if (nodes[0]) nodes[0] = { ...nodes[0], isSeed: true };

    return {
      seeds,
      nodes,
      edges,
      paths: [],
      ambiguous: [],
      eligibleNodeCount: graphStats.nodeCount + graphStats.communityCount,
      eligibleEdgeCount: (request.relations === undefined
        ? graphStats.edgeCount
        : request.relations.reduce((total, relation) => total + (graphStats.relationCounts[relation] ?? 0), 0))
        + (relationAllowed('BELONGS_TO', request.relations)
          ? graphStats.nodeCount - (topology.getCommunity(0)?.nodes.length ?? 0)
          : 0),
      nextQueries: communityNodes.map(node => `Inspect ${node.name.toLowerCase()}`),
    };
  }
}

async function augmentWithDependents(
  snapshot: GraphContextSnapshot,
  seeds: GraphContextNode[],
  maxDepth: number,
  provider: GraphContextDependentsProvider | undefined,
  workspaceRoot: string,
): Promise<GraphContextSnapshot> {
  if (!provider || seeds.length === 0 || maxDepth === 0) return snapshot;

  const derivedEdges = new Map<string, GraphContextEdge>();
  const visited = new Set(seeds.map(seed => seed.id));
  let frontier = [...seeds];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const nextFrontier: GraphContextNode[] = [];
    for (const targetNode of frontier) {
      const dependents = await loadDependents(targetNode, snapshot, provider, workspaceRoot);
      for (const dependent of dependents) {
        const key = `${dependent.id}\u0000${targetNode.id}`;
        if (!derivedEdges.has(key)) {
          derivedEdges.set(key, toEvidence({
            source: dependent.id,
            target: targetNode.id,
            relation: 'IMPACTED_BY',
            origin: 'INFERENCE',
            workspaceRoot,
            sourcePath: dependent.path,
          }));
        }
        if (!visited.has(dependent.id)) {
          visited.add(dependent.id);
          nextFrontier.push(dependent);
        }
      }
    }
    frontier = nextFrontier.sort((left, right) => left.id.localeCompare(right.id));
  }

  return { ...snapshot, edges: [...snapshot.edges, ...derivedEdges.values()] };
}

async function loadDependents(
  targetNode: GraphContextNode,
  snapshot: GraphContextSnapshot,
  provider: GraphContextDependentsProvider,
  workspaceRoot: string,
): Promise<GraphContextNode[]> {
  const targetPath = qualifyWorkspacePath(workspaceRoot, targetNode.path);
  if (!targetPath) return [];

  try {
    if (targetNode.kind === 'file') {
      const dependencies = await provider.findReferencingFiles(targetPath);
      return dedupeNodes(dependencies.flatMap((dependency): GraphContextNode[] => {
        const normalizedDependentPath = normalizePath(dependency.path);
        const match = snapshot.nodes.find(node => (
          node.kind === 'file'
          && qualifyWorkspacePath(workspaceRoot, node.path) === normalizedDependentPath
        ));
        return match ? [match] : [];
      }));
    }

    if (targetNode.kind === 'symbol' || targetNode.kind === 'test') {
      const dependencies = await provider.getSymbolDependents(targetPath, targetNode.name);
      return dedupeNodes(dependencies.flatMap((dependency): GraphContextNode[] => {
        const identity = parseSymbolIdentity(dependency.sourceSymbolId);
        if (!identity) return [];
        const match = snapshot.nodes.find(node => (
          (node.kind === 'symbol' || node.kind === 'test')
          && node.name === identity.symbolName
          && qualifyWorkspacePath(workspaceRoot, node.path) === identity.filePath
        ));
        return match ? [match] : [];
      }));
    }
  } catch {
    return [];
  }

  return [];
}

function qualifyWorkspacePath(workspaceRoot: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const normalizedPath = normalizePath(filePath);
  if (normalizedPath.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedPath)) return normalizedPath;
  return normalizePath(`${normalizePath(workspaceRoot).replace(/\/$/, '')}/${normalizedPath}`);
}

function parseSymbolIdentity(symbolId: string): { filePath: string; symbolName: string } | null {
  const separatorIndex = symbolId.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex === symbolId.length - 1) return null;
  return {
    filePath: normalizePath(symbolId.slice(0, separatorIndex)),
    symbolName: symbolId.slice(separatorIndex + 1),
  };
}

function scopeSnapshot(snapshot: GraphContextSnapshot, scope: string | undefined): GraphContextSnapshot {
  if (scope === undefined) return snapshot;
  const matcher = compileFileScope('/', scope);
  const nodes = snapshot.nodes.filter(node => (
    node.path !== undefined && matcher.matches(`/${normalizePath(node.path).replace(/^\//, '')}`)
  ));
  const nodeIds = new Set(nodes.map(node => node.id));
  return {
    ...snapshot,
    nodes,
    edges: snapshot.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  };
}

function resolveRequestedSeeds(
  requestedSeeds: GraphContextSeed[] | undefined,
  snapshot: GraphContextSnapshot,
): { seeds: GraphContextNode[]; ambiguous: GraphContextCandidate[] } {
  const seeds: GraphContextNode[] = [];
  const ambiguous: GraphContextCandidate[] = [];

  for (const requestedSeed of requestedSeeds ?? []) {
    const resolution = resolveSeeds(requestedSeed, snapshot);
    if (resolution.selected) seeds.push({ ...resolution.selected, score: 1, isSeed: true });
    if (resolution.ambiguous) ambiguous.push(...resolution.candidates);
  }

  return {
    seeds: dedupeNodes(seeds),
    ambiguous: dedupeCandidates(ambiguous),
  };
}

function selectGeneratedSeeds(
  scoredSeeds: Array<{ node: GraphContextNode; score: number }>,
  explicitSeeds: GraphContextNode[],
  limit: number,
): GraphContextNode[] {
  const explicitIds = new Set(explicitSeeds.map(seed => seed.id));
  return scoredSeeds
    .filter(candidate => !explicitIds.has(candidate.node.id))
    .slice(0, limit)
    .map(candidate => ({ ...candidate.node, score: candidate.score, isSeed: true }));
}

function mergeSeeds(explicitSeeds: GraphContextNode[], searchSeeds: GraphContextNode[]): GraphContextNode[] {
  return dedupeNodes([...explicitSeeds, ...searchSeeds]);
}

function traverseSnapshot(
  snapshot: GraphContextSnapshot,
  seeds: GraphContextNode[],
  maxDepth: number,
  direction: 'incoming' | 'both',
  relations: GraphContextRelation[] | undefined,
  mode: GraphContextMode,
  question: string,
  scorer: GraphContextScorer,
  maxNodes: number,
): {
  entries: TraversalEntry[];
  edgeIndexes: number[];
  eligibleNodeCount: number;
  eligibleEdgeCount: number;
} {
  const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
  const bestEntries = new Map<string, TraversalEntry>();
  let frontier = seeds.map(seed => seed.id);
  for (const seed of seeds) {
    bestEntries.set(seed.id, { nodeId: seed.id, depth: 0, score: seed.score ?? 1 });
  }
  const traversedEdgeIndexes = new Set<number>();
  const eligibleEdgeIndexes = new Set<number>();
  const eligibleNodeIds = new Set(frontier);
  const nodeLimit = Math.max(maxNodes, seeds.length);

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const nextCandidates = new Map<string, TraversalEntry & { edgeIndexes: Set<number> }>();
    const frontierIds = new Set(frontier);

    snapshot.edges.forEach((edge, edgeIndex) => {
      if (edge.confidence === 'AMBIGUOUS') return;
      if (!relationAllowed(edge.relation, relations)) return;
      const nextIds: string[] = [];
      if (frontierIds.has(edge.target)) nextIds.push(edge.source);
      if (direction === 'both' && frontierIds.has(edge.source)) nextIds.push(edge.target);
      if (nextIds.length === 0) return;

      for (const nextId of nextIds) {
        const graphNode = nodeById.get(nextId);
        if (!graphNode) continue;
        eligibleEdgeIndexes.add(edgeIndex);
        eligibleNodeIds.add(nextId);
        if (bestEntries.has(nextId)) {
          if (bestEntries.has(edge.source) && bestEntries.has(edge.target)) {
            traversedEdgeIndexes.add(edgeIndex);
          }
          continue;
        }
        const relationScore = scorer.scoreRelation(mode, edge.relation, question, graphNode);
        const candidate = {
          nodeId: nextId,
          depth,
          score: relationScore / depth,
          edgeIndexes: new Set([edgeIndex]),
        };
        const existing = nextCandidates.get(nextId);
        if (!existing) {
          nextCandidates.set(nextId, candidate);
        } else {
          existing.edgeIndexes.add(edgeIndex);
          existing.score = Math.max(existing.score, candidate.score);
        }
      }
    });

    const availableNodes = Math.max(0, nodeLimit - bestEntries.size);
    const nextEntries = [...nextCandidates.values()]
      .sort(compareTraversalEntries)
      .slice(0, availableNodes);
    for (const entry of nextEntries) {
      bestEntries.set(entry.nodeId, entry);
      for (const edgeIndex of entry.edgeIndexes) traversedEdgeIndexes.add(edgeIndex);
    }
    frontier = nextEntries.map(entry => entry.nodeId);
  }

  const seedIds = new Set(seeds.map(seed => seed.id));
  const entries = [...bestEntries.values()].sort((left, right) => {
    const leftSeed = seedIds.has(left.nodeId);
    const rightSeed = seedIds.has(right.nodeId);
    if (leftSeed !== rightSeed) return leftSeed ? -1 : 1;
    if (mode === 'impact' && left.depth !== right.depth) return left.depth - right.depth;
    return compareTraversalEntries(left, right);
  });
  const eligibleIds = new Set(entries.map(entry => entry.nodeId));
  const edgeIndexes = [...traversedEdgeIndexes]
    .filter(index => {
      const edge = snapshot.edges[index];
      return eligibleIds.has(edge.source) && eligibleIds.has(edge.target);
    })
    .sort((left, right) => left - right);

  return {
    entries,
    edgeIndexes,
    eligibleNodeCount: eligibleNodeIds.size,
    eligibleEdgeCount: eligibleEdgeIndexes.size,
  };
}

function withoutAmbiguousEdges(snapshot: GraphContextSnapshot): GraphContextSnapshot {
  // The formal request contract has no explicit ambiguous-edge opt-in field.
  // Keep ambiguous edges out of paths until that contract defines one.
  return {
    ...snapshot,
    edges: snapshot.edges.filter(edge => edge.confidence !== 'AMBIGUOUS'),
  };
}

function collectAmbiguousEdgeCandidates(
  snapshot: GraphContextSnapshot,
  selection: RetrievalSelection,
  scope: string | undefined,
): GraphContextCandidate[] {
  const contextualNodeIds = new Set([
    ...selection.seeds.map(node => node.id),
    ...selection.nodes.map(node => node.id),
  ]);
  const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
  const candidatesByName = buildSymbolCandidatesByName(snapshot);
  const candidates: GraphContextCandidate[] = [];

  for (const edge of snapshot.edges) {
    if (edge.confidence !== 'AMBIGUOUS' || !contextualNodeIds.has(edge.source)) continue;
    const targetNode = nodeById.get(edge.target);
    if (targetNode?.kind !== 'external') continue;
    const scopedCandidates = candidatesByName.get(targetNode.name)
      ?.filter(candidate => candidate.node.path !== undefined && matchesScope(candidate.node.path, scope));
    if (scopedCandidates && scopedCandidates.length > 1) candidates.push(...scopedCandidates);
  }

  return dedupeCandidates(candidates);
}

function collectPathContextNodes(
  snapshot: GraphContextSnapshot,
  fromId: string | undefined,
  maxHops: number,
  directed: boolean,
  relations: GraphContextRelation[] | undefined,
): GraphContextNode[] {
  if (!fromId || maxHops === 0) return [];
  const visited = new Set([fromId]);
  let frontier = [fromId];

  for (let depth = 0; depth < maxHops && frontier.length > 0; depth += 1) {
    const frontierIds = new Set(frontier);
    const next = new Set<string>();
    for (const edge of snapshot.edges) {
      if (edge.confidence === 'AMBIGUOUS') continue;
      if (!relationAllowed(edge.relation, relations)) continue;
      if (frontierIds.has(edge.source)) next.add(edge.target);
      if (!directed && frontierIds.has(edge.target)) next.add(edge.source);
    }
    frontier = [...next].filter(id => !visited.has(id));
    frontier.forEach(id => visited.add(id));
  }

  return snapshot.nodes.filter(node => visited.has(node.id) && node.id !== fromId);
}

function buildSymbolCandidatesByName(
  snapshot: GraphContextSnapshot,
): Map<string, GraphContextCandidate[]> {
  const candidatesByName = new Map<string, GraphContextCandidate[]>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'symbol' && node.kind !== 'test') continue;
    const candidate = { node, score: 0.85, reason: 'Exact symbol name' };
    const candidates = candidatesByName.get(node.name);
    if (candidates) candidates.push(candidate);
    else candidatesByName.set(node.name, [candidate]);
  }
  return candidatesByName;
}

function matchesScope(filePath: string, scope: string | undefined): boolean {
  if (scope === undefined) return true;
  const matcher = compileFileScope('/', scope);
  return matcher.matches(`/${normalizePath(filePath).replace(/^\//, '')}`);
}

function buildNextQueries(
  snapshot: GraphContextSnapshot,
  selection: RetrievalSelection,
  request: GraphContextRequest,
): string[] {
  const suggestions: string[] = [];
  for (const candidate of selection.ambiguous) {
    suggestions.push(`Disambiguate ${candidate.node.name} at ${candidate.node.path ?? candidate.node.id}`);
  }

  const returnedRelations = new Set(selection.edges.map(edge => edge.relation));
  const selectedIds = new Set(selection.nodes.map(node => node.id));
  const omittedRelations = [...new Set(snapshot.edges
    .filter(edge => selectedIds.has(edge.source) || selectedIds.has(edge.target))
    .map(edge => edge.relation)
    .filter(relation => !returnedRelations.has(relation)))]
    .sort();
  const anchor = highestDegreeNode(snapshot, selection.nodes) ?? selection.seeds[0];
  for (const relation of omittedRelations) {
    if (!anchor) break;
    suggestions.push(`Explore ${relation} around ${concreteLabel(anchor)}`);
  }

  const hubs = [...selection.nodes]
    .sort((left, right) => (
      degree(snapshot.edges, right.id) - degree(snapshot.edges, left.id)
      || left.id.localeCompare(right.id)
    ));
  for (const hub of hubs) {
    if (degree(snapshot.edges, hub.id) < 2) continue;
    suggestions.push(`Inspect neighbors of ${concreteLabel(hub)}`);
  }

  if (request.relations) {
    for (const relation of [...new Set(snapshot.edges.map(edge => edge.relation))].sort()) {
      if (request.relations.includes(relation) || !anchor) continue;
      suggestions.push(`Explore ${relation} around ${concreteLabel(anchor)}`);
    }
  }

  return [...new Set(suggestions)].slice(0, 5);
}

function highestDegreeNode(
  snapshot: GraphContextSnapshot,
  nodes: GraphContextNode[],
): GraphContextNode | undefined {
  return [...nodes].sort((left, right) => (
    degree(snapshot.edges, right.id) - degree(snapshot.edges, left.id)
    || left.id.localeCompare(right.id)
  ))[0];
}

function concreteLabel(node: GraphContextNode): string {
  return node.path ? `${node.name} in ${node.path}` : node.name;
}

function degree(edges: GraphContextEdge[], nodeId: string): number {
  return edges.reduce((total, graphEdge) => (
    total + Number(graphEdge.source === nodeId || graphEdge.target === nodeId)
  ), 0);
}

function relationAllowed(
  relation: GraphContextRelation,
  relations: GraphContextRelation[] | undefined,
): boolean {
  return relations === undefined || relations.includes(relation);
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined) return DEFAULT_DEPTH;
  if (!Number.isFinite(depth)) return 0;
  return Math.max(0, Math.floor(depth));
}

function impactScore(depth: number): number {
  return 1 / (depth + 1);
}

function compareTraversalEntries(left: TraversalEntry, right: TraversalEntry): number {
  return right.score - left.score
    || left.depth - right.depth
    || left.nodeId.localeCompare(right.nodeId);
}

function dedupeNodes(nodes: GraphContextNode[]): GraphContextNode[] {
  const byId = new Map<string, GraphContextNode>();
  for (const graphNode of nodes) {
    if (!byId.has(graphNode.id)) byId.set(graphNode.id, graphNode);
  }
  return [...byId.values()];
}

function dedupeCandidates(candidates: GraphContextCandidate[]): GraphContextCandidate[] {
  const byId = new Map<string, GraphContextCandidate>();
  for (const candidate of candidates) {
    if (!byId.has(candidate.node.id)) byId.set(candidate.node.id, candidate);
  }
  return [...byId.values()].sort((left, right) => (
    right.score - left.score || left.node.id.localeCompare(right.node.id)
  ));
}

function collectAmbiguous(
  candidateGroups: GraphContextCandidate[][],
  ambiguousGroups: boolean[],
): GraphContextCandidate[] {
  return dedupeCandidates(candidateGroups.flatMap((candidates, index) => (
    ambiguousGroups[index] ? candidates : []
  )));
}

function emptySelection(): RetrievalSelection {
  return {
    seeds: [],
    nodes: [],
    edges: [],
    paths: [],
    ambiguous: [],
    eligibleNodeCount: 0,
    eligibleEdgeCount: 0,
  };
}
