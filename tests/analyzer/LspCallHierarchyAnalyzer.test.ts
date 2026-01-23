/**
 * Unit tests for LspCallHierarchyAnalyzer
 * 
 * Tests:
 * - Symbol conversion from LSP format to SymbolNode
 * - Intra-file filtering (external calls excluded)
 * - Cycle detection using DFS traversal
 * - Path normalization for cross-platform compatibility
 */

import {
    LspCallHierarchyAnalyzer,
    type LspAnalysisResult
} from '@/analyzer/LspCallHierarchyAnalyzer';
import { describe, expect, it } from 'vitest';

describe('LspCallHierarchyAnalyzer', () => {
    const analyzer = new LspCallHierarchyAnalyzer();

    describe('buildIntraFileGraph', () => {
        it('should build graph with nodes and edges from LSP data', () => {
            const filePath = '/project/src/utils.ts';
            const lspData: LspAnalysisResult = {
                symbols: [
                    {
                        name: 'logger',
                        kind: 12, // Function
                        range: { start: 5, end: 7 },
                        uri: filePath,
                    },
                    {
                        name: 'helper',
                        kind: 12, // Function
                        range: { start: 9, end: 12 },
                        uri: filePath,
                    },
                    {
                        name: 'main',
                        kind: 12, // Function
                        range: { start: 14, end: 17 },
                        uri: filePath,
                    },
                ],
                callHierarchyItems: new Map([
                    ['main', { name: 'main', kind: 12, uri: filePath, range: { start: 14, end: 17 } }],
                    ['helper', { name: 'helper', kind: 12, uri: filePath, range: { start: 9, end: 12 } }],
                ]),
                outgoingCalls: new Map([
                    [
                        '/project/src/utils.ts:main',
                        [
                            {
                                to: { name: 'helper', kind: 12, uri: filePath, range: { start: 9, end: 12 } },
                                fromRanges: [{ start: 15, end: 15 }],
                            },
                            {
                                to: { name: 'logger', kind: 12, uri: filePath, range: { start: 5, end: 7 } },
                                fromRanges: [{ start: 16, end: 16 }],
                            },
                        ],
                    ],
                    [
                        '/project/src/utils.ts:helper',
                        [
                            {
                                to: { name: 'logger', kind: 12, uri: filePath, range: { start: 5, end: 7 } },
                                fromRanges: [{ start: 10, end: 10 }],
                            },
                        ],
                    ],
                ]),
            };

            const graph = analyzer.buildIntraFileGraph(filePath, lspData);

            expect(graph.filePath).toContain('utils.ts');
            expect(graph.nodes).toHaveLength(3);
            expect(graph.edges).toHaveLength(3);
            expect(graph.hasCycle).toBe(false);

            // Verify nodes
            const loggerNode = graph.nodes.find(n => n.name === 'logger');
            expect(loggerNode).toBeDefined();
            expect(loggerNode?.type).toBe('function');
            expect(loggerNode?.isExternal).toBe(false);

            // Verify edges
            const mainToHelper = graph.edges.find(e => e.source.includes('main') && e.target.includes('helper'));
            expect(mainToHelper).toBeDefined();
            expect(mainToHelper?.relation).toBe('calls');
            expect(mainToHelper?.line).toBe(15);
        });

        it('should filter out external calls from different files', () => {
            const filePath = '/project/src/utils.ts';
            const externalFile = '/project/src/external.ts';

            const lspData: LspAnalysisResult = {
                symbols: [
                    {
                        name: 'localFunction',
                        kind: 12,
                        range: { start: 5, end: 10 },
                        uri: filePath,
                    },
                ],
                callHierarchyItems: new Map([
                    ['localFunction', { name: 'localFunction', kind: 12, uri: filePath, range: { start: 5, end: 10 } }],
                ]),
                outgoingCalls: new Map([
                    [
                        '/project/src/utils.ts:localFunction',
                        [
                            // Internal call (should be included)
                            {
                                to: { name: 'localFunction', kind: 12, uri: filePath, range: { start: 5, end: 10 } },
                                fromRanges: [{ start: 8, end: 8 }],
                            },
                            // External call (should be filtered out)
                            {
                                to: { name: 'externalFunction', kind: 12, uri: externalFile, range: { start: 1, end: 5 } },
                                fromRanges: [{ start: 9, end: 9 }],
                            },
                        ],
                    ],
                ]),
            };

            const graph = analyzer.buildIntraFileGraph(filePath, lspData);

            // Should only have internal self-call, external call filtered
            expect(graph.edges).toHaveLength(1);
            expect(graph.edges[0].target).toContain('localFunction');
            expect(graph.edges[0].target).not.toContain('externalFunction');
        });

        it('should detect cycles in recursive function calls', () => {
            const filePath = '/project/src/recursive.ts';

            const lspData: LspAnalysisResult = {
                symbols: [
                    {
                        name: 'factorial',
                        kind: 12,
                        range: { start: 6, end: 11 },
                        uri: filePath,
                    },
                ],
                callHierarchyItems: new Map([
                    ['factorial', { name: 'factorial', kind: 12, uri: filePath, range: { start: 6, end: 11 } }],
                ]),
                outgoingCalls: new Map([
                    [
                        '/project/src/recursive.ts:factorial',
                        [
                            {
                                to: { name: 'factorial', kind: 12, uri: filePath, range: { start: 6, end: 11 } },
                                fromRanges: [{ start: 10, end: 10 }],
                            },
                        ],
                    ],
                ]),
            };

            const graph = analyzer.buildIntraFileGraph(filePath, lspData);

            expect(graph.hasCycle).toBe(true);
            expect(graph.cycleNodes).toContain('/project/src/recursive.ts:factorial');
        });

        it('should normalize paths for cross-platform compatibility', () => {
            // Test Windows path with backslashes and drive letter
            const windowsPath = String.raw`C:\Users\test\project\src\utils.ts`;
            const lspData: LspAnalysisResult = {
                symbols: [
                    {
                        name: 'test',
                        kind: 12,
                        range: { start: 1, end: 5 },
                        uri: windowsPath,
                    },
                ],
                callHierarchyItems: new Map(),
                outgoingCalls: new Map(),
            };

            const graph = analyzer.buildIntraFileGraph(windowsPath, lspData);

            // Path should be normalized (forward slashes, lowercase drive)
            expect(graph.filePath).toMatch(/^c:\/users\/test\/project\/src\/utils\.ts$/i);
            expect(graph.nodes[0].id).toMatch(/^c:\/users\/test\/project\/src\/utils\.ts:test$/i);
        });
    });

    describe('symbol type mapping', () => {
        it('should map function kinds to function type', () => {
            const filePath = '/project/test.ts';
            const lspData: LspAnalysisResult = {
                symbols: [
                    { name: 'func', kind: 12, range: { start: 1, end: 2 }, uri: filePath }, // Function
                    { name: 'method', kind: 6, range: { start: 3, end: 4 }, uri: filePath }, // Method
                    { name: 'constructor', kind: 9, range: { start: 5, end: 6 }, uri: filePath }, // Constructor
                ],
                callHierarchyItems: new Map(),
                outgoingCalls: new Map(),
            };

            const graph = analyzer.buildIntraFileGraph(filePath, lspData);

            expect(graph.nodes[0].type).toBe('function');
            expect(graph.nodes[1].type).toBe('function');
            expect(graph.nodes[2].type).toBe('function');
        });

        it('should map class kinds to class type', () => {
            const filePath = '/project/test.ts';
            const lspData: LspAnalysisResult = {
                symbols: [
                    { name: 'MyClass', kind: 5, range: { start: 1, end: 10 }, uri: filePath }, // Class
                    { name: 'MyInterface', kind: 11, range: { start: 12, end: 15 }, uri: filePath }, // Interface
                ],
                callHierarchyItems: new Map(),
                outgoingCalls: new Map(),
            };

            const graph = analyzer.buildIntraFileGraph(filePath, lspData);

            expect(graph.nodes[0].type).toBe('class');
            expect(graph.nodes[1].type).toBe('class');
        });

        it('should map variable kinds to variable type', () => {
            const filePath = '/project/test.ts';
            const lspData: LspAnalysisResult = {
                symbols: [
                    { name: 'myVar', kind: 13, range: { start: 1, end: 1 }, uri: filePath }, // Variable
                    { name: 'MY_CONST', kind: 14, range: { start: 2, end: 2 }, uri: filePath }, // Constant
                    { name: 'prop', kind: 7, range: { start: 3, end: 3 }, uri: filePath }, // Property
                ],
                callHierarchyItems: new Map(),
                outgoingCalls: new Map(),
            };

            const graph = analyzer.buildIntraFileGraph(filePath, lspData);

            expect(graph.nodes[0].type).toBe('variable');
            expect(graph.nodes[1].type).toBe('variable');
            expect(graph.nodes[2].type).toBe('variable');
        });
    });

    describe('parent symbol relationships', () => {
        it('should link methods to their parent class', () => {
            const filePath = '/project/test.ts';
            const lspData: LspAnalysisResult = {
                symbols: [
                    {
                        name: 'MyClass',
                        kind: 5,
                        range: { start: 1, end: 10 },
                        uri: filePath,
                    },
                    {
                        name: 'myMethod',
                        kind: 6,
                        range: { start: 3, end: 5 },
                        uri: filePath,
                        containerName: 'MyClass',
                    },
                ],
                callHierarchyItems: new Map(),
                outgoingCalls: new Map(),
            };

            const graph = analyzer.buildIntraFileGraph(filePath, lspData);

            const method = graph.nodes.find(n => n.name === 'myMethod');
            expect(method?.parentSymbolId).toContain('MyClass');
        });
    });
});
