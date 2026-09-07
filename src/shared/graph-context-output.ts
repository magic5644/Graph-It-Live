import { estimateTokens } from './toon';
import type {
  GraphContextDetail,
  GraphContextEdge,
  GraphContextNode,
  GraphContextResponse,
} from './graph-context-types';

const COMPACT_NODE_LIMIT = 8;

/** Projects graph context for LLM output without changing the indexed result. */
export function projectGraphContextOutput(
  response: GraphContextResponse,
  detail: GraphContextDetail | undefined,
): GraphContextResponse {
  if (detail !== 'compact') return response;

  const seedIds = response.seeds
    .toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, 1)
    .map(seed => seed.id);
  const mandatoryIds = new Set(seedIds);
  for (const path of response.paths) path.nodeIds.forEach(nodeId => mandatoryIds.add(nodeId));
  const rankedNodes = [
    ...response.nodes.filter(node => mandatoryIds.has(node.id)),
    ...response.nodes
      .filter(node => !mandatoryIds.has(node.id))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0)),
  ];
  const selectedIds = new Set(
    rankedNodes.slice(0, Math.max(COMPACT_NODE_LIMIT, mandatoryIds.size)).map(node => node.id),
  );
  const nodes = response.nodes.filter(node => selectedIds.has(node.id)).map(compactNode);
  const retainedEdges = response.edges.flatMap((edge, index) => (
    selectedIds.has(edge.source) && selectedIds.has(edge.target) ? [{ edge, index }] : []
  ));
  const edges = retainedEdges.map(({ edge }) => compactEdge(edge));
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
    seeds: response.seeds.filter(seed => selectedIds.has(seed.id)).map(compactNode),
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
    nextCursor: undefined,
    nextQueries: response.nextQueries.slice(0, 3),
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
