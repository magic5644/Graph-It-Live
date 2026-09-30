import { estimateTokens } from './toon';
import type {
  GraphContextDetail,
  GraphContextEdge,
  GraphContextNode,
  GraphContextResponse,
} from './graph-context-types';

/**
 * Projects graph context for LLM output without changing the indexed result.
 *
 * Detail levels choose fields, not node counts: the token budget and `maxNodes`
 * decide how many nodes fit. A fixed node cap here used to truncate a compact
 * answer to 8 nodes while most of the budget stayed unused.
 */
export function projectGraphContextOutput(
  response: GraphContextResponse,
  detail: GraphContextDetail | undefined,
): GraphContextResponse {
  if (detail !== 'compact') return response;

  const compacted: GraphContextResponse = {
    ...response,
    nodes: response.nodes.map(compactNode),
    edges: response.edges.map(compactEdge),
    ambiguous: response.ambiguous.map(candidate => ({
      ...candidate,
      node: compactNode(candidate.node),
    })),
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
