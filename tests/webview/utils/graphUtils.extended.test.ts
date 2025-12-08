import { describe, it, expect } from 'vitest';
import {
    getFileName,
    getParentDir,
    getDisambiguatedLabel,
    countFileNames,
    isExternalPackage,
    calculateVisibleGraph,
    mergeGraphData,
    detectCycles,
} from '../../../src/webview/utils/graphUtils';
import { GraphData } from '../../../src/shared/types';

describe('graphUtils - extended tests', () => {
    describe('getFileName', () => {
        it('should extract filename from unix path', () => {
            expect(getFileName('/home/user/project/src/utils.ts')).toBe('utils.ts');
        });

        it('should extract filename from windows path', () => {
            expect(getFileName(String.raw`C:\Users\project\src\utils.ts`)).toBe('utils.ts');
        });

        it('should handle path with no separators', () => {
            expect(getFileName('utils.ts')).toBe('utils.ts');
        });

        it('should handle empty string', () => {
            expect(getFileName('')).toBe('');
        });

        it('should handle path ending with separator', () => {
            // When path ends with /, the trailing separator is ignored and last component is returned
            expect(getFileName('/home/user/project/')).toBe('project');
        });
    });

    describe('getParentDir', () => {
        it('should get parent directory from unix path', () => {
            expect(getParentDir('/home/user/project/src/utils.ts')).toBe('src');
        });

        it('should get parent directory from windows path', () => {
            expect(getParentDir(String.raw`C:\Users\project\src\utils.ts`)).toBe('src');
        });

        it('should return undefined for single component path', () => {
            expect(getParentDir('utils.ts')).toBeUndefined();
        });

        it('should handle two-component path', () => {
            expect(getParentDir('src/utils.ts')).toBe('src');
        });
    });

    describe('getDisambiguatedLabel', () => {
        it('should return custom label if available', () => {
            const nodeLabels = { '/path/to/file.ts': 'Custom Label' };
            expect(getDisambiguatedLabel('/path/to/file.ts', nodeLabels)).toBe('Custom Label');
        });

        it('should return filename if no duplicates', () => {
            const counts = new Map([['file.ts', 1]]);
            expect(getDisambiguatedLabel('/path/to/file.ts', undefined, counts)).toBe('file.ts');
        });

        it('should add parent dir if filename is duplicated', () => {
            const counts = new Map([['utils.ts', 2]]);
            expect(getDisambiguatedLabel('/path/src/utils.ts', undefined, counts)).toBe('src/utils.ts');
        });

        it('should return filename without counts map', () => {
            expect(getDisambiguatedLabel('/path/to/file.ts')).toBe('file.ts');
        });

        it('should prefer custom label over disambiguation', () => {
            const nodeLabels = { '/path/src/utils.ts': 'MyUtils' };
            const counts = new Map([['utils.ts', 2]]);
            expect(getDisambiguatedLabel('/path/src/utils.ts', nodeLabels, counts)).toBe('MyUtils');
        });
    });

    describe('countFileNames', () => {
        it('should count filename occurrences', () => {
            const paths = [
                '/src/utils.ts',
                '/lib/utils.ts',
                '/src/main.ts',
            ];
            const counts = countFileNames(paths);
            expect(counts.get('utils.ts')).toBe(2);
            expect(counts.get('main.ts')).toBe(1);
        });

        it('should handle empty array', () => {
            const counts = countFileNames([]);
            expect(counts.size).toBe(0);
        });

        it('should handle single file', () => {
            const counts = countFileNames(['/src/app.tsx']);
            expect(counts.get('app.tsx')).toBe(1);
        });
    });

    describe('isExternalPackage', () => {
        it('should identify npm packages', () => {
            expect(isExternalPackage('react')).toBe(true);
            expect(isExternalPackage('lodash')).toBe(true);
            // Note: scoped packages contain / so our simple heuristic treats them as local
            // This is a limitation of the current implementation
            expect(isExternalPackage('vscode')).toBe(true);
        });

        it('should identify local files with extensions', () => {
            expect(isExternalPackage('./utils.ts')).toBe(false);
            expect(isExternalPackage('../components/App.tsx')).toBe(false);
            expect(isExternalPackage('/absolute/path/file.js')).toBe(false);
        });

        it('should identify windows paths as local', () => {
            expect(isExternalPackage(String.raw`C:\Users\file.ts`)).toBe(false);
            expect(isExternalPackage('D:/project/src/main.tsx')).toBe(false);
        });

        it('should handle empty string', () => {
            expect(isExternalPackage('')).toBe(false);
        });

        it('should identify scoped packages - known limitation', () => {
            // Scoped packages contain / so our simple heuristic may not detect them
            // This is acceptable for visualization purposes
            // The actual behavior depends on node_modules detection
            expect(isExternalPackage('@modelcontextprotocol/sdk')).toBe(false); // Contains /
            expect(isExternalPackage('@vscode/test-electron')).toBe(false); // Contains /
        });

        it('should identify local paths without extension', () => {
            // These have path separators but no node_modules
            expect(isExternalPackage('./src/utils')).toBe(false);
            expect(isExternalPackage('../lib/helper')).toBe(false);
        });
    });

    describe('calculateVisibleGraph', () => {
        it('should show only root and direct children when nothing expanded', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B', 'C', 'D'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'A', target: 'C' },
                    { source: 'B', target: 'D' },
                ],
            };
            const expanded = new Set(['A']);
            
            const result = calculateVisibleGraph(graphData, 'A', expanded);
            
            expect(result.visibleNodes).toContain('A');
            expect(result.visibleNodes).toContain('B');
            expect(result.visibleNodes).toContain('C');
            expect(result.visibleNodes).not.toContain('D');
            expect(result.visibleEdges).toHaveLength(2);
        });

        it('should expand children when node is in expanded set', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B', 'C', 'D'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'B', target: 'C' },
                    { source: 'C', target: 'D' },
                ],
            };
            const expanded = new Set(['A', 'B', 'C']);
            
            const result = calculateVisibleGraph(graphData, 'A', expanded);
            
            expect(result.visibleNodes.size).toBe(4);
            expect(result.visibleEdges).toHaveLength(3);
        });

        it('should include incoming edges to root', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B', 'C'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'C', target: 'A' }, // C references A
                ],
            };
            const expanded = new Set(['A']);
            
            const result = calculateVisibleGraph(graphData, 'A', expanded);
            
            expect(result.visibleNodes).toContain('C');
            expect(result.visibleEdges).toContainEqual({ source: 'C', target: 'A' });
        });

        it('should handle cycles without infinite loop', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'B', target: 'A' },
                ],
            };
            const expanded = new Set(['A', 'B']);
            
            const result = calculateVisibleGraph(graphData, 'A', expanded);
            
            expect(result.visibleNodes.size).toBe(2);
            expect(result.visibleEdges).toHaveLength(2);
        });

        it('should not duplicate edges', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'A', target: 'B' }, // Duplicate
                ],
            };
            const expanded = new Set(['A']);
            
            const result = calculateVisibleGraph(graphData, 'A', expanded);
            
            expect(result.visibleEdges).toHaveLength(1);
        });
    });

    describe('mergeGraphData - extended', () => {
        it('should merge nodeLabels correctly', () => {
            const current: GraphData = {
                nodes: ['A'],
                edges: [],
                nodeLabels: { 'A': 'Label A' },
            };
            const newData: GraphData = {
                nodes: ['B'],
                edges: [],
                nodeLabels: { 'B': 'Label B' },
            };
            
            const result = mergeGraphData(current, newData);
            
            expect(result.nodeLabels).toEqual({
                'A': 'Label A',
                'B': 'Label B',
            });
        });

        it('should override existing labels with new ones', () => {
            const current: GraphData = {
                nodes: ['A'],
                edges: [],
                nodeLabels: { 'A': 'Old Label' },
            };
            const newData: GraphData = {
                nodes: ['A'],
                edges: [],
                nodeLabels: { 'A': 'New Label' },
            };
            
            const result = mergeGraphData(current, newData);
            
            expect(result.nodeLabels?.['A']).toBe('New Label');
        });

        it('should return undefined nodeLabels when both are empty', () => {
            const current: GraphData = { nodes: ['A'], edges: [] };
            const newData: GraphData = { nodes: ['B'], edges: [] };
            
            const result = mergeGraphData(current, newData);
            
            expect(result.nodeLabels).toBeUndefined();
        });
    });

    describe('detectCycles - extended', () => {
        it('should detect complex multi-node cycle', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B', 'C', 'D'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'B', target: 'C' },
                    { source: 'C', target: 'D' },
                    { source: 'D', target: 'B' }, // Cycle: B -> C -> D -> B
                ],
            };
            
            const { cycleEdges, cycleNodes } = detectCycles(graphData);
            
            expect(cycleEdges.has('D-B')).toBe(true);
            expect(cycleNodes.has('B')).toBe(true);
            expect(cycleNodes.has('C')).toBe(true);
            expect(cycleNodes.has('D')).toBe(true);
        });

        it('should detect multiple separate cycles', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B', 'X', 'Y'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'B', target: 'A' }, // Cycle 1
                    { source: 'X', target: 'Y' },
                    { source: 'Y', target: 'X' }, // Cycle 2
                ],
            };
            
            const { cycleEdges, cycleNodes } = detectCycles(graphData);
            
            expect(cycleEdges.size).toBeGreaterThanOrEqual(2);
            expect(cycleNodes.has('A')).toBe(true);
            expect(cycleNodes.has('B')).toBe(true);
            expect(cycleNodes.has('X')).toBe(true);
            expect(cycleNodes.has('Y')).toBe(true);
        });

        it('should handle graph with disconnected acyclic components', () => {
            const graphData: GraphData = {
                nodes: ['A', 'B', 'X', 'Y'],
                edges: [
                    { source: 'A', target: 'B' },
                    { source: 'X', target: 'Y' },
                ],
            };
            
            const { cycleEdges, cycleNodes } = detectCycles(graphData);
            
            expect(cycleEdges.size).toBe(0);
            expect(cycleNodes.size).toBe(0);
        });

        it('should handle empty graph', () => {
            const graphData: GraphData = { nodes: [], edges: [] };
            
            const { cycleEdges, cycleNodes } = detectCycles(graphData);
            
            expect(cycleEdges.size).toBe(0);
            expect(cycleNodes.size).toBe(0);
        });
    });
});
