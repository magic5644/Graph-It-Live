import { describe, it, expect } from 'vitest';
import { buildReactFlowGraph, GRAPH_LIMITS } from '../../../../src/webview/components/reactflow/buildGraph';
import type { GraphData } from '../../../../src/shared/types';

describe('buildReactFlowGraph', () => {
  it('keeps edges relevant to expanded nodes when the full edge list is truncated', () => {
    const root = '/workspace/src/root.ts';
    const nodeB = '/workspace/src/b.ts';
    const nodeC = '/workspace/src/c.ts';

    const noiseEdges = Array.from({ length: GRAPH_LIMITS.MAX_PROCESS_EDGES + 5 }, (_, i) => ({
      source: `/workspace/noise/${i}.ts`,
      target: `/workspace/noise/${i}-dep.ts`,
    }));

    const data: GraphData = {
      nodes: [root, nodeB, nodeC],
      edges: [
        ...noiseEdges,
        // Put the relevant edges at the very end: old "slice(0, N)" logic would drop them.
        { source: root, target: nodeB },
        { source: nodeB, target: nodeC },
      ],
    };

    const result = buildReactFlowGraph({
      data,
      currentFilePath: root,
      expandAll: false,
      expandedNodes: new Set([nodeB]),
      showParents: false,
      callbacks: {
        onDrillDown: () => {},
        onFindReferences: () => {},
        onToggle: () => {},
        onExpandRequest: () => {},
      },
    });

    // Root expands by default and nodeB is explicitly expanded, so nodeC must be visible.
    expect(result.nodes.some((n) => n.id.endsWith('/c.ts'))).toBe(true);
  });
});

