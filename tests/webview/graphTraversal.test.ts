/**
 * Unit tests for graph traversal utilities
 */
import { computeRelatedNodes } from '@/webview/utils/graphTraversal';
import type { Edge, Node } from 'reactflow';
import { describe, expect, it } from 'vitest';

describe('computeRelatedNodes', () => {
  it('should find nodes in a simple chain', () => {
    const nodes: Node[] = [
      { id: 'A', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: 'B', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: 'C', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
    ];

    const edges: Edge[] = [
      { id: 'A-B', source: 'A', target: 'B' },
      { id: 'B-C', source: 'B', target: 'C' },
    ];

    const result = computeRelatedNodes('A', nodes, edges);

    expect(result.highlightedNodes.size).toBe(3);
    expect(result.highlightedNodes.has('A')).toBe(true);
    expect(result.highlightedNodes.has('B')).toBe(true);
    expect(result.highlightedNodes.has('C')).toBe(true);
    expect(result.highlightedEdges.size).toBe(2);
    expect(result.highlightedEdges.has('A-B')).toBe(true);
    expect(result.highlightedEdges.has('B-C')).toBe(true);
  });

  it('should handle mutual recursion cycle (isOdd/isEven)', () => {
    const nodes: Node[] = [
      { id: '/path/file.ts:isOdd', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: '/path/file.ts:isEven', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: '/path/file.ts:fibonacci', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
    ];

    const edges: Edge[] = [
      { id: 'isOdd-isEven', source: '/path/file.ts:isOdd', target: '/path/file.ts:isEven' },
      { id: 'isEven-isOdd', source: '/path/file.ts:isEven', target: '/path/file.ts:isOdd' },
      // fibonacci is not connected to isOdd/isEven
    ];

    const result = computeRelatedNodes('/path/file.ts:isOdd', nodes, edges);

    // Should only include isOdd and isEven, NOT fibonacci
    expect(result.highlightedNodes.size).toBe(2);
    expect(result.highlightedNodes.has('/path/file.ts:isOdd')).toBe(true);
    expect(result.highlightedNodes.has('/path/file.ts:isEven')).toBe(true);
    expect(result.highlightedNodes.has('/path/file.ts:fibonacci')).toBe(false);
    
    expect(result.highlightedEdges.size).toBe(2);
    expect(result.highlightedEdges.has('isOdd-isEven')).toBe(true);
    expect(result.highlightedEdges.has('isEven-isOdd')).toBe(true);
  });

  it('should handle self-recursion (fibonacci)', () => {
    const nodes: Node[] = [
      { id: '/path/file.ts:fibonacci', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: '/path/file.ts:factorial', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
    ];

    const edges: Edge[] = [
      { id: 'fib-fib', source: '/path/file.ts:fibonacci', target: '/path/file.ts:fibonacci' },
      // factorial is not connected
    ];

    const result = computeRelatedNodes('/path/file.ts:fibonacci', nodes, edges);

    // Should only include fibonacci (self-loop), NOT factorial
    expect(result.highlightedNodes.size).toBe(1);
    expect(result.highlightedNodes.has('/path/file.ts:fibonacci')).toBe(true);
    expect(result.highlightedNodes.has('/path/file.ts:factorial')).toBe(false);
    
    expect(result.highlightedEdges.size).toBe(1);
    expect(result.highlightedEdges.has('fib-fib')).toBe(true);
  });

  it('should handle isolated node with no connections', () => {
    const nodes: Node[] = [
      { id: 'A', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: 'B', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
    ];

    const edges: Edge[] = [];

    const result = computeRelatedNodes('A', nodes, edges);

    // Only the selected node, no edges
    expect(result.highlightedNodes.size).toBe(1);
    expect(result.highlightedNodes.has('A')).toBe(true);
    expect(result.highlightedNodes.has('B')).toBe(false);
    expect(result.highlightedEdges.size).toBe(0);
  });

  it('should return empty sets for non-existent node', () => {
    const nodes: Node[] = [
      { id: 'A', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
    ];

    const edges: Edge[] = [];

    const result = computeRelatedNodes('DOES_NOT_EXIST', nodes, edges);

    expect(result.highlightedNodes.size).toBe(0);
    expect(result.highlightedEdges.size).toBe(0);
  });

  it('should handle bidirectional traversal (incoming and outgoing)', () => {
    const nodes: Node[] = [
      { id: 'A', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: 'B', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: 'C', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
      { id: 'D', type: 'symbol', position: { x: 0, y: 0 }, data: {} },
    ];

    const edges: Edge[] = [
      { id: 'A-B', source: 'A', target: 'B' }, // A calls B
      { id: 'C-B', source: 'C', target: 'B' }, // C calls B
      { id: 'B-D', source: 'B', target: 'D' }, // B calls D
    ];

    // Start from B - should find A (caller), C (caller), and D (callee)
    const result = computeRelatedNodes('B', nodes, edges);

    expect(result.highlightedNodes.size).toBe(4);
    expect(result.highlightedNodes.has('A')).toBe(true);
    expect(result.highlightedNodes.has('B')).toBe(true);
    expect(result.highlightedNodes.has('C')).toBe(true);
    expect(result.highlightedNodes.has('D')).toBe(true);
    
    expect(result.highlightedEdges.size).toBe(3);
  });
});
