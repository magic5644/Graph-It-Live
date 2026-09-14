import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { presentFileGraph } from '../../../src/webview/utils/fileGraphPresentation';

describe('file edge neighborhood', () => {
  it('stops at direct neighbors in a cycle and preserves edge colors and labels', () => {
    const nodes: Node[] = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, position: { x: 0, y: 0 }, data: {} }));
    const edges: Edge[] = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'b'], ['d', 'e']].map(([source, target]) => ({
      id: `${source}->${target}`, source, target, style: { stroke: 'red', opacity: 0.5 }, label: 'cycle',
    }));
    const result = presentFileGraph(nodes, edges, undefined, new Set(), false, 'a->b');
    expect(result.nodes.filter(n => !n.style?.opacity).map(n => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.nodes.find(n => n.id === 'e')?.style?.opacity).toBe(0.25);
    expect(result.edges.find(e => e.id === 'c->d')?.style?.opacity).toBe(0.1);
    expect(result.edges.every(e => e.style?.stroke === 'red' && e.label === 'cycle')).toBe(true);
    expect(result.nodes.some(n => n.hidden)).toBe(false);
    const restored = presentFileGraph(nodes, edges, undefined, new Set(), false, null);
    expect(restored.edges.every(e => e.style?.opacity === 0.5 && !e.selected)).toBe(true);
  });

  it('does not focus hidden or dangling edges and handles empty graphs', () => {
    const nodes: Node[] = [{ id: 'a', position: { x: 0, y: 0 }, data: {} }];
    for (const edge of [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'aa', source: 'a', target: 'a', hidden: true },
    ]) {
      expect(presentFileGraph(nodes, [edge], undefined, new Set(), true, edge.id).selectedEdgeId).toBeNull();
    }
    expect(presentFileGraph([], [], undefined, new Set(), true, 'missing').visibleCount).toBe(0);
  });
});
