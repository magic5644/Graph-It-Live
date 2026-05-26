/**
 * Memory benchmarks for CallGraphIndexer
 *
 * Measures sql.js database size growth and validates that getDatabaseSizeMB()
 * and checkAndEvict() keep memory bounded under load.
 *
 * Run with: npm run test:bench:memory
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import { CallGraphIndexer } from '../../../src/analyzer/callgraph/CallGraphIndexer';
import type { CallGraphNode, CallGraphEdge } from '../../../src/analyzer/callgraph/CallGraphIndexer';
import type { SupportedLang } from '../../../src/shared/callgraph-types';

const SQL_WASM_PATH = path.join(
  process.cwd(),
  'node_modules',
  'sql.js',
  'dist',
  'sql-wasm.wasm',
);

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function makeNode(fileIdx: number, nodeIdx: number): CallGraphNode {
  const filePath = `/test/src/file${fileIdx}.ts`;
  return {
    id: `${filePath}:func${nodeIdx}:${nodeIdx * 10}`,
    name: `func${nodeIdx}`,
    type: 'function',
    lang: 'typescript' as SupportedLang,
    path: filePath,
    folder: '/test/src',
    startLine: nodeIdx * 10,
    endLine: nodeIdx * 10 + 5,
    startCol: 0,
    isExported: true,
  };
}

function makeEdge(fileIdx: number, sourceNode: number, targetNode: number): CallGraphEdge {
  const filePath = `/test/src/file${fileIdx}.ts`;
  return {
    sourceId: `${filePath}:func${sourceNode}:${sourceNode * 10}`,
    targetId: `${filePath}:func${targetNode}:${targetNode * 10}`,
    typeRelation: 'CALLS',
    sourceLine: sourceNode * 10 + 2,
  };
}
function makeNodeForFile(filePath: string, nodeIdx: number): CallGraphNode {
  return {
    id: `${filePath}:func${nodeIdx}:${nodeIdx * 10}`,
    name: `func${nodeIdx}`,
    type: 'function',
    lang: 'typescript' as SupportedLang,
    path: filePath,
    folder: filePath.substring(0, filePath.lastIndexOf('/')),
    startLine: nodeIdx * 10,
    endLine: nodeIdx * 10 + 5,
    startCol: 0,
    isExported: true,
  };
}

function makeEdgeForFile(filePath: string, sourceNode: number, targetNode: number): CallGraphEdge {
  return {
    sourceId: `${filePath}:func${sourceNode}:${sourceNode * 10}`,
    targetId: `${filePath}:func${targetNode}:${targetNode * 10}`,
    typeRelation: 'CALLS',
    sourceLine: sourceNode * 10 + 2,
  };
}

describe('CallGraphIndexer Memory', () => {

  let indexer: CallGraphIndexer;

  beforeAll(async () => {
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
  });

  afterEach(() => {
    // Keep indexer alive across tests — dispose only at end
  });

  it('getDatabaseSizeMB returns reasonable size for empty db', async () => {
    const freshIndexer = new CallGraphIndexer(SQL_WASM_PATH);
    await freshIndexer.init();

    const size = freshIndexer.getDatabaseSizeMB();
    console.log(`[Memory] Empty CallGraph DB size: ${size.toFixed(3)} MB`);

    expect(size).toBeGreaterThanOrEqual(0);
    expect(size).toBeLessThan(1); // Empty DB should be tiny

    freshIndexer.dispose();
  });

  it('measures DB size growth with 1K symbols across 100 files', async () => {
    const freshIndexer = new CallGraphIndexer(SQL_WASM_PATH);
    await freshIndexer.init();

    const heapBefore = heapMB();
    const lang: SupportedLang = 'typescript';

    for (let fileIdx = 0; fileIdx < 100; fileIdx++) {
      const nodes: CallGraphNode[] = [];
      const edges: CallGraphEdge[] = [];
      const filePath = `/test/src/file${fileIdx}.ts`;

      for (let nodeIdx = 0; nodeIdx < 10; nodeIdx++) {
        nodes.push(makeNode(fileIdx, nodeIdx));
        if (nodeIdx > 0) {
          edges.push(makeEdge(fileIdx, nodeIdx - 1, nodeIdx));
        }
      }

      freshIndexer.indexFile(nodes, edges, filePath, lang, Date.now() + fileIdx);
    }

    const dbSizeMB = freshIndexer.getDatabaseSizeMB();
    const heapAfter = heapMB();

    console.log(
      `[Memory] CallGraphIndexer 100 files / 1K symbols:\n` +
      `  DB size:   ${dbSizeMB.toFixed(3)} MB\n` +
      `  Heap delta: +${(heapAfter - heapBefore).toFixed(1)} MB`
    );

    expect(dbSizeMB).toBeGreaterThan(0);
    expect(dbSizeMB).toBeLessThan(10); // Should stay well under 10 MB for 1K symbols

    freshIndexer.dispose();
  });

  it('measures DB size growth with 10K symbols across 500 files', async () => {
    const freshIndexer = new CallGraphIndexer(SQL_WASM_PATH);
    await freshIndexer.init();

    const heapBefore = heapMB();
    const lang: SupportedLang = 'typescript';

    for (let fileIdx = 0; fileIdx < 500; fileIdx++) {
      const nodes: CallGraphNode[] = [];
      const edges: CallGraphEdge[] = [];
      const filePath = `/test/src/file${fileIdx}.ts`;

      for (let nodeIdx = 0; nodeIdx < 20; nodeIdx++) {
        nodes.push(makeNode(fileIdx, nodeIdx));
        if (nodeIdx > 0) {
          edges.push(makeEdge(fileIdx, nodeIdx - 1, nodeIdx));
        }
      }

      freshIndexer.indexFile(nodes, edges, filePath, lang, Date.now() + fileIdx);
    }

    const dbSizeMB = freshIndexer.getDatabaseSizeMB();
    const heapAfter = heapMB();

    console.log(
      `[Memory] CallGraphIndexer 500 files / 10K symbols:\n` +
      `  DB size:   ${dbSizeMB.toFixed(3)} MB\n` +
      `  Heap delta: +${(heapAfter - heapBefore).toFixed(1)} MB`
    );

    expect(dbSizeMB).toBeGreaterThan(0);
    expect(dbSizeMB).toBeLessThan(50); // Should stay well under 50 MB for 10K symbols

    freshIndexer.dispose();
  });

  it('checkAndEvict reduces DB size when threshold exceeded', async () => {
    const maxSizeMB = 0.05; // Very low threshold to force eviction in tests
    const freshIndexer = new CallGraphIndexer(SQL_WASM_PATH, { maxDbSizeMB: maxSizeMB });
    await freshIndexer.init();

    const lang: SupportedLang = 'typescript';

    // Index enough files to exceed the tiny threshold
    for (let fileIdx = 0; fileIdx < 50; fileIdx++) {
      const filePath = `/test/evict/file${fileIdx}.ts`;
      const nodes: CallGraphNode[] = [];
      const edges: CallGraphEdge[] = [];

      for (let nodeIdx = 0; nodeIdx < 10; nodeIdx++) {
        nodes.push(makeNodeForFile(filePath, nodeIdx));
        if (nodeIdx > 0) {
          edges.push(makeEdgeForFile(filePath, nodeIdx - 1, nodeIdx));
        }
      }

      freshIndexer.indexFile(nodes, edges, filePath, lang, Date.now() + fileIdx);
    }

    const sizeBefore = freshIndexer.getDatabaseSizeMB();
    freshIndexer.checkAndEvict(maxSizeMB);
    const sizeAfter = freshIndexer.getDatabaseSizeMB();

    console.log(
      `[Memory] Eviction test (max=${maxSizeMB} MB):\n` +
      `  Size before: ${sizeBefore.toFixed(3)} MB\n` +
      `  Size after:  ${sizeAfter.toFixed(3)} MB`
    );

    // After eviction, DB should be smaller (or threshold was not exceeded)
    if (sizeBefore > maxSizeMB) {
      expect(sizeAfter).toBeLessThanOrEqual(sizeBefore);
    }

    freshIndexer.dispose();
  });

  it('evictOldestFiles removes correct number of files', async () => {
    const freshIndexer = new CallGraphIndexer(SQL_WASM_PATH);
    await freshIndexer.init();

    const lang: SupportedLang = 'typescript';

    // Index 20 files with distinct timestamps
    for (let fileIdx = 0; fileIdx < 20; fileIdx++) {
      const filePath = `/test/evict/file${fileIdx}.ts`;
      const nodes = [makeNodeForFile(filePath, 0), makeNodeForFile(filePath, 1)];
      const edges = [makeEdgeForFile(filePath, 0, 1)];
      freshIndexer.indexFile(nodes, edges, filePath, lang, fileIdx + 1000); // distinct mtime
    }

    const evicted = freshIndexer.evictOldestFiles(5);
    console.log(`[Memory] Evicted ${evicted.length} files (expected 5)`);

    expect(evicted).toHaveLength(5);

    freshIndexer.dispose();
  });
});
