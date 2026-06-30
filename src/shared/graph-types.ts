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

/**
 * Per-node metadata for the file-level dependency graph.
 * All fields except hubScore are optional — absent means "not available", never default to 0.
 */
export interface GraphNodeMetadata {
  /** Normalized hub score in [0-1]: incoming degree / max incoming degree across workspace. Guard: max === 0 → 0. */
  hubScore: number;
  /** Raw line count from file content. Absent means not computed — consumers MUST NOT use ?? 0. */
  loc?: number;
  /** File extension without leading dot, lowercase (e.g. "ts", "tsx", "py"). Absent if unknown or empty. */
  fileExtension?: string;
  /**
   * Community assignment from Louvain detection.
   * 0 = isolated node (no edges). 1+ = cluster id. absent = not yet computed.
   */
  communityId?: number;
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
  /** Optional per-node metadata. Key = normalizePath(filePath). */
  nodeMetadata?: Record<string, GraphNodeMetadata>;
}
