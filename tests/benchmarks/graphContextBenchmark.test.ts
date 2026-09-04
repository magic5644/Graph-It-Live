import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_WORKFLOWS,
  buildSharedCorpus,
  measureComparableMetrics,
  notSupportedGraphifyResult,
  runBenchmark,
} from '../../scripts/context-economy-corpus.mjs';

describe('graph context benchmark contract', () => {
  it('defines one small deterministic corpus for six reference workflows', () => {
    const corpus = buildSharedCorpus();

    expect(REFERENCE_WORKFLOWS).toHaveLength(6);
    expect(corpus.files).toEqual(expect.objectContaining({
      'src/ts/controller.ts': expect.any(String),
      'src/python/repository.py': expect.any(String),
      'src/rust/store.rs': expect.any(String),
      'docs/ADR-001.md': expect.any(String),
      'tests/controller.test.ts': expect.any(String),
    }));
    expect(corpus.expectedPaths).toContain('src/ts/controller.ts');
    expect(corpus.expectedNodeIds).toContain('file:src/ts/controller.ts');
    expect(corpus.changedFile).toBe('src/ts/controller.ts');
  });

  it('reports retrieval, path, freshness, call and token metrics separately', () => {
    const metrics = measureComparableMetrics({
      response: {
        indexRevision: 'before',
        fresh: true,
        nodes: [{ id: 'file:src/ts/controller.ts' }, { id: 'symbol:src/ts/controller.ts#handle' }],
        edges: [{ confidence: 'EXTRACTED' }],
        paths: [{ nodeIds: ['file:src/ts/controller.ts'] }],
        ambiguous: [],
        tokenEstimate: 100,
      },
      incrementalResponse: { indexRevision: 'after', fresh: true },
      expectedNodeIds: ['file:src/ts/controller.ts', 'symbol:src/ts/controller.ts#handle'],
      expectedPath: ['file:src/ts/controller.ts'],
      request: '{"question":"locate"}',
      responseText: '{"nodes":[]}',
      continuationText: '',
      latenciesMs: { cold: 12, warm: 3, incrementalUpdate: 5 },
    });

    expect(metrics).toMatchObject({
      precisionAt10: 1,
      recallAt10: 1,
      exactPathSuccess: true,
      ambiguityRate: 0,
      staleEdgeRate: 0,
      toolCalls: null,
      mcpInitializationTokens: null,
      incrementalIndexFresh: true,
      incrementalRevisionChanged: true,
      nodeBoundRespected: true,
      tokenBudgetRespected: true,
      coldLatencyMs: 12,
      warmLatencyMs: 3,
      incrementalUpdateLatencyMs: 5,
      providerBillingTokens: null,
      indexFresh: true,
    });
    expect(metrics.requestTokens).toBeGreaterThan(0);
    expect(metrics.responseTokens).toBeGreaterThan(0);
  });

  it('marks unavailable Graphify capabilities as not-supported', () => {
    expect(notSupportedGraphifyResult('path')).toEqual({
      status: 'not-supported',
      capability: 'path',
    });
  });

  it('detects breached node and token bounds', () => {
    const metrics = measureComparableMetrics({
      response: { nodes: Array.from({ length: 11 }, (_, index) => ({ id: String(index) })), tokenEstimate: 2001 },
      incrementalResponse: {},
      expectedNodeIds: [],
      request: '',
      responseText: '',
      latenciesMs: {},
    });

    expect(metrics).toMatchObject({ nodeBoundRespected: false, tokenBudgetRespected: false });
  });

  it('executes all workflows with bounded deterministic arguments and measured freshness', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'graph-context-benchmark-test-'));
    const calls: Array<{ executable: string; args: string[]; cwd: string }> = [];
    const execFile = (executable: string, args: string[], options: { cwd: string }) => {
      calls.push({ executable, args, cwd: options.cwd });
      if (executable === '/mock/graphify') return 'graphify 0.8.36\n';
      const format = args[args.indexOf('--format') + 1];
      if (format === 'toon') return 'indexRevision: volatile-toon-revision\nmtime: 12345\n';
      const changed = readFileSync(join(options.cwd, 'src/ts/controller.ts'), 'utf8').includes('incremental-update marker');
      return JSON.stringify({
        indexRevision: changed ? 'incremental-revision' : 'initial-revision',
        fresh: true,
        mode: args[args.indexOf('--mode') + 1],
        nodes: [{ id: 'file:src/ts/controller.ts' }],
        edges: [],
        paths: [],
        ambiguous: [],
        tokenEstimate: 100,
        truncated: false,
        mtime: 12345,
        nextCursor: args.includes('--cursor') ? undefined : 'cursor-containing-a-revision',
      });
    };

    try {
      const report = runBenchmark({
        cliPath: process.execPath,
        graphifyCli: '/mock/graphify',
        outputRoot,
        execFile,
      });

      expect(report.workflows.map(workflow => workflow.id)).toEqual(REFERENCE_WORKFLOWS.map(workflow => workflow.id));
      expect(report.workflows.every(workflow => workflow.graphItLive.metrics.nodeBoundRespected)).toBe(true);
      expect(report.workflows.every(workflow => workflow.graphItLive.metrics.tokenBudgetRespected)).toBe(true);
      expect(report.workflows.every(workflow => workflow.graphItLive.metrics.incrementalIndexFresh)).toBe(true);
      expect(report.workflows.every(workflow => workflow.graphItLive.metrics.incrementalRevisionChanged)).toBe(true);
      expect(report.workflows.every(workflow => workflow.graphItLive.metrics.mcpInitializationTokens === null)).toBe(true);
      expect(report.workflows.every(workflow => workflow.graphItLive.metrics.toolCalls === null)).toBe(true);
      expect(report.workflows.every(workflow => workflow.graphItLive.metrics.continuationTokens === null)).toBe(true);

      const graphItCalls = calls.filter(call => call.executable === process.execPath);
      expect(graphItCalls.every(call => !call.args.includes('--cursor'))).toBe(true);
      const coldCalls = graphItCalls.filter((_, index) => index % 4 === 0);
      expect(coldCalls).toHaveLength(6);
      for (const [index, workflow] of REFERENCE_WORKFLOWS.entries()) {
        const args = coldCalls[index].args;
        expect(args).toEqual(expect.arrayContaining([
          '--scope', '**', '--depth', '2', '--max-nodes', '10', '--token-budget', '2000',
        ]));
        if (workflow.question) expect(args).toContain(workflow.question);
        if (workflow.from) expect(args).toEqual(expect.arrayContaining(['--from', workflow.from]));
        if (workflow.to) expect(args).toEqual(expect.arrayContaining(['--to', workflow.to]));
        for (const seed of workflow.seeds ?? []) expect(args).toEqual(expect.arrayContaining(['--seeds', seed]));
      }

      expect(report.workflows.map(workflow => workflow.graphify.status)).toEqual(Array(6).fill('not-supported'));
      expect(Object.fromEntries(report.workflows.map(workflow => [workflow.id, workflow.graphify.args]))).toEqual({
        'locate-concept': ['query', 'where is idempotency policy defined?', '--budget', '2000', '--graph', '<workspace>/graphify-out/graph.json'],
        'explain-file': ['explain', 'src/ts/controller.ts', '--graph', '<workspace>/graphify-out/graph.json'],
        'callers-callees': ['explain', 'src/ts/controller.ts#handleUser', '--graph', '<workspace>/graphify-out/graph.json'],
        'controller-database': ['path', 'src/ts/controller.ts#handleUser', 'src/ts/repository.ts#saveUser', '--graph', '<workspace>/graphify-out/graph.json'],
        'refactor-interface': ['affected', 'src/ts/controller.ts#UserService', '--depth', '2', '--graph', '<workspace>/graphify-out/graph.json'],
        'document-symbol': ['query', 'what documentation explains handleUser? seed: src/ts/controller.ts#handleUser', '--budget', '2000', '--graph', '<workspace>/graphify-out/graph.json'],
      });
      expect(report.workflows.every(workflow => workflow.graphify.bounds.requested.maxNodes === 10)).toBe(true);
      expect(report.workflows.every(workflow => workflow.graphify.unsupported.length > 0)).toBe(true);
      expect(calls.filter(call => call.executable === '/mock/graphify').map(call => call.args)).toEqual([['--version']]);

      const serialized = readFileSync(join(outputRoot, 'latest', 'report.json'), 'utf8');
      expect(serialized).not.toContain(outputRoot);
      expect(serialized).not.toContain('graph-it-context-corpus-');
      expect(readFileSync(join(outputRoot, 'latest', 'locate-concept', 'json.txt'), 'utf8')).toContain('"indexRevision":"<revision>"');
      expect(readFileSync(join(outputRoot, 'latest', 'locate-concept', 'toon.txt'), 'utf8')).toContain('mtime: <mtime>');
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
