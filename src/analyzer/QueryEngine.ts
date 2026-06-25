/**
 * QueryEngine — natural-language query over the call graph index.
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * Flow:
 *   1. extractKeywords(question) — LLM or heuristic
 *   2. scoreSeedNodes(keywords) — FTS5 SQL query
 *   3. bfsFromSeeds(db, seeds, depth) — multi-seed BFS traversal
 *   4. fetchEdges between visited nodes
 *   5. toToon(nodes, edges, budget) — compact serialization
 */

import { normalizePath } from '@/shared/path';
import type { QueryRequest, QueryResult, QueryResultEdge, QueryResultNode } from '@/shared/query-types';
import { estimateTokenSavings } from '@/shared/toon';
import type { Database } from 'sql.js';
import { bfsFromSeeds, splitIdentifier } from './callgraph/CallGraphQuery';
import type { LlmClient } from './llm/LlmClient';

// ---------------------------------------------------------------------------
// Stop words (EN + FR + code noise)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the','and','for','with','from','that','this','have','not','how','does','what','where','why','when',
  'les','des','une','dans','pour','avec','sur','par','qui','comment','est','sont','fait',
  'src','dist','index','utils','types','test','spec','impl',
  'function','class','method','interface','export','import','default','const','return','async','await',
]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface QueryEngineConfig {
  defaultDepth: number;         // 2
  defaultTokenBudget: number;   // 4000
  maxSeedNodes: number;         // 20
  maxResultNodes: number;       // 200
}

export const DEFAULT_QUERY_ENGINE_CONFIG: QueryEngineConfig = {
  defaultDepth: 2,
  defaultTokenBudget: 4000,
  maxSeedNodes: 20,
  maxResultNodes: 200,
};

// ---------------------------------------------------------------------------
// Internal raw types from SQL result
// ---------------------------------------------------------------------------

interface RawNodeRow {
  id: string;
  name: string;
  type: string;
  path: string;
  start_line: number | null;
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
  constructor(
    private readonly db: Database,
    private readonly llmClient: LlmClient | null,
    private readonly config: QueryEngineConfig = DEFAULT_QUERY_ENGINE_CONFIG,
  ) {}

  // -------------------------------------------------------------------------
  // Main entry point
  // -------------------------------------------------------------------------

