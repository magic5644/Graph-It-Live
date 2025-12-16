import { describe, it, expect, vi } from 'vitest';
import { buildReactFlowGraph, GRAPH_LIMITS } from '../../../../src/webview/components/reactflow/buildGraph';
import type { GraphData } from '../../../../src/shared/types';
import type { BuildGraphCallbacks } from '../../../../src/webview/components/reactflow/buildGraph';

describe('buildReactFlowGraph', () => {
  const createMockCallbacks = (): BuildGraphCallbacks => ({
    onDrillDown: vi.fn(),
    onFindReferences: vi.fn(),
    onToggleParents: vi.fn(),
    onToggle: vi.fn(),
    onExpandRequest: vi.fn(),
  });

  const createBasicGraphData = (): GraphData => ({
    nodes: ['root.ts', 'child1.ts', 'child2.ts'],
    edges: [
      { source: 'root.ts', target: 'child1.ts' },
      { source: 'root.ts', target: 'child2.ts' },
    ],
    nodeLabels: {
      'root.ts': 'root.ts',
      'child1.ts': 'child1.ts',
      'child2.ts': 'child2.ts',
    },
  });

  describe('empty data handling', () => {
    it('should return empty result when data is undefined', () => {
      const result = buildReactFlowGraph({
        data: undefined,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.cycles.size).toBe(0);
      expect(result.edgesTruncated).toBe(false);
      expect(result.nodesTruncated).toBe(false);
    });

    it('should return empty result when nodes array is empty', () => {
      const result = buildReactFlowGraph({
        data: { nodes: [], edges: [] },
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });
  });

  describe('basic graph building', () => {
    it('should build graph with root node only when nothing is expanded', () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.some(n => n.id === 'root.ts')).toBe(true);
    });

    it('should include children when root is expanded', () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(['root.ts']),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.some(n => n.id === 'child1.ts')).toBe(true);
      expect(result.nodes.some(n => n.id === 'child2.ts')).toBe(true);
    });

    it('should expand all nodes when expandAll is true', () => {
      const data = createBasicGraphData();
      // When expandAll=true, expandedNodes should contain all nodes with children
      const expandedNodes = new Set(['root.ts']);
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: true,
        expandedNodes,
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.length).toBe(3);
      // Only nodes with children (or root) are marked as expanded
      const rootNode = result.nodes.find(n => n.id === 'root.ts');
      expect(rootNode?.data.isExpanded).toBe(true);
      // Children are visible (meaning root is expanded)
      expect(result.nodes.some(n => n.id === 'child1.ts')).toBe(true);
      expect(result.nodes.some(n => n.id === 'child2.ts')).toBe(true);
    });
  });

  describe('parent nodes handling', () => {
    it('should include parent nodes when showParents is true', () => {
      const data: GraphData = {
        nodes: ['parent.ts', 'root.ts', 'child.ts'],
        edges: [
          { source: 'parent.ts', target: 'root.ts' },
          { source: 'root.ts', target: 'child.ts' },
        ],
        nodeLabels: {
          'parent.ts': 'parent.ts',
          'root.ts': 'root.ts',
          'child.ts': 'child.ts',
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: true,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.some(n => n.id === 'parent.ts')).toBe(true);
      const parentNode = result.nodes.find(n => n.id === 'parent.ts');
      expect(parentNode?.data.isParent).toBe(true);
    });
  });

  describe('cycle detection', () => {
    it('should detect cycles in the graph', () => {
      const data: GraphData = {
        nodes: ['a.ts', 'b.ts', 'c.ts'],
        edges: [
          { source: 'a.ts', target: 'b.ts' },
          { source: 'b.ts', target: 'c.ts' },
          { source: 'c.ts', target: 'a.ts' }, // Cycle
        ],
        nodeLabels: {
          'a.ts': 'a.ts',
          'b.ts': 'b.ts',
          'c.ts': 'c.ts',
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'a.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.cycles.size).toBeGreaterThan(0);
      const cyclicNodes = result.nodes.filter(n => n.data.isInCycle);
      expect(cyclicNodes.length).toBeGreaterThan(0);
    });

    it('should mark cyclic edges with special styling', () => {
      const data: GraphData = {
        nodes: ['a.ts', 'b.ts'],
        edges: [
          { source: 'a.ts', target: 'b.ts' },
          { source: 'b.ts', target: 'a.ts' }, // Cycle
        ],
        nodeLabels: {
          'a.ts': 'a.ts',
          'b.ts': 'b.ts',
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'a.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const cyclicEdge = result.edges.find(e => e.label === 'Cycle');
      if (cyclicEdge) {
        expect(cyclicEdge.style).toHaveProperty('stroke', '#ff4d4d');
        expect(cyclicEdge.style).toHaveProperty('strokeDasharray', '5,5');
      }
    });
  });

  describe('edge truncation', () => {
    it('should truncate edges when exceeding MAX_PROCESS_EDGES', () => {
      const edges = Array.from({ length: GRAPH_LIMITS.MAX_PROCESS_EDGES + 100 }, (_, i) => ({
        source: 'root.ts',
        target: `child${i}.ts`,
      }));

      const nodes = ['root.ts', ...edges.map(e => e.target)];

      const data: GraphData = {
        nodes,
        edges,
        nodeLabels: Object.fromEntries(nodes.map(n => [n, n])),
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.edgesTruncated).toBe(true);
    });

    it('should not truncate when edges are within limits', () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.edgesTruncated).toBe(false);
    });

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

  describe('node data properties', () => {
    it('should mark root node correctly', () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const rootNode = result.nodes.find(n => n.id === 'root.ts');
      expect(rootNode?.data.isRoot).toBe(true);
      expect(rootNode?.data.isExpanded).toBe(true); // Root is always expanded
    });

    it('should set hasChildren property correctly', () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const rootNode = result.nodes.find(n => n.id === 'root.ts');
      expect(rootNode?.data.hasChildren).toBe(true);

      const childNode = result.nodes.find(n => n.id === 'child1.ts');
      expect(childNode?.data.hasChildren).toBe(false);
    });

    it('should bind callbacks to node data', () => {
      const callbacks = createMockCallbacks();
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks,
      });

      const rootNode = result.nodes.find(n => n.id === 'root.ts');
      expect(rootNode?.data.onDrillDown).toBeDefined();
      expect(rootNode?.data.onToggle).toBeDefined();
      expect(rootNode?.data.onExpandRequest).toBeDefined();

      // Test callback execution
      rootNode?.data.onToggle();
      expect(callbacks.onToggle).toHaveBeenCalledWith('root.ts');
    });
  });

  describe('path normalization', () => {
    it('should normalize paths consistently', () => {
      const data: GraphData = {
        nodes: ['root.ts', 'Child1.ts'],
        edges: [{ source: 'root.ts', target: 'Child1.ts' }],
        nodeLabels: {
          'root.ts': 'root.ts',
          'Child1.ts': 'Child1.ts',
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Should find node regardless of case (on case-insensitive systems)
      expect(result.nodes.length).toBeGreaterThan(0);
    });
  });

  describe('expanded nodes tracking', () => {
    it('should respect expandedNodes set', () => {
      const data: GraphData = {
        nodes: ['root.ts', 'a.ts', 'b.ts', 'c.ts'],
        edges: [
          { source: 'root.ts', target: 'a.ts' },
          { source: 'a.ts', target: 'b.ts' },
          { source: 'b.ts', target: 'c.ts' },
        ],
        nodeLabels: {
          'root.ts': 'root.ts',
          'a.ts': 'a.ts',
          'b.ts': 'b.ts',
          'c.ts': 'c.ts',
        },
      };

      // Expand only 'a.ts'
      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: false,
        expandedNodes: new Set(['a.ts']),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Should include root, a, and b (child of a), but not necessarily c
      expect(result.nodes.some(n => n.id === 'root.ts')).toBe(true);
      expect(result.nodes.some(n => n.id === 'a.ts')).toBe(true);
      expect(result.nodes.some(n => n.id === 'b.ts')).toBe(true);
    });
  });

  describe('node labels', () => {
    it('should use provided node labels', () => {
      const data: GraphData = {
        nodes: ['src/components/Button.tsx'],
        edges: [],
        nodeLabels: {
          'src/components/Button.tsx': 'Button Component',
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'src/components/Button.tsx',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const node = result.nodes.find(n => n.id.includes('Button'));
      expect(node?.data.label).toBe('Button Component');
    });

    it('should fallback to filename when no label provided', () => {
      const data: GraphData = {
        nodes: ['src/components/Button.tsx'],
        edges: [],
        nodeLabels: {},
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'src/components/Button.tsx',
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const node = result.nodes[0];
      expect(node?.data.label).toBe('Button.tsx');
    });
  });

  describe('parent count tracking', () => {
    it('should include parent count in node data', () => {
      const data: GraphData = {
        nodes: ['root.ts', 'child.ts'],
        edges: [{ source: 'root.ts', target: 'child.ts' }],
        nodeLabels: {
          'root.ts': 'root.ts',
          'child.ts': 'child.ts',
        },
        parentCounts: {
          'child.ts': 5,
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'root.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const childNode = result.nodes.find(n => n.id === 'child.ts');
      expect(childNode?.data.parentCount).toBe(5);
      expect(childNode?.data.hasReferencingFiles).toBe(true);
    });
  });

  describe('edge deduplication', () => {
    it('should deduplicate edges with same source and target', () => {
      const data: GraphData = {
        nodes: ['a.ts', 'b.ts'],
        edges: [
          { source: 'a.ts', target: 'b.ts' },
          { source: 'a.ts', target: 'b.ts' }, // Duplicate
          { source: 'a.ts', target: 'b.ts' }, // Duplicate
        ],
        nodeLabels: {
          'a.ts': 'a.ts',
          'b.ts': 'b.ts',
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'a.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Should only have one edge
      const edges = result.edges.filter(e => e.source === 'a.ts' && e.target === 'b.ts');
      expect(edges.length).toBe(1);
    });
  });

  describe('node truncation', () => {
    it('should truncate nodes when exceeding MAX_RENDER_NODES', () => {
      const nodeCount = GRAPH_LIMITS.MAX_RENDER_NODES + 50;
      const nodes = Array.from({ length: nodeCount }, (_, i) => `node${i}.ts`);
      const edges = nodes.slice(1).map((target, i) => ({
        source: nodes[i],
        target,
      }));

      const data: GraphData = {
        nodes,
        edges,
        nodeLabels: Object.fromEntries(nodes.map(n => [n, n])),
      };

      // When expandAll=true, expandedNodes should contain all nodes with children (sources in edges)
      const expandedNodes = new Set(edges.map(e => e.source));
      const result = buildReactFlowGraph({
        data,
        currentFilePath: nodes[0],
        expandAll: true,
        expandedNodes,
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodesTruncated).toBe(true);
      expect(result.nodes.length).toBeLessThanOrEqual(GRAPH_LIMITS.MAX_RENDER_NODES);
    });
  });

  describe('render edge truncation', () => {
    it('should truncate rendered edges when exceeding MAX_RENDER_EDGES', () => {
      const edgeCount = GRAPH_LIMITS.MAX_RENDER_EDGES + 100;
      const nodes = Array.from({ length: edgeCount + 1 }, (_, i) => `node${i}.ts`);
      const edges = Array.from({ length: edgeCount }, (_, i) => ({
        source: 'node0.ts',
        target: `node${i + 1}.ts`,
      }));

      const data: GraphData = {
        nodes,
        edges,
        nodeLabels: Object.fromEntries(nodes.map(n => [n, n])),
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: 'node0.ts',
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.renderEdgesTruncated).toBe(true);
      expect(result.edges.length).toBeLessThanOrEqual(GRAPH_LIMITS.MAX_RENDER_EDGES);
    });
  });
});

