import { estimateTokens } from '@/shared/toon';
import type {
  GraphContextEdge,
  GraphContextNode,
  GraphContextPath,
  GraphContextRelation,
  GraphContextResponse,
} from '@/shared/graph-context-types';

const RUNTIME_IMPACT_RELATIONS = new Set<GraphContextRelation>([
  'CALLS',
  'IMPLEMENTS',
  'INHERITS',
  'USES',
  'IMPACTED_BY',
]);

interface IndexedEdge {
  edge: GraphContextEdge;
  originalIndex: number;
}

/** Applies a hard tokenizer-measured budget while preserving required graph identities. */
export function applyGraphContextBudget(
  response: GraphContextResponse,
  tokenBudget: number,
): GraphContextResponse {
  validateTokenBudget(tokenBudget);

  const rankedNodes = rankNodes(response);
  const nodeById = new Map(response.nodes.map(node => [node.id, node]));
  const mandatoryIds = collectMandatoryNodeIds(response, nodeById);
  const allIds = new Set(nodeById.keys());
  const fullResponse = buildBudgetedResponse(response, allIds, response.nodes);

  if (fullResponse.tokenEstimate <= tokenBudget) return fullResponse;

  const selectedIds = new Set(mandatoryIds);
  let selectedResponse = buildBudgetedResponse(response, selectedIds, rankedNodes);
  if (selectedResponse.tokenEstimate > tokenBudget) {
    throw new RangeError(
      `Token budget ${tokenBudget} cannot contain mandatory seeds and path endpoints `
      + `(${selectedResponse.tokenEstimate} tokens required).`,
    );
  }

  for (const candidate of rankedNodes) {
    if (selectedIds.has(candidate.id)) continue;

    selectedIds.add(candidate.id);
    const candidateResponse = buildBudgetedResponse(response, selectedIds, rankedNodes);
    if (candidateResponse.tokenEstimate <= tokenBudget) {
      selectedResponse = candidateResponse;
    } else {
      selectedIds.delete(candidate.id);
    }
  }

  return selectedResponse;
}

function validateTokenBudget(tokenBudget: number): void {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
    throw new RangeError('Token budget must be a positive safe integer.');
  }
}

function rankNodes(response: GraphContextResponse): GraphContextNode[] {
  const nodeById = new Map(response.nodes.map(node => [node.id, node]));
  const originalIndex = new Map(response.nodes.map((node, index) => [node.id, index]));
  const rankedIds: string[] = [];
  const rankedIdSet = new Set<string>();
  const addId = (id: string): void => {
    if (nodeById.has(id) && !rankedIdSet.has(id)) {
      rankedIdSet.add(id);
      rankedIds.push(id);
    }
  };

  for (const seed of response.seeds) addId(seed.id);

  const pathEndpointIds = new Set<string>();
  for (const path of response.paths) {
    const firstId = path.nodeIds[0];
    const lastId = path.nodeIds.at(-1);
    if (firstId !== undefined) {
      pathEndpointIds.add(firstId);
      addId(firstId);
    }
    if (lastId !== undefined) {
      pathEndpointIds.add(lastId);
      addId(lastId);
    }
  }

  for (const path of response.paths) {
    for (const edgeIndex of path.edgeIndexes) {
      const pathEdge = response.edges[edgeIndex];
      if (!pathEdge) continue;
      addId(pathEdge.source);
      addId(pathEdge.target);
    }
    for (const nodeId of path.nodeIds) addId(nodeId);
  }

  const directAnchorIds = new Set([
    ...response.seeds.map(seed => seed.id),
    ...pathEndpointIds,
  ]);
  for (const graphEdge of response.edges) {
    if (directAnchorIds.has(graphEdge.source)) addId(graphEdge.target);
    if (directAnchorIds.has(graphEdge.target)) addId(graphEdge.source);
  }

  for (const graphNode of sortByScore(response.nodes, originalIndex)) {
    if (graphNode.kind === 'test') addId(graphNode.id);
  }

  for (const graphEdge of response.edges) {
    if (!RUNTIME_IMPACT_RELATIONS.has(graphEdge.relation)) continue;
    addId(graphEdge.source);
    addId(graphEdge.target);
  }

  for (const graphEdge of response.edges) {
    if (graphEdge.confidence !== 'RESOLVED') continue;
    addId(graphEdge.source);
    addId(graphEdge.target);
  }

  const degrees = countDegrees(response.edges, nodeById);
  const hubs = response.nodes
    .filter(graphNode => (degrees.get(graphNode.id) ?? 0) > 0)
    .sort((left, right) => (
      (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0)
      || compareNodeScore(left, right, originalIndex)
    ));
  for (const hub of hubs) addId(hub.id);

  for (const graphNode of sortByScore(response.nodes, originalIndex)) addId(graphNode.id);

  return rankedIds.flatMap(id => {
    const graphNode = nodeById.get(id);
    return graphNode ? [graphNode] : [];
  });
}

