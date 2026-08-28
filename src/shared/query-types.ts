/**
 * Query types for the `graph-it query` feature.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import type { RelationType } from './callgraph-types';

export interface QueryRequest {
  question: string;
  workspaceRoot: string;
  depth?: number;          // default: 2
  tokenBudget?: number;    // default: 4000
  fileFilter?: string;
  outputFormat?: 'toon' | 'json' | 'text';
}

export interface QueryResultNode {
  id: string;
  name: string;
  type: string;
  path: string;
  startLine?: number;
  relevanceScore: number;
}

export interface QueryResultEdge {
  source: string;       // 'source' not 'sourceId' — compatible cycleUtils
  target: string;       // 'target' not 'targetId'
  relation: RelationType;
  isCyclic?: boolean;
}

export interface QueryResult {
  question: string;
  extractedKeywords: string[];
  seedNodeIds: string[];
  nodes: QueryResultNode[];
  edges: QueryResultEdge[];
  nodeCount: number;
  edgeCount: number;
  /**
   * Compact JSON string (short keys: n/t/p/l/r for nodes, src/tgt/rel for edges).
   * Naming asymmetry: this is JAMAIS du vrai TOON à cette couche — it is
   * mcp/tools/query.ts (QueryNaturalLanguageResult.toon) that encodes the
   * actual TOON format from this field.
   */
  json?: string;
  meta: {
    llmProvider: 'anthropic' | 'openai-compatible' | 'vscode-lm' | 'none';
    keywordExtractionMs: number;
    bfsMs: number;
    totalMs: number;
    tokenEstimate: number;
    truncated: boolean;
  };
}

export type LlmProviderName = 'anthropic' | 'openai-compatible' | 'vscode-lm';
