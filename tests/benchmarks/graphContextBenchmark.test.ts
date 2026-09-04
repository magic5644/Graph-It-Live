import { describe, expect, it } from 'vitest';
import {
  REFERENCE_WORKFLOWS,
  buildSharedCorpus,
  measureComparableMetrics,
  notSupportedGraphifyResult,
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
        fresh: true,
        nodes: [{ id: 'file:src/ts/controller.ts' }, { id: 'symbol:src/ts/controller.ts#handle' }],
        edges: [{ confidence: 'EXTRACTED' }],
        paths: [{ nodeIds: ['file:src/ts/controller.ts'] }],
        ambiguous: [],
      },
      expectedNodeIds: ['file:src/ts/controller.ts', 'symbol:src/ts/controller.ts#handle'],
      expectedPath: ['file:src/ts/controller.ts'],
      request: '{"question":"locate"}',
      responseText: '{"nodes":[]}',
      continuationText: '',
      toolCalls: 1,
      latenciesMs: { cold: 12, warm: 3, incrementalUpdate: 5 },
    });

    expect(metrics).toMatchObject({
      precisionAt10: 1,
      recallAt10: 1,
      exactPathSuccess: true,
      ambiguityRate: 0,
      staleEdgeRate: 0,
      toolCalls: 1,
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
});
