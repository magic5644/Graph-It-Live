/**
 * Memory benchmarks for CallGraphIndexer
 *
 * Measures sql.js database size growth: the exported bytes are what
 * `.graph-it/cache/callgraph.db` holds on disk.
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

function dbSizeMB(indexer: CallGraphIndexer): number {
  return indexer.exportDb().byteLength / 1024 / 1024;
}

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

describe('CallGraphIndexer Memory', () => {

  let indexer: CallGraphIndexer;

  beforeAll(async () => {
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
  });

  afterEach(() => {
    // Keep indexer alive across tests — dispose only at end
  });

  it('reports a small size for an empty db', async () => {
    const freshIndexer = new CallGraphIndexer(SQL_WASM_PATH);
    await freshIndexer.init();

    const size = dbSizeMB(freshIndexer);
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

    const sizeMB = dbSizeMB(freshIndexer);
    const heapAfter = heapMB();

    console.log(
      `[Memory] CallGraphIndexer 100 files / 1K symbols:\n` +
      `  DB size:   ${sizeMB.toFixed(3)} MB\n` +
      `  Heap delta: +${(heapAfter - heapBefore).toFixed(1)} MB`
    );

    expect(sizeMB).toBeGreaterThan(0);
    expect(sizeMB).toBeLessThan(10); // Should stay well under 10 MB for 1K symbols

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

    const sizeMB = dbSizeMB(freshIndexer);
    const heapAfter = heapMB();

    console.log(
      `[Memory] CallGraphIndexer 500 files / 10K symbols:\n` +
      `  DB size:   ${sizeMB.toFixed(3)} MB\n` +
      `  Heap delta: +${(heapAfter - heapBefore).toFixed(1)} MB`
    );

    expect(sizeMB).toBeGreaterThan(0);
    expect(sizeMB).toBeLessThan(50); // Should stay well under 50 MB for 10K symbols

    freshIndexer.dispose();
  });
});
