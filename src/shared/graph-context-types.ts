/** Shared, serializable contract for federated graph-context queries. */

import type { RelationType } from './callgraph-types.js';

export type GraphContextMode =
  | 'search'
  | 'neighbors'
  | 'path'
  | 'impact'
  | 'refactor'
  | 'overview';

export type GraphContextNodeKind =
  | 'file'
  | 'symbol'
  | 'test'
  | 'community'
  | 'document'
  | 'rationale'
  | 'external';

export type GraphContextRelation =
  | RelationType
  | 'CONTAINS'
  | 'IMPORTS'
  | 'TESTED_BY'
  | 'IMPACTED_BY'
  | 'BELONGS_TO'
  | 'REFERENCES'
  | 'EXPLAINS'
  | 'DOCUMENTS';

export type GraphContextConfidence =
  | 'EXTRACTED'
  | 'RESOLVED'
  | 'INFERRED'
  | 'AMBIGUOUS'
  | 'STALE';

export interface GraphContextSeed {
  id?: string;
  filePath?: string;
  symbolName?: string;
  label?: string;
}

export interface GraphContextRequest {
  question?: string;
  seeds?: GraphContextSeed[];
  mode?: GraphContextMode;
  from?: GraphContextSeed;
  to?: GraphContextSeed;
  relations?: GraphContextRelation[];
  scope?: string;
  depth?: number;
  maxNodes?: number;
  tokenBudget?: number;
  directed?: boolean;
  cursor?: string;
  format?: 'toon' | 'json';
}

export interface GraphContextNode {
  id: string;
  kind: GraphContextNodeKind;
  name: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  score?: number;
  isSeed?: boolean;
}

export interface GraphContextEvidence {
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  reason: string;
}

export interface GraphContextEdge {
  source: string;
  target: string;
  relation: GraphContextRelation;
  confidence: GraphContextConfidence;
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  evidence?: GraphContextEvidence;
}

export interface GraphContextPath {
  nodeIds: string[];
  edgeIndexes: number[];
  hops: number;
}

export interface GraphContextCandidate {
  node: GraphContextNode;
  score: number;
  reason: string;
}

export interface GraphContextResolution {
  selected?: GraphContextNode;
  candidates: GraphContextCandidate[];
  ambiguous: boolean;
  notFound: boolean;
}

export interface GraphContextSnapshot {
  revision: string;
  fresh: boolean;
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
}

export interface GraphContextResponse {
  indexRevision: string;
  fresh: boolean;
  mode: GraphContextMode;
  seeds: GraphContextNode[];
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
  paths: GraphContextPath[];
  ambiguous: GraphContextCandidate[];
  omitted: { nodes: number; edges: number };
  nextQueries: string[];
  nextCursor?: string;
  tokenEstimate: number;
  truncated: boolean;
}
