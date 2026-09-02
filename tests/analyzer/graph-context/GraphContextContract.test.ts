/// <reference types="node" />

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryEngine } from '../../../src/analyzer/QueryEngine';

const require = createRequire(import.meta.url);
const SQL_WASM_PATH: string = require.resolve('sql.js/dist/sql-wasm.wasm');

const SCHEMA_SQL = `
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'typescript',
    path TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    start_line INTEGER,
    end_line INTEGER,
    start_col INTEGER DEFAULT 0,
    is_exported INTEGER DEFAULT 0,
    indexed_at INTEGER
  );
  CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type_relation TEXT NOT NULL DEFAULT 'CALLS',
    is_cyclic INTEGER DEFAULT 0,
    source_line INTEGER DEFAULT 0
  );
`;

async function createTestDb(): Promise<Database> {
  const wasmBinary = await readFile(SQL_WASM_PATH);
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  db.run(SCHEMA_SQL);
  return db;
}

function insertNode(db: Database, id: string, name: string, path: string): void {
  db.run(
    `INSERT INTO nodes (id, name, type, path, folder, start_line)
     VALUES (?, ?, 'function', ?, 'src', 1)`,
    [id, name, path],
  );
}

describe('current QueryEngine graph-context contracts', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => db.close());

  it('preserves the requested search seed at the minimum token budget', async () => {
    insertNode(db, 'requested', 'resolveWorkspaceRelativeImportSpecifier', '/workspace/src/requested.ts');

    const result = await new QueryEngine(db, null).query({
      question: 'resolveWorkspaceRelativeImportSpecifier',
      workspaceRoot: '/workspace',
      tokenBudget: 500,
    });

    expect(result.seedNodeIds).toContain('requested');
    expect(result.nodes.some(node => node.id === 'requested')).toBe(true);
    const compact = JSON.parse(result.json ?? '{}') as { nodes?: Array<{ id: string }> };
    expect(compact.nodes?.some(node => node.id === 'requested')).toBe(true);
  });

  it('returns all matching nodes as candidates for an ambiguous label', async () => {
    insertNode(db, 'a', 'resolvePath', '/workspace/src/analyzer/path.ts');
    insertNode(db, 'b', 'resolvePath', '/workspace/src/webview/path.ts');

    const result = await new QueryEngine(db, null).query({
      question: 'resolvePath',
      workspaceRoot: '/workspace',
      depth: 1,
    });

    expect(result.seedNodeIds).toEqual(['a', 'b']);
    expect(result.nodes.map(node => node.id)).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
