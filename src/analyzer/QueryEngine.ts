/**
 * QueryEngine — natural-language query over the call graph index.
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * Flow:
 *   1. extractKeywords(question) — LLM or multilingual heuristic (query/keywords)
 *   2. scoreSeedNodes(keywords) — FTS5 or LIKE match, weighted by keyword
 *      specificity, plus a file-path bonus; filler-only matches are dropped
 *   3. bfsFromSeeds(db, seeds, depth) — multi-seed BFS traversal
 *   4. fetchEdges between visited nodes
 *   5. toCompactJson(nodes, edges, budget) — compact serialization
 */

import { normalizePath } from '@/shared/path';
import type { QueryRequest, QueryResult, QueryResultEdge, QueryResultNode } from '@/shared/query-types';
import { estimateTokens } from '@/shared/toon';
import type { Database, SqlValue } from 'sql.js';
import { bfsFromSeeds, splitIdentifier } from './callgraph/CallGraphQuery';
import {
  compileFileScope,
  type CompiledFileScope,
} from './graph-context/FileScopeMatcher';
import type { LlmClient } from './llm/LlmClient';
import { extractQueryKeywords, foldAccents } from './query/keywords';

const MATCH_LIMIT = 50;
// A keyword matching MATCH_LIMIT names weighs 1; rarer keywords weigh more (up to ~5.7),
// filler words matching more names weigh less than 1.
const SPECIFICITY_SCALE = MATCH_LIMIT;
const FILLER_WEIGHT = 1;
// A keyword found in the file path counts half as much as one found in the name.
const PATH_MATCH_RATIO = 0.5;

