/** Shared, serializable contract for federated graph-context queries. */

import type { RelationType } from './callgraph-types.js';

export type GraphContextMode =
  | 'search'
  | 'neighbors'
  | 'path'
  | 'impact'
  | 'refactor'
  | 'overview';

export type GraphContextDetail = 'compact' | 'standard' | 'full';

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

interface GraphContextRequestOptions {
  mode?: GraphContextMode;
  relations?: GraphContextRelation[];
  scope?: string;
  depth?: number;
  maxNodes?: number;
  tokenBudget?: number;
  directed?: boolean;
  cursor?: string;
  format?: 'toon' | 'json';
  detail?: GraphContextDetail;
}

/** A request must contain a question, a non-empty seed list, or both path endpoints. */
export type GraphContextRequest = GraphContextRequestOptions & (
  | {
      question: string;
      seeds?: GraphContextSeed[];
      from?: GraphContextSeed;
      to?: GraphContextSeed;
    }
  | {
      question?: never;
      seeds: [GraphContextSeed, ...GraphContextSeed[]];
      from?: never;
      to?: never;
    }
  | {
      question?: string;
      seeds?: GraphContextSeed[];
      from: GraphContextSeed;
      to: GraphContextSeed;
    }
);

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
  /** Positional indexes into the response edge array; the formal spec is canonical over edge IDs. */
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
