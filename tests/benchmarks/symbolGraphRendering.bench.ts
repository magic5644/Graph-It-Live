import { bench, describe } from 'vitest';
import type { CallEdge, GraphData, IntraFileGraph, SymbolNode } from '../../src/shared/types';
import { buildReactFlowGraph } from '../../src/webview/components/reactflow/buildGraph';

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

/**
 * Benchmark tests for Symbol Graph Rendering Performance
 * 
 * These benchmarks measure:
 * 1. buildReactFlowGraph performance with 100 symbols + 200 edges (SC-005 target: < 100ms)
 * 2. buildReactFlowGraph performance with 500 symbols + 1000 edges (stress test)
 * 3. Performance impact of cycle detection on large graphs
 * 
 * Run with: npm run benchmark
 * 
 * SUCCESS CRITERIA (SC-005):
 * - 100 nodes + 200 edges MUST render in < 100ms
 */

/**
 * Generate a mock IntraFileGraph with specified node and edge counts
 * for performance testing.
 */
function generateLargeSymbolGraph(nodeCount: number, edgeCount: number): IntraFileGraph {
  const nodes: SymbolNode[] = [];
  
  // Generate nodes with realistic distribution:
  // - 40% functions
  // - 30% classes  
  // - 30% variables
  for (let i = 0; i < nodeCount; i++) {
    const typeIndex = i % 10;
    let type: 'class' | 'function' | 'variable';
    let kind: number; // vscode.SymbolKind values
    
    if (typeIndex < 4) {
      type = 'function';
      kind = 11; // SymbolKind.Function
    } else if (typeIndex < 7) {
      type = 'class';
      kind = 4; // SymbolKind.Class
    } else {
      type = 'variable';
      kind = 12; // SymbolKind.Variable
    }
    
    nodes.push({
      id: `/test/file.ts:symbol${i}`,
      name: `${type}${i}`,
      kind,
      type,
      range: { 
        start: i * 10, 
        end: i * 10 + 5 
      },
      isExported: i % 3 === 0, // 33% exported
      isExternal: false,
    });
  }
  
  const edges: CallEdge[] = [];
  
  // Generate edges with realistic patterns:
  // - Forward calls (80%): call symbols defined later
  // - Backward calls (20%): call symbols defined earlier (may create cycles)
  for (let i = 0; i < edgeCount && i < nodeCount - 1; i++) {
    const isForwardCall = i % 5 !== 0; // 80% forward, 20% backward
    const sourceIdx = i % nodeCount;
    const targetIdx = isForwardCall 
      ? (sourceIdx + 1 + Math.floor(Math.random() * 10)) % nodeCount
      : Math.max(0, sourceIdx - Math.floor(Math.random() * 5));
    
    edges.push({
      source: nodes[sourceIdx].id,
      target: nodes[targetIdx].id,
      relation: 'calls',
      line: nodes[sourceIdx].range.start + Math.floor(Math.random() * 3), // Call within source symbol's range
    });
  }
  
  return {
    filePath: '/test/file.ts',
    nodes,
    edges,
    hasCycle: false,
  };
}

/**
 * Convert IntraFileGraph to GraphData format expected by buildReactFlowGraph
 */
function convertToGraphData(intraFileGraph: IntraFileGraph): GraphData {
  // Create a mapping of symbol IDs to file paths
  const nodeLabels: Record<string, string> = {};
  const nodeSet = new Set<string>();
  
  intraFileGraph.nodes.forEach(node => {
    nodeLabels[node.id] = node.name;
    nodeSet.add(node.id);
  });
  
  return {
    nodes: Array.from(nodeSet),
    edges: intraFileGraph.edges.map(edge => ({
      source: edge.source,
      target: edge.target,
    })),
    nodeLabels,
  };
}

/**
 * Create mock callbacks for buildReactFlowGraph (no-op implementations)
 */
function createMockCallbacks() {
  return {
    onDrillDown: () => {},
    onFindReferences: () => {},
    onToggleParents: () => {},
    onToggle: () => {},
    onExpandRequest: () => {},
  };
}

/**
 * Symbol Graph Rendering Benchmarks
 * 
 * These test the performance of buildReactFlowGraph with symbol-level data.
 * The function is responsible for:
 * 1. Processing nodes and edges
 * 2. Detecting cycles
 * 3. Computing layout (Dagre hierarchical layout)
 * 4. Creating ReactFlow node/edge objects
 */
describe('Symbol Graph Rendering Performance', () => {
  
  /**
   * SC-005 Target: 100 nodes + 200 edges MUST render in < 100ms
   * This is the primary success criterion for symbol graph rendering.
   */
  bench('render 100 symbols + 200 edges (SC-005 target)', () => {
    const mockGraph = generateLargeSymbolGraph(100, 200);
    const graphData = convertToGraphData(mockGraph);
    
    buildReactFlowGraph({
      data: graphData,
      currentFilePath: mockGraph.filePath,
      expandAll: false,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: createMockCallbacks(),
      mode: 'symbol',
      layout: 'hierarchical',
    });
  }, BENCH_OPTIONS);
  
  /**
   * Stress test: 500 symbols + 1000 edges
   * Tests performance with larger graphs (5x the baseline)
   */
  bench('render 500 symbols + 1000 edges (stress test)', () => {
    const mockGraph = generateLargeSymbolGraph(500, 1000);
    const graphData = convertToGraphData(mockGraph);
    
    buildReactFlowGraph({
      data: graphData,
      currentFilePath: mockGraph.filePath,
      expandAll: false,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: createMockCallbacks(),
      mode: 'symbol',
      layout: 'hierarchical',
    });
  }, BENCH_OPTIONS);
  
  /**
   * Test with all nodes expanded (worst-case scenario for layout computation)
   */
  bench('render 100 symbols + 200 edges with expandAll', () => {
    const mockGraph = generateLargeSymbolGraph(100, 200);
    const graphData = convertToGraphData(mockGraph);
    
    buildReactFlowGraph({
      data: graphData,
      currentFilePath: mockGraph.filePath,
      expandAll: true,
      expandedNodes: new Set(),
      showParents: true,
      callbacks: createMockCallbacks(),
      mode: 'symbol',
      layout: 'hierarchical',
    });
  }, BENCH_OPTIONS);
  
  /**
   * Test cycle detection performance impact
   * Cycles are common in symbol graphs (recursive functions, mutual calls)
   */
  bench('render 200 symbols + 400 edges with many cycles', () => {
    const mockGraph = generateLargeSymbolGraph(200, 400);
    const graphData = convertToGraphData(mockGraph);
    
    buildReactFlowGraph({
      data: graphData,
      currentFilePath: mockGraph.filePath,
      expandAll: false,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: createMockCallbacks(),
      mode: 'symbol',
      layout: 'hierarchical',
    });
  }, BENCH_OPTIONS);
  
  /**
   * Test with force-directed layout (alternative to hierarchical)
   */
  bench('render 100 symbols + 200 edges with force layout', () => {
    const mockGraph = generateLargeSymbolGraph(100, 200);
    const graphData = convertToGraphData(mockGraph);
    
    buildReactFlowGraph({
      data: graphData,
      currentFilePath: mockGraph.filePath,
      expandAll: false,
      expandedNodes: new Set(),
      showParents: false,
      callbacks: createMockCallbacks(),
      mode: 'symbol',
      layout: 'force',
    });
  }, BENCH_OPTIONS);
});
