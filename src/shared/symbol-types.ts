/**
 * Symbol and LSP entity types.
 * Contains types representing symbols, call edges, intra-file graphs,
 * and related structures for symbol-level dependency analysis.
 */

export interface SymbolNode {
  id: string;
  name: string;
  originalName?: string;
  kind: number;
  type: "class" | "function" | "variable";
  range: { start: number; end: number };
  isExported: boolean;
  isExternal: boolean;
  parentSymbolId?: string;
}

export interface CallEdge {
  source: string;
  target: string;
  relation: "calls" | "references";
  direction?: "outgoing" | "incoming";
  line: number;
}

export type CycleType = 
  | "self-recursive"
  | "mutual-recursive"
  | "complex";

export interface IntraFileGraph {
  filePath: string;
  nodes: SymbolNode[];
  edges: CallEdge[];
  incomingEdges?: CallEdge[];
  hasCycle: boolean;
  cycleNodes?: string[];
  cycleType?: CycleType;
}

export interface BreadcrumbPath {
  segments: string[];
  filePath: string;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  isExported: boolean;
  id: string;
  parentSymbolId?: string;
  category: "function" | "class" | "variable" | "interface" | "type" | "other";
}

export interface SymbolDependency {
  sourceSymbolId: string;
  targetSymbolId: string;
  targetFilePath: string;
  relationType?: "dependency" | "call" | "reference";
  callLocations?: { line: number; character: number }[];
  isTypeOnly?: boolean;
}

export interface SymbolCluster {
  id: string;
  type: "namespace" | "class";
  name: string;
  namespace?: string;
  parentClass?: string;
  symbolIds: string[];
  childClusterIds: string[];
  isOpen: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface IntraFileGraphWithClusters extends IntraFileGraph {
  clusters: SymbolCluster[];
}
