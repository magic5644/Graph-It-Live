/// <reference types="node" />

/**
 * Unit tests for QueryEngine.
 *
 * Uses real sql.js WASM (works in Node.js 22) and mock LlmClient.
 * FTS5 is available in the bundled sql.js WASM.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Real sql.js WASM — resolve via Node module resolution so it works in
// both the main project and git worktrees (which share the root node_modules)
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const SQL_WASM_PATH: string = _require.resolve('sql.js/dist/sql-wasm.wasm');

import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { bfsFromSeeds, splitIdentifier } from '../../src/analyzer/callgraph/CallGraphQuery';
import { QueryEngine } from '../../src/analyzer/QueryEngine';
import type { LlmClient } from '../../src/analyzer/llm/LlmClient';
import type { LlmCompletionOptions, LlmCompletionResult, LlmMessage } from '../../src/analyzer/llm/LlmClient';
import { resolveLlmClient } from '../../src/analyzer/llm/LlmClientFactory';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
PRAGMA journal_mode=MEMORY;
PRAGMA synchronous=OFF;

CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    lang        TEXT NOT NULL DEFAULT 'typescript',
    path        TEXT NOT NULL,
    folder      TEXT NOT NULL DEFAULT '',
    start_line  INTEGER,
    end_line    INTEGER,
    start_col   INTEGER DEFAULT 0,
    is_exported INTEGER DEFAULT 0,
    indexed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);

CREATE TABLE IF NOT EXISTS edges (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     TEXT NOT NULL,
    target_id     TEXT NOT NULL,
    type_relation TEXT NOT NULL DEFAULT 'CALLS',
    is_cyclic     INTEGER DEFAULT 0,
    source_line   INTEGER DEFAULT 0,
    FOREIGN KEY (source_id) REFERENCES nodes(id),
    FOREIGN KEY (target_id) REFERENCES nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
-- Note: FTS5 is not available in standard sql.js WASM build.
-- QueryEngine falls back to LIKE queries when nodes_fts table is absent.
`;

async function createTestDb(): Promise<Database> {
  const { readFile } = await import('node:fs/promises');
  const wasmBinary = await readFile(SQL_WASM_PATH);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  db.run(SCHEMA_SQL);
  return db;
}

function insertNode(
  db: Database,
  id: string,
  name: string,
  type = 'function',
  filePath = '/workspace/src/main.ts',
): void {
  db.run(
    `INSERT INTO nodes (id, name, type, lang, path, folder, start_line, is_exported)
     VALUES (?, ?, ?, 'typescript', ?, 'src', 10, 1)`,
    [id, name, type, filePath],
  );
}

function insertEdge(db: Database, sourceId: string, targetId: string): void {
  db.run(
    `INSERT INTO edges (source_id, target_id, type_relation, is_cyclic, source_line)
     VALUES (?, ?, 'CALLS', 0, 1)`,
    [sourceId, targetId],
  );
}

// ---------------------------------------------------------------------------
// Mock LlmClient
// ---------------------------------------------------------------------------

class MockLlmClient implements LlmClient {
  readonly providerName = 'anthropic' as const;
  readonly calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions | undefined }> = [];

  constructor(private readonly response: string) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async complete(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    this.calls.push({ messages, options });
    return { text: this.response };
  }
}

// ---------------------------------------------------------------------------
// splitIdentifier tests (from CallGraphQuery)
// ---------------------------------------------------------------------------

describe('splitIdentifier', () => {
  it('splits camelCase', () => {
    expect(splitIdentifier('callGraph')).toEqual(['call', 'graph']);
  });

  it('splits PascalCase', () => {
    expect(splitIdentifier('PathResolver')).toEqual(['path', 'resolver']);
  });

  it('splits snake_case', () => {
    expect(splitIdentifier('my_func_name')).toEqual(['my', 'func', 'name']);
  });

  it('splits dot-separated paths', () => {
    const result = splitIdentifier('src/utils.ts');
    expect(result).toContain('src');
    expect(result).toContain('utils');
  });

  it('filters tokens of length <= 1', () => {
    expect(splitIdentifier('a_b')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bfsFromSeeds tests
// ---------------------------------------------------------------------------

describe('bfsFromSeeds', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
    // nodes: A → B → C, D (isolated), E (@@external)
    insertNode(db, 'A', 'nodeA');
    insertNode(db, 'B', 'nodeB');
    insertNode(db, 'C', 'nodeC');
    insertNode(db, 'D', 'nodeD');
    insertEdge(db, 'A', 'B');
    insertEdge(db, 'B', 'C');
  });

  afterEach(() => db.close());

  it('depth=0 returns seed nodes only', () => {
    const result = bfsFromSeeds(db, [{ id: 'A', score: 1 }], 0);
    expect([...result]).toEqual(['A']);
  });

  it('depth=1 expands one hop', () => {
    const result = bfsFromSeeds(db, [{ id: 'A', score: 1 }], 1);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
    expect(result.has('C')).toBe(false);
  });

  it('depth=2 expands two hops', () => {
    const result = bfsFromSeeds(db, [{ id: 'A', score: 1 }], 2);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
    expect(result.has('C')).toBe(true);
  });

  it('maxNodes=1 truncates to seed only', () => {
    const result = bfsFromSeeds(db, [{ id: 'A', score: 1 }], 2, 1);
    expect(result.size).toBe(1);
    expect(result.has('A')).toBe(true);
  });

  it('maxNodes=3 limits total nodes when more available', () => {
    // Insert more nodes to exceed limit
    for (let i = 0; i < 10; i++) {
      insertNode(db, `N${i}`, `node${i}`);
      insertEdge(db, 'C', `N${i}`);
    }
    const result = bfsFromSeeds(db, [{ id: 'A', score: 1 }], 3, 3);
    expect(result.size).toBeLessThanOrEqual(3);
  });

  it('filters @@external: prefixed seed IDs', () => {
    const result = bfsFromSeeds(
      db,
      [
        { id: '@@external:lodash', score: 5 },
        { id: 'A', score: 1 },
      ],
      0,
    );
    expect(result.has('@@external:lodash')).toBe(false);
    expect(result.has('A')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QueryEngine.extractKeywords tests
// ---------------------------------------------------------------------------

describe('QueryEngine.extractKeywords', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => db.close());

  it('uses LLM when available and returns parsed keywords', async () => {
    const mockLlm = new MockLlmClient('["Spider","crawl"]');
    const engine = new QueryEngine(db, mockLlm);
    const keywords = await engine.extractKeywords('How does Spider crawl files?');
    expect(keywords).toEqual(['Spider', 'crawl']);
  });

  it('falls back to heuristic when llmClient is null', async () => {
    const engine = new QueryEngine(db, null);
    const keywords = await engine.extractKeywords('comment Spider parcourt les fichiers');
    // stopwords filtered: 'comment', 'les' removed
    expect(keywords).not.toContain('comment');
    expect(keywords).not.toContain('les');
    // meaningful tokens kept
    expect(keywords.some(k => k.length > 1)).toBe(true);
  });

  it('uses the heuristic fallback when no provider key is configured', async () => {
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const client = await resolveLlmClient();
      expect(client).toBeNull();

      const engine = new QueryEngine(db, client);
      const keywords = await engine.extractKeywords('Spider crawl files');
      expect(keywords).toContain('spider');
      expect(keywords).toContain('crawl');
    } finally {
      if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  it('falls back to heuristic when LLM returns invalid JSON', async () => {
    const mockLlm = new MockLlmClient('not valid json at all');
    const engine = new QueryEngine(db, mockLlm);
    const keywords = await engine.extractKeywords('Spider crawl files');
    // Should return heuristic result, not throw
    expect(Array.isArray(keywords)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QueryEngine.scoreSeedNodes tests
// ---------------------------------------------------------------------------

describe('QueryEngine.scoreSeedNodes', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
    // Insert 3 nodes: spider, resolver, helper
    insertNode(db, 'id-spider', 'Spider', 'class', '/workspace/src/Spider.ts');
    insertNode(db, 'id-resolver', 'PathResolver', 'class', '/workspace/src/PathResolver.ts');
    insertNode(db, 'id-helper', 'helper', 'function', '/workspace/src/utils.ts');
  });

  afterEach(() => db.close());

  it('returns nodes matching keyword with score > 0', () => {
    const engine = new QueryEngine(db, null);
    const results = engine.scoreSeedNodes(['Spider']);
    const spider = results.find(n => n.id === 'id-spider');
    expect(spider).toBeDefined();
    expect(spider!.relevanceScore).toBeGreaterThan(0);
  });

  it('does not return non-matching nodes', () => {
    const engine = new QueryEngine(db, null);
    const results = engine.scoreSeedNodes(['Spider']);
    const ids = results.map(n => n.id);
    // helper and PathResolver should not be in results
    expect(ids).not.toContain('id-helper');
  });

  it('returns empty array for empty keywords', () => {
    const engine = new QueryEngine(db, null);
    const results = engine.scoreSeedNodes([]);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// QueryEngine.toToon tests
// ---------------------------------------------------------------------------

describe('QueryEngine.toToon', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => db.close());

  it('returns valid JSON output with short keys', () => {
    const engine = new QueryEngine(db, null);
    const nodes = [
      { id: 'a', name: 'funcA', type: 'function', path: '/src/a.ts', relevanceScore: 1 },
    ];
    const edges = [{ source: 'a', target: 'b', relation: 'CALLS' as const }];

    const { toon } = engine.toToon(nodes, edges, 4000);
    const parsed = JSON.parse(toon) as Record<string, unknown>;

    expect(parsed).toHaveProperty('nodes');
    expect(parsed).toHaveProperty('edges');
    expect(parsed).toHaveProperty('nodeCount');
    expect(parsed).toHaveProperty('edgeCount');

    const firstNode = (parsed.nodes as Record<string, unknown>[])[0];
    expect(firstNode).toHaveProperty('n');  // short key for name
    expect(firstNode).toHaveProperty('t');  // short key for type
    expect(firstNode).toHaveProperty('p');  // short key for path
  });

  it('sets truncated=false when within budget', () => {
    const engine = new QueryEngine(db, null);
    const nodes = [
      { id: 'a', name: 'funcA', type: 'function', path: '/src/a.ts', relevanceScore: 1 },
    ];

    const { truncated } = engine.toToon(nodes, [], 4000);
    expect(truncated).toBe(false);
  });

  it('sets truncated=true when budget is exceeded', () => {
    const engine = new QueryEngine(db, null);
    // Create many nodes to exceed a tiny budget
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `node-${i}`,
      name: `someVeryLongFunctionNameThatTakesUpSpace${i}`,
      type: 'function',
      path: `/workspace/src/very/long/path/to/file${i}.ts`,
      startLine: i * 10,
      relevanceScore: i,
    }));

    const { truncated } = engine.toToon(nodes, [], 10); // tiny budget
    expect(truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QueryEngine.query end-to-end test
// ---------------------------------------------------------------------------

describe('QueryEngine.query (end-to-end)', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
    insertNode(db, 'spider-id', 'Spider', 'class', '/workspace/src/Spider.ts');
    insertNode(db, 'crawl-id', 'crawlFiles', 'function', '/workspace/src/Spider.ts');
    insertEdge(db, 'spider-id', 'crawl-id');
  });

  afterEach(() => db.close());

  it('returns a QueryResult with correct meta.llmProvider for mock LLM', async () => {
    const mockLlm = new MockLlmClient('["Spider","crawl"]');
    const engine = new QueryEngine(db, mockLlm);

    const result = await engine.query({
      question: 'How does Spider crawl files?',
      workspaceRoot: '/workspace',
      depth: 1,
      tokenBudget: 4000,
    });

    expect(result.meta.llmProvider).toBe('anthropic');
    expect(result.extractedKeywords).toContain('Spider');
    expect(result.meta.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.nodeCount).toBeGreaterThanOrEqual(0);
    expect(result.toon).toBeDefined();
    expect(mockLlm.calls).toHaveLength(1);
    expect(mockLlm.calls[0].options).toEqual({ maxTokens: 256, temperature: 0 });
    expect(mockLlm.calls[0].messages).toHaveLength(2);
    expect(mockLlm.calls[0].messages.map(message => message.content).join('\n'))
      .not.toContain('spider-id');
    expect(mockLlm.calls[0].messages.map(message => message.content).join('\n'))
      .not.toContain('crawl-id');
    expect(result.seedNodeIds).toContain('spider-id');
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'spider-id', target: 'crawl-id' }),
    ]));
  });

  it('returns a QueryResult with llmProvider=none when no LLM', async () => {
    const engine = new QueryEngine(db, null);

    const result = await engine.query({
      question: 'Spider class methods',
      workspaceRoot: '/workspace',
      depth: 1,
    });

    expect(result.meta.llmProvider).toBe('none');
    expect(Array.isArray(result.extractedKeywords)).toBe(true);
  });
});