  async query(request: QueryRequest): Promise<QueryResult> {
    const t0 = Date.now();
    const depth = request.depth ?? this.config.defaultDepth;
    const tokenBudget = request.tokenBudget ?? this.config.defaultTokenBudget;

    // 1. Extract keywords
    const t1 = Date.now();
    const keywords = await this.extractKeywords(request.question);
    const keywordExtractionMs = Date.now() - t1;

    const llmProvider = this.llmClient?.providerName ?? 'none';

    // 2. Score seed nodes via FTS5
    const t2 = Date.now();
    const seedNodes = this.scoreSeedNodes(keywords);
    const seeds = seedNodes
      .slice(0, this.config.maxSeedNodes)
      .map(n => ({ id: n.id, score: n.relevanceScore }));

    // 3. BFS expansion
    const visitedIds = bfsFromSeeds(this.db, seeds, depth, this.config.maxResultNodes);
    const bfsMs = Date.now() - t2;

    // 4. Fetch full node data for visited IDs
    const nodes = this.fetchNodes(visitedIds, seedNodes);

    // 5. Fetch edges between visited nodes
    const edges = this.fetchEdges(visitedIds);

    // 6. Serialize to TOON if requested
    const { toon, truncated, tokenEstimate } = this.toToon(nodes, edges, tokenBudget);

    const totalMs = Date.now() - t0;

    return {
      question: request.question,
      extractedKeywords: keywords,
      seedNodeIds: seeds.map(s => s.id),
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      toon,
      meta: {
        llmProvider,
        keywordExtractionMs,
        bfsMs,
        totalMs,
        tokenEstimate,
        truncated,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Keyword extraction
  // -------------------------------------------------------------------------

  async extractKeywords(question: string): Promise<string[]> {
    if (this.llmClient !== null) {
      try {
        const result = await this.llmClient.complete(
          [
            {
              role: 'system',
              content:
                'You are a code search assistant. Extract technical keywords from the user\'s question. Return a JSON array of strings only, no explanation.',
            },
            {
              role: 'user',
              content: `Question: ${question}\n\nReturn 3-7 technical keywords as a JSON array.`,
            },
          ],
          { maxTokens: 256, temperature: 0.0 },
        );

        const text = result.text.trim();
        // Parse the JSON array from the LLM response
        const match = /\[[\s\S]*\]/.exec(text);
        if (match) {
          const parsed: unknown = JSON.parse(match[0]);
          if (Array.isArray(parsed) && parsed.every(k => typeof k === 'string')) {
            return (parsed as string[]).filter(k => k.length > 0);
          }
        }
      } catch {
        // Fall through to heuristic
      }
    }

    // Heuristic fallback: split identifiers, remove stopwords
    return splitIdentifier(question).filter(t => !STOPWORDS.has(t));
  }

  // -------------------------------------------------------------------------
  // FTS5 availability cache
  // -------------------------------------------------------------------------

  private _fts5Available: boolean | undefined;

  private hasFts5(): boolean {
    if (this._fts5Available !== undefined) return this._fts5Available;
    try {
      this.db.exec(`SELECT name FROM nodes_fts LIMIT 1`);
      this._fts5Available = true;
    } catch {
      this._fts5Available = false;
    }
    return this._fts5Available;
  }

  // -------------------------------------------------------------------------
  // FTS5 seed scoring (with LIKE fallback)
  // -------------------------------------------------------------------------

  scoreSeedNodes(keywords: string[]): QueryResultNode[] {
    if (keywords.length === 0) return [];

    const results = new Map<string, QueryResultNode>();

    for (const keyword of keywords) {
      const tokens = splitIdentifier(keyword);
      if (tokens.length === 0) continue;

      if (this.hasFts5()) {
        // FTS5 prefix search
        const ftsQuery = tokens.map(t => `${t}*`).join(' ');
        try {
          const rows = this.db.exec(
            `SELECT n.id, n.name, n.type, n.path, n.start_line
             FROM nodes n
             JOIN nodes_fts f ON n.rowid = f.rowid
             WHERE nodes_fts MATCH ?
             LIMIT 50`,
            [ftsQuery],
          );
          for (const row of rows[0]?.values ?? []) {
            this._accumulateNode(results, row);
          }
        } catch {
          // Unexpected error — fall back to LIKE for this keyword
          this._scoreBySingleLike(results, keyword);
        }
      } else {
        // LIKE fallback — case-insensitive prefix match on each token
        this._scoreBySingleLike(results, keyword);
      }
    }

    return [...results.values()].sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private _scoreBySingleLike(results: Map<string, QueryResultNode>, keyword: string): void {
    const tokens = splitIdentifier(keyword);
    if (tokens.length === 0) return;
    // Use the first token (most specific) for LIKE match to keep result set small
    const pattern = `%${tokens[0]}%`;
    try {
      const rows = this.db.exec(
        `SELECT id, name, type, path, start_line
         FROM nodes
         WHERE name LIKE ? COLLATE NOCASE
         LIMIT 50`,
        [pattern],
      );
      for (const row of rows[0]?.values ?? []) {
        this._accumulateNode(results, row);
      }
    } catch {
      // DB error — skip
    }
  }

  private _accumulateNode(
    results: Map<string, QueryResultNode>,
    // sql.js SqlValue = string | number | null | Uint8Array — we only use string/number cols
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any[],
  ): void {
    const id = row[0] as string;
    const existing = results.get(id);
    const score = (existing?.relevanceScore ?? 0) + 1;
    results.set(id, {
      id,
      name: row[1] as string,
      type: row[2] as string,
      path: normalizePath(row[3] as string),
      startLine: (row[4] as number | null) ?? undefined,
      relevanceScore: score,
    });
  }

  // -------------------------------------------------------------------------
  // DB fetch helpers
  // -------------------------------------------------------------------------

  private fetchNodes(
    visitedIds: Set<string>,
    seedNodes: QueryResultNode[],
  ): QueryResultNode[] {
    if (visitedIds.size === 0) return [];

    // Build a score map from seeds
    const scoreMap = new Map<string, number>(
      seedNodes.map(n => [n.id, n.relevanceScore]),
    );

    const ids = [...visitedIds];
    const placeholders = ids.map(() => '?').join(', ');

    const rows = this.db.exec(
      `SELECT id, name, type, path, start_line
       FROM nodes
       WHERE id IN (${placeholders})`,
      ids,
    );

    if (!rows[0]) return [];

    return rows[0].values.map((row): QueryResultNode => {
      const id = row[0] as string;
      return {
        id,
        name: row[1] as string,
        type: row[2] as string,
        path: normalizePath(row[3] as string),
        startLine: (row[4] as number | null) ?? undefined,
        relevanceScore: scoreMap.get(id) ?? 0,
      };
    });
  }

  private fetchEdges(visitedIds: Set<string>): QueryResultEdge[] {
    if (visitedIds.size === 0) return [];

    const ids = [...visitedIds];
    const placeholders = ids.map(() => '?').join(', ');
    const args = [...ids, ...ids];

    const rows = this.db.exec(
      `SELECT source_id, target_id, type_relation, is_cyclic
       FROM edges
       WHERE source_id IN (${placeholders})
         AND target_id IN (${placeholders})`,
      args,
    );

    if (!rows[0]) return [];

    return rows[0].values.map((row): QueryResultEdge => ({
      source: row[0] as string,
      target: row[1] as string,
      relation: row[2] as QueryResultEdge['relation'],
      isCyclic: (row[3] as number) === 1,
    }));
  }

  // -------------------------------------------------------------------------
  // TOON serialization
  // -------------------------------------------------------------------------

  /**
   * Serialize nodes and edges to a compact JSON string with short keys.
   * Estimates token usage and truncates if budget is exceeded.
   *
   * Format: {nodes:[{id,n,t,p,l,r},...],edges:[{src,tgt,rel},...],
   *          nodeCount,edgeCount,question,keywords,truncated}
   */
  toToon(
    nodes: QueryResultNode[],
    edges: QueryResultEdge[],
    tokenBudget: number,
  ): { toon: string; truncated: boolean; tokenEstimate: number } {
    const compactNodes = nodes.map(n => ({
      id: n.id,
      n: n.name,
      t: n.type,
      p: n.path,
      l: n.startLine,
      r: n.relevanceScore,
    }));

    const compactEdges = edges.map(e => ({
      src: e.source,
      tgt: e.target,
      rel: e.relation,
    }));

    const payload = {
      nodes: compactNodes,
      edges: compactEdges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      truncated: false,
    };

    const fullJson = JSON.stringify(payload);
    const { jsonTokens } = estimateTokenSavings(fullJson, fullJson);

    if (jsonTokens <= tokenBudget) {
      return { toon: fullJson, truncated: false, tokenEstimate: jsonTokens };
    }

    // Truncate nodes to fit within budget
    const overhead = JSON.stringify({ ...payload, nodes: [], edges: [], truncated: true }).length;
    const budgetChars = tokenBudget * 4 - overhead;

    let nodeChars = 0;
    const fittingNodes: typeof compactNodes = [];
    for (const n of compactNodes) {
      const s = JSON.stringify(n);
      if (nodeChars + s.length > budgetChars) break;
      fittingNodes.push(n);
      nodeChars += s.length + 1; // +1 for comma
    }

    const fittingNodeIds = new Set(fittingNodes.map(n => n.id));
    const fittingEdges = compactEdges.filter(
      e => fittingNodeIds.has(e.src) && fittingNodeIds.has(e.tgt),
    );

    const truncatedPayload = {
      nodes: fittingNodes,
      edges: fittingEdges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      truncated: true,
    };

    const truncatedJson = JSON.stringify(truncatedPayload);
    const { jsonTokens: truncTokens } = estimateTokenSavings(truncatedJson, truncatedJson);

    return { toon: truncatedJson, truncated: true, tokenEstimate: truncTokens };
  }
}

// Re-export RawNodeRow for test use
export type { RawNodeRow };