const UNSCOPED_FILE_MATCHER: CompiledFileScope = {
  sqlGlob: '*',
  matches: () => true,
};

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
    const fileScope = compileFileScope(request.workspaceRoot, request.fileFilter ?? '');
    const seedNodes = this.scoreSeedNodes(keywords, fileScope);
    const seeds = seedNodes
      .slice(0, this.config.maxSeedNodes)
      .map(n => ({ id: n.id, score: n.relevanceScore }));

    // 3. BFS expansion
    const visitedIds = bfsFromSeeds(this.db, seeds, depth, this.config.maxResultNodes);
    const bfsMs = Date.now() - t2;

    // 4. Fetch full node data for visited IDs
    const nodes = this.fetchNodes(visitedIds, seedNodes, fileScope);

    // 5. Fetch edges between visited nodes
    const scopedNodeIds = new Set(nodes.map(node => node.id));
    const edges = this.fetchEdges(scopedNodeIds);

    // 6. Fit the payload the caller receives into the token budget: the full
    // node/edge objects for JSON output, the compact JSON string (encoded as TOON
    // by the MCP layer) otherwise.
    const fitted = request.outputFormat === 'json'
      ? { ...this.toBudgetedJson(nodes, edges, tokenBudget), json: undefined }
      : { ...this.toCompactJson(nodes, edges, tokenBudget), nodes, edges };
    const { json, truncated, tokenEstimate } = fitted;

    const totalMs = Date.now() - t0;

    return {
      question: request.question,
      extractedKeywords: keywords,
      seedNodeIds: seeds.map(s => s.id),
      nodes: fitted.nodes,
      edges: fitted.edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      json,
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
                'You are a code search assistant. Extract technical keywords from the user\'s question, in English (translate non-English words), as identifier stems likely to appear in code names (e.g. "reference", "compute", "parse"). Return a JSON array of strings only, no explanation.',
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

    return extractQueryKeywords(question);
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

  scoreSeedNodes(
    keywords: string[],
    fileScope: CompiledFileScope = UNSCOPED_FILE_MATCHER,
  ): QueryResultNode[] {
    // Dedupe: LLM keywords bypass extractQueryKeywords (`Reference`, `reference`).
    const tokenLists = [...new Map(
      keywords
        .map(keyword => splitIdentifier(foldAccents(keyword)))
        .filter(tokens => tokens.length > 0)
        .map(tokens => [tokens.join(' '), tokens]),
    ).values()];
    // The first token is the most specific: it drives the LIKE match and the path bonus.
    const pathTerms = tokenLists.map(tokens => tokens[0]);
    const results = new Map<string, QueryResultNode>();
    const nameTerms = new Map<string, Set<string>>();
    const termWeights: Array<[term: string, weight: number]> = [];

    for (const tokens of tokenLists) {
      const { rows, hits } = this.matchKeyword(tokens, pathTerms, fileScope);
      const weight = Math.log2(1 + SPECIFICITY_SCALE / Math.max(hits, 1));
      termWeights.push([tokens[0], weight]);
      for (const row of rows) {
        const id = this._accumulateNode(results, row, fileScope, weight);
        if (id !== undefined) nameTerms.set(id, (nameTerms.get(id) ?? new Set()).add(tokens[0]));
      }
    }

    const weights = new Map(termWeights);
    const scored = [...results.values()].map(node => {
      const covered = addPathAndCoverage(node, nameTerms.get(node.id) ?? new Set(), termWeights);
      return { node, specific: covered.some(term => (weights.get(term) ?? 0) >= FILLER_WEIGHT) };
    });
    // Drop nodes that only match filler keywords (`ou` in countFiles, round, group)
    // when nodes matching a specific keyword exist.
    const hasSpecific = scored.some(candidate => candidate.specific);
    return scored
      .filter(candidate => candidate.specific || !hasSpecific)
      .map(candidate => candidate.node)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /** Rows whose name matches one keyword, and how many names match it in total. */
  private matchKeyword(
    tokens: string[],
    pathTerms: string[],
    fileScope: CompiledFileScope,
  ): { rows: SqlValue[][]; hits: number } {
    if (this.hasFts5()) {
      try {
        const rows = this.db.exec(
          `SELECT n.id, n.name, n.type, n.path, n.start_line
           FROM nodes n
           JOIN nodes_fts f ON n.rowid = f.rowid
           WHERE nodes_fts MATCH ?
             AND n.path GLOB ?
           LIMIT ${MATCH_LIMIT}`,
          [tokens.map(t => `${t}*`).join(' '), fileScope.sqlGlob],
        );
        const values = rows[0]?.values ?? [];
        return { rows: values, hits: values.length };
      } catch {
        // Unexpected FTS error — fall back to LIKE for this keyword
      }
    }
    return this.matchKeywordByLike(tokens[0], pathTerms, fileScope);
  }

  private matchKeywordByLike(
    term: string,
    pathTerms: string[],
    fileScope: CompiledFileScope,
  ): { rows: SqlValue[][]; hits: number } {
    // Keep the LIMIT window on names whose path also holds other keywords
    // (`reference` names under `…/python/…` before unrelated ones).
    const pathRank = pathTerms.map(() => '(path LIKE ?)').join(' + ');
    try {
      const rows = this.db.exec(
        `SELECT id, name, type, path, start_line, COUNT(*) OVER () AS hits
         FROM nodes
         WHERE name LIKE ? COLLATE NOCASE
           AND path GLOB ?
         ORDER BY ${pathRank} DESC, rowid
         LIMIT ${MATCH_LIMIT}`,
        [`%${term}%`, fileScope.sqlGlob, ...pathTerms.map(pathTerm => `%${pathTerm}%`)],
      );
      const values = rows[0]?.values ?? [];
      return { rows: values, hits: Number(values[0]?.[5] ?? 0) };
    } catch {
      return { rows: [], hits: 0 }; // DB error — skip this keyword
    }
  }

  private _accumulateNode(
    results: Map<string, QueryResultNode>,
    row: SqlValue[],
    fileScope: CompiledFileScope,
    weight: number,
  ): string | undefined {
    const nodePath = normalizePath(row[3] as string);
    if (!fileScope.matches(nodePath)) return undefined;

    const id = row[0] as string;
    const existing = results.get(id);
    const score = (existing?.relevanceScore ?? 0) + weight;
    results.set(id, {
      id,
      name: row[1] as string,
      type: row[2] as string,
      path: nodePath,
      startLine: (row[4] as number | null) ?? undefined,
      relevanceScore: score,
    });
    return id;
  }

  // -------------------------------------------------------------------------
  // DB fetch helpers
  // -------------------------------------------------------------------------

  private fetchNodes(
    visitedIds: Set<string>,
    seedNodes: QueryResultNode[],
    fileScope: CompiledFileScope,
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

    // SQL returns rows in index order (alphabetical ids). Restore BFS order —
    // seeds by descending score, then each hop — so token-budget truncation
    // drops the least relevant nodes, not an arbitrary alphabetical tail.
    const rank = new Map(ids.map((id, i) => [id, i]));
    const ordered = [...rows[0].values].sort(
      (a, b) => (rank.get(a[0] as string) ?? 0) - (rank.get(b[0] as string) ?? 0),
    );

    return ordered.flatMap((row): QueryResultNode[] => {
      const nodePath = normalizePath(row[3] as string);
      if (!fileScope.matches(nodePath)) return [];

      const id = row[0] as string;
      return [{
        id,
        name: row[1] as string,
        type: row[2] as string,
        path: nodePath,
        startLine: (row[4] as number | null) ?? undefined,
        relevanceScore: scoreMap.get(id) ?? 0,
      }];
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
  toCompactJson(
    nodes: QueryResultNode[],
    edges: QueryResultEdge[],
    tokenBudget: number,
  ): { json: string; truncated: boolean; tokenEstimate: number } {
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

    const fitted = fitNodesToBudget(compactNodes, compactEdges, tokenBudget, (selectedNodes, selectedEdges, truncated) =>
      JSON.stringify({ ...payload, nodes: selectedNodes, edges: selectedEdges, truncated }),
    );
    return { json: fitted.json, truncated: fitted.truncated, tokenEstimate: fitted.tokens };
  }

  /**
   * Keep the full node/edge objects (JSON output) within the token budget.
   * `tokenEstimate` measures `JSON.stringify({ nodes, edges })` of what is returned.
   */
  toBudgetedJson(
    nodes: QueryResultNode[],
    edges: QueryResultEdge[],
    tokenBudget: number,
  ): { nodes: QueryResultNode[]; edges: QueryResultEdge[]; truncated: boolean; tokenEstimate: number } {
    const fitted = fitNodesToBudget(nodes, edges, tokenBudget, (selectedNodes, selectedEdges) =>
      JSON.stringify({ nodes: selectedNodes, edges: selectedEdges }),
    );
    return { nodes: fitted.nodes, edges: fitted.edges, truncated: fitted.truncated, tokenEstimate: fitted.tokens };
  }
}

/**
 * Largest prefix of `nodes` (relevance order) whose serialization, with the edges
 * between kept nodes, fits `tokenBudget`.
 *
 * Selection uses the REAL tokenizer (estimateTokens), not a chars/4 heuristic:
 * char-length approximations under-truncate by ~2x on realistic identifiers/paths
 * (cl100k_base ratio is well below 4 chars/token), letting the payload blow past
 * tokenBudget after re-verification. Binary search bounds tokenizer calls to
 * O(log n) instead of one call per node.
 */
function fitNodesToBudget<N extends { id: string }, E extends QueryResultEdge | CompactEdge>(
  nodes: N[],
  edges: E[],
  tokenBudget: number,
  serialize: (nodes: N[], edges: E[], truncated: boolean) => string,
): { nodes: N[]; edges: E[]; json: string; tokens: number; truncated: boolean } {
  const fullJson = serialize(nodes, edges, false);
  const fullTokens = estimateTokens(fullJson);
  if (fullTokens <= tokenBudget) {
    return { nodes, edges, json: fullJson, tokens: fullTokens, truncated: false };
  }

  const build = (k: number) => {
    const selectedNodes = nodes.slice(0, k);
    const selectedIds = new Set(selectedNodes.map(n => n.id));
    const selectedEdges = edges.filter(e => {
      const [src, tgt] = edgeEndpoints(e);
      return selectedIds.has(src) && selectedIds.has(tgt);
    });
    const json = serialize(selectedNodes, selectedEdges, true);
    return { nodes: selectedNodes, edges: selectedEdges, json, tokens: estimateTokens(json), truncated: true };
  };

  // Node count k -> token count is monotonic non-decreasing (adding a node can
  // only add matching edges, never remove any), so binary search for the largest
  // k whose real token count still fits the budget is safe.
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).tokens <= tokenBudget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return build(lo);
}

/**
 * Adds the path bonus for keywords found in the file path but not in the name, then
 * multiplies the score by the number of distinct keywords covered, so a node matching
 * `reference` under `…/python/…` outranks one matching a single rare keyword.
 * Returns the covered keywords.
 */
function addPathAndCoverage(
  node: QueryResultNode,
  nameTerms: Set<string>,
  termWeights: Array<[term: string, weight: number]>,
): string[] {
  const path = foldAccents(node.path);
  const covered = new Set(nameTerms);
  let score = node.relevanceScore;
  for (const [term, weight] of termWeights) {
    if (covered.has(term) || !path.includes(term)) continue;
    score += weight * PATH_MATCH_RATIO;
    covered.add(term);
  }
  node.relevanceScore = Math.round(score * covered.size * 100) / 100;
  return [...covered];
}

interface CompactEdge {
  src: string;
  tgt: string;
}

function edgeEndpoints(edge: QueryResultEdge | CompactEdge): [string, string] {
  return 'src' in edge ? [edge.src, edge.tgt] : [edge.source, edge.target];
}

// Re-export RawNodeRow for test use
export type { RawNodeRow };
