import { estimateTokens } from './toon';
import type {
  GraphContextDetail,
  GraphContextEdge,
  GraphContextNode,
  GraphContextResponse,
} from './graph-context-types';

/**
 * Node budget per detail level.
 *
 * `standard` is the default and used to be identical to `full` — three names,
 * two behaviours — which left nothing between an 8-node summary and the entire
 * result. It now caps the node count while keeping every field.
 */
const NODE_LIMIT_BY_DETAIL: Record<GraphContextDetail, number> = {
  compact: 8,
  standard: 40,
  full: Number.POSITIVE_INFINITY,
};

/** Projects graph context for LLM output without changing the indexed result. */
export function projectGraphContextOutput(
  response: GraphContextResponse,
  detail: GraphContextDetail | undefined,
): GraphContextResponse {
  const level: GraphContextDetail = detail ?? 'standard';
  if (level === 'full') return response;

  const nodeLimit = NODE_LIMIT_BY_DETAIL[level];
  // `standard` keeps whole nodes and edges; only `compact` strips fields.
  const project = level === 'compact';
  if (!project && response.nodes.length <= nodeLimit) return response;

  const scoreById = new Map(response.nodes.map(node => [node.id, node.score ?? 0]));
  const topSeedIds = response.seeds
    .toSorted((left, right) => (scoreById.get(right) ?? 0) - (scoreById.get(left) ?? 0))
    .slice(0, 1);
  const mandatoryIds = new Set(topSeedIds);
  for (const path of response.paths) path.nodeIds.forEach(nodeId => mandatoryIds.add(nodeId));
  const rankedNodes = [
    ...response.nodes.filter(node => mandatoryIds.has(node.id)),
    ...response.nodes
      .filter(node => !mandatoryIds.has(node.id))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0)),
  ];
  const selectedIds = new Set(
    rankedNodes.slice(0, Math.max(nodeLimit, mandatoryIds.size)).map(node => node.id),
  );
  const nodes = response.nodes
    .filter(node => selectedIds.has(node.id))
    .map(node => (project ? compactNode(node) : node));
  const retainedEdges = response.edges.flatMap((edge, index) => (
    selectedIds.has(edge.source) && selectedIds.has(edge.target) ? [{ edge, index }] : []
  ));
  const edges = retainedEdges.map(({ edge }) => (project ? compactEdge(edge) : edge));
  const compactIndexes = new Map(retainedEdges.map(({ index }, compactIndex) => [index, compactIndex]));
  const paths = response.paths.flatMap(path => {
    if (!path.nodeIds.every(nodeId => selectedIds.has(nodeId))) return [];
    const remappedIndexes = path.edgeIndexes.flatMap(index => {
      const compactIndex = compactIndexes.get(index);
      return compactIndex === undefined ? [] : [compactIndex];
    });
    return remappedIndexes.length === path.edgeIndexes.length
      ? [{ ...path, edgeIndexes: remappedIndexes }]
      : [];
  });
  const compacted: GraphContextResponse = {
    ...response,
    seeds: response.seeds.filter(seedId => selectedIds.has(seedId)),
    nodes,
    edges,
    paths,
    ambiguous: response.ambiguous.map(candidate => ({
      ...candidate,
      node: compactNode(candidate.node),
    })),
    omitted: {
      nodes: response.omitted.nodes + response.nodes.length - nodes.length,
      edges: response.omitted.edges + response.edges.length - edges.length,
    },
    truncated: response.truncated || nodes.length < response.nodes.length || edges.length < response.edges.length,
    // compact is a summary, so it does not offer a next page; standard still paginates.
    nextCursor: project ? undefined : response.nextCursor,
    nextQueries: project ? response.nextQueries.slice(0, 3) : response.nextQueries,
    tokenEstimate: 0,
  };
  return { ...compacted, tokenEstimate: estimateTokens(JSON.stringify(compacted)) };
}

function compactNode(node: GraphContextNode): GraphContextNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    ...(node.path === undefined ? {} : { path: node.path }),
    ...(node.startLine === undefined ? {} : { startLine: node.startLine }),
    ...(node.endLine === undefined ? {} : { endLine: node.endLine }),
    ...(node.isSeed === undefined ? {} : { isSeed: node.isSeed }),
  };
}

function compactEdge(edge: GraphContextEdge): GraphContextEdge {
  return {
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    confidence: edge.confidence,
    ...(edge.evidence === undefined ? {} : { evidence: edge.evidence }),
  };
}
