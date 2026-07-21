import { describe, it, expect, vi } from 'vitest';
import { mergeGraphData, detectCycles } from '../../../src/webview/utils/graphUtils';
import { buildReactFlowGraph } from '../../../src/webview/components/reactflow/buildGraph';
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

        it('preserves existing nodeMetadata (communityId) when merging referencing files without metadata (GH #122)', () => {
            const currentData: GraphData = {
                nodes: ['A', 'B'],
                edges: [{ source: 'A', target: 'B' }],
                nodeMetadata: {
                    A: { hubScore: 0.5, communityId: 1 },
                    B: { hubScore: 0.2, communityId: 2 },
                },
            };
            const newData: GraphData = {
                nodes: ['C'],
                edges: [{ source: 'C', target: 'A' }],
            };

            const result = mergeGraphData(currentData, newData);

            expect(result.nodeMetadata).toEqual({
                A: { hubScore: 0.5, communityId: 1 },
                B: { hubScore: 0.2, communityId: 2 },
            });
        });

        it('merges nodeMetadata from both sides when both provide it', () => {
            const currentData: GraphData = {
                nodes: ['A'],
                edges: [],
                nodeMetadata: { A: { hubScore: 0.5, communityId: 1 } },
            };
            const newData: GraphData = {
                nodes: ['C'],
                edges: [],
                nodeMetadata: { C: { hubScore: 0.1, communityId: 3 } },
            };

            const result = mergeGraphData(currentData, newData);

            expect(result.nodeMetadata).toEqual({
                A: { hubScore: 0.5, communityId: 1 },
                C: { hubScore: 0.1, communityId: 3 },
            });
        });

        it('preserves existing unusedEdges when merging new data without any', () => {
            const currentData: GraphData = {
                nodes: ['A', 'B'],
                edges: [{ source: 'A', target: 'B' }],
                unusedEdges: ['A->B'],
            };
            const newData: GraphData = {
                nodes: ['C'],
                edges: [{ source: 'C', target: 'A' }],
            };

            const result = mergeGraphData(currentData, newData);

            expect(result.unusedEdges).toEqual(['A->B']);
        });

        it('end-to-end: communityId survives a "show referencing file" merge and reaches buildReactFlowGraph node data (GH #122)', () => {
            // Shape mirrors NodeInteractionService.getReferencingFiles' actual payload:
            // nodes/edges/parentCounts/unusedEdges only — NEVER nodeMetadata.
            const currentData: GraphData = {
                nodes: ['root.ts', 'child.ts'],
                edges: [{ source: 'root.ts', target: 'child.ts' }],
                nodeMetadata: {
                    'root.ts': { hubScore: 0.9, communityId: 1 },
                    'child.ts': { hubScore: 0.4, communityId: 2 },
                },
            };
            const referencingFilesPayload: GraphData = {
                nodes: ['parent.ts'],
                edges: [{ source: 'parent.ts', target: 'root.ts' }],
                parentCounts: { 'root.ts': 1 },
            };

            const merged = mergeGraphData(currentData, referencingFilesPayload);

            const result = buildReactFlowGraph({
                data: merged,
                currentFilePath: 'root.ts',
                expandAll: false,
                expandedNodes: new Set(['root.ts']),
                showParents: true,
                callbacks: {
                    onNodeClick: vi.fn(),
                    onDrillDown: vi.fn(),
                    onFindReferences: vi.fn(),
                    onToggleParents: vi.fn(),
                    onToggle: vi.fn(),
                    onExpandRequest: vi.fn(),
                },
            });

            const rootNode = result.nodes.find(n => n.id === 'root.ts');
            const childNode = result.nodes.find(n => n.id === 'child.ts');
            expect(rootNode?.data).toMatchObject({ communityId: 1 });
            expect(childNode?.data).toMatchObject({ communityId: 2 });
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
