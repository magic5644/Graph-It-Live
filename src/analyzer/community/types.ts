export interface CommunityGraph {
  nodes: string[];
  edges: Array<{ source: string; target: string; weight?: number }>;  // weight defaults to 1
}

export interface CommunityResult {
  assignments: Map<string, number>;  // normalizePath(node) → communityId (1+), 0 = isolé
  count: number;
}
