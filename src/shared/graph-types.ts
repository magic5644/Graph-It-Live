/**
 * File-level dependency graph types.
 * Contains types representing nodes, edges, and data structures
 * for the file-level dependency graph visualization.
 */

export interface GraphEdge {
  source: string;
  target: string;
  relationType?: "dependency" | "call" | "reference";
}

export interface GraphData {
  nodes: string[];
  edges: GraphEdge[];
  /** Optional custom labels for nodes (key: node path, value: display label) */
  nodeLabels?: Record<string, string>;
  /** Optional map of parent counts (how many files import a node). If present, used to show/hide the Find References toggle button in the UI. */
  parentCounts?: Record<string, number>;
  /** Optional list of edge IDs (source-target) that represent unused dependencies (imports that are not used in code). */
  unusedEdges?: string[];
}
