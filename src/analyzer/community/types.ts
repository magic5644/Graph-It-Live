export interface CommunityGraph {
  nodes: string[];
  edges: Array<{ source: string; target: string }>;
}

export interface CommunityResult {
  assignments: Map<string, number>;  // normalizePath(node) → communityId (1+), 0 = isolé
  count: number;
}