function collectMandatoryNodeIds(
  response: GraphContextResponse,
  nodeById: Map<string, GraphContextNode>,
): Set<string> {
  const mandatoryIds = new Set<string>();
  for (const seed of response.seeds) {
    if (nodeById.has(seed.id)) mandatoryIds.add(seed.id);
  }
  for (const path of response.paths) {
    const firstId = path.nodeIds[0];
    const lastId = path.nodeIds.at(-1);
    if (firstId !== undefined && nodeById.has(firstId)) mandatoryIds.add(firstId);
    if (lastId !== undefined && nodeById.has(lastId)) mandatoryIds.add(lastId);
  }
  return mandatoryIds;
}

function buildBudgetedResponse(
  source: GraphContextResponse,
  selectedIds: Set<string>,
  nodeOrder: GraphContextNode[],
): GraphContextResponse {
  const nodes = nodeOrder.filter(node => selectedIds.has(node.id));
  const retainedNodeIds = new Set(nodes.map(node => node.id));
  const indexedEdges: IndexedEdge[] = source.edges.flatMap((edge, originalIndex) => (
    retainedNodeIds.has(edge.source) && retainedNodeIds.has(edge.target)
      ? [{ edge, originalIndex }]
      : []
  ));
  const edges = indexedEdges.map(indexedEdge => indexedEdge.edge);
  const edgeIndexMap = new Map(indexedEdges.map((indexedEdge, selectedIndex) => (
    [indexedEdge.originalIndex, selectedIndex]
  )));
  const paths = remapCompletePaths(source.paths, retainedNodeIds, edgeIndexMap);
  const omitted = {
    nodes: source.omitted.nodes + source.nodes.length - nodes.length,
    edges: source.omitted.edges + source.edges.length - edges.length,
  };
  const response: GraphContextResponse = {
    ...source,
    seeds: source.seeds.map(seed => ({ ...seed })),
    nodes,
    edges,
    paths,
    omitted,
    truncated: source.truncated
      || omitted.nodes > 0
      || omitted.edges > 0
      || paths.length < source.paths.length,
    tokenEstimate: 0,
  };

  return stabilizeTokenEstimate(response);
}

function remapCompletePaths(
  paths: GraphContextPath[],
  retainedNodeIds: Set<string>,
  edgeIndexMap: Map<number, number>,
): GraphContextPath[] {
  return paths.flatMap((path): GraphContextPath[] => {
    if (!path.nodeIds.every(nodeId => retainedNodeIds.has(nodeId))) return [];

    const edgeIndexes: number[] = [];
    for (const edgeIndex of path.edgeIndexes) {
      const remappedIndex = edgeIndexMap.get(edgeIndex);
      if (remappedIndex === undefined) return [];
      edgeIndexes.push(remappedIndex);
    }

    return [{
      nodeIds: [...path.nodeIds],
      edgeIndexes,
      hops: edgeIndexes.length,
    }];
  });
}

function stabilizeTokenEstimate(response: GraphContextResponse): GraphContextResponse {
  let result = response;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tokenEstimate = estimateTokens(JSON.stringify(result));
    if (tokenEstimate === result.tokenEstimate) return result;
    result = { ...result, tokenEstimate };
  }
  return result;
}

function sortByScore(
  nodes: GraphContextNode[],
  originalIndex: Map<string, number>,
): GraphContextNode[] {
  return [...nodes].sort((left, right) => compareNodeScore(left, right, originalIndex));
}

function compareNodeScore(
  left: GraphContextNode,
  right: GraphContextNode,
  originalIndex: Map<string, number>,
): number {
  return normalizeScore(right.score) - normalizeScore(left.score)
    || (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0)
    || left.id.localeCompare(right.id);
}

function normalizeScore(score: number | undefined): number {
  return score !== undefined && Number.isFinite(score) ? score : 0;
}

function countDegrees(
  edges: GraphContextEdge[],
  nodeById: Map<string, GraphContextNode>,
): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const graphEdge of edges) {
    if (nodeById.has(graphEdge.source)) {
      degrees.set(graphEdge.source, (degrees.get(graphEdge.source) ?? 0) + 1);
    }
    if (nodeById.has(graphEdge.target)) {
      degrees.set(graphEdge.target, (degrees.get(graphEdge.target) ?? 0) + 1);
    }
  }
  return degrees;
}
