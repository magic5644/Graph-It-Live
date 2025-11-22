import { describe, it, expect } from 'vitest';
import { mergeGraphData, detectCycles } from '../../../src/webview/utils/graphUtils';
import { GraphData } from '../../../src/shared/types';

describe('graphUtils', () => {
    describe('mergeGraphData', () => {
        it('should merge nodes and edges correctly', () => {
            const currentData: GraphData = {
                nodes: ['A', 'B'],
                edges: [{ source: 'A', target: 'B' }]
            };
            const newData: GraphData = {
                nodes: ['B', 'C'],
                edges: [{ source: 'B', target: 'C' }]
            };

            const result = mergeGraphData(currentData, newData);

            expect(result.nodes).toEqual(expect.arrayContaining(['A', 'B', 'C']));
            expect(result.nodes.length).toBe(3);
            expect(result.edges).toHaveLength(2);
            expect(result.edges).toContainEqual({ source: 'A', target: 'B' });
            expect(result.edges).toContainEqual({ source: 'B', target: 'C' });
        });

        it('should not duplicate existing edges', () => {
            const currentData: GraphData = {
                nodes: ['A', 'B'],
                edges: [{ source: 'A', target: 'B' }]
            };
            const newData: GraphData = {
                nodes: ['A', 'B'],
                edges: [{ source: 'A', target: 'B' }]
            };

            const result = mergeGraphData(currentData, newData);

            expect(result.edges).toHaveLength(1);
            expect(result.edges).toContainEqual({ source: 'A', target: 'B' });
        });
    });

    describe('detectCycles', () => {
        it('should detect simple cycle', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'B', target: 'A' }
                ]
            };

            const { cycleEdges, cycleNodes } = detectCycles(graphData);

            expect(cycleEdges.has('B-A')).toBe(true);
            expect(cycleNodes.has('A')).toBe(true);
            expect(cycleNodes.has('B')).toBe(true);
        });

        it('should detect self loop', () => {
            const graphData: GraphData = {
                nodes: ['A'],
                edges: [
                    { source: 'A', target: 'A' }
                ]
            };

            const { cycleEdges, cycleNodes } = detectCycles(graphData);

            expect(cycleEdges.has('A-A')).toBe(true);
            expect(cycleNodes.has('A')).toBe(true);
        });

        it('should not report cycles for acyclic graph', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B', 'C'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'B', target: 'C' }
                ]
            };

            const { cycleEdges, cycleNodes } = detectCycles(graphData);

            expect(cycleEdges.size).toBe(0);
            expect(cycleNodes.size).toBe(0);
        });
    });
});
