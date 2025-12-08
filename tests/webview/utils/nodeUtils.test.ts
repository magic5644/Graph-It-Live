import { describe, it, expect } from 'vitest';
import {
    collectNodesWithChildren,
    getNodeStyle,
    isNodeModulePath,
    buildNodeStyle,
    createEdgeStyle,
    calculateFileNameCounts,
    getNodeLabel,
    getLayoutedElements,
    nodeWidth,
    nodeHeight,
} from '../../../src/webview/utils/nodeUtils';

describe('nodeUtils', () => {
    describe('collectNodesWithChildren', () => {
        it('should include root file path', () => {
            const result = collectNodesWithChildren('/src/app.ts', []);
            expect(result.has('/src/app.ts')).toBe(true);
            expect(result.size).toBe(1);
        });

        it('should include all edge sources', () => {
            const edges = [
                { source: '/src/a.ts', target: '/src/b.ts' },
                { source: '/src/b.ts', target: '/src/c.ts' },
                { source: '/src/a.ts', target: '/src/d.ts' },
            ];
            const result = collectNodesWithChildren('/src/app.ts', edges);
            
            expect(result.has('/src/app.ts')).toBe(true);
            expect(result.has('/src/a.ts')).toBe(true);
            expect(result.has('/src/b.ts')).toBe(true);
            expect(result.has('/src/c.ts')).toBe(false); // Only target, not source
            expect(result.has('/src/d.ts')).toBe(false); // Only target, not source
        });

        it('should handle undefined filePath', () => {
            const edges = [{ source: '/src/a.ts', target: '/src/b.ts' }];
            const result = collectNodesWithChildren(undefined, edges);
            
            expect(result.has('/src/a.ts')).toBe(true);
            expect(result.size).toBe(1);
        });

        it('should handle empty inputs', () => {
            const result = collectNodesWithChildren(undefined, []);
            expect(result.size).toBe(0);
        });
    });

    describe('getNodeStyle', () => {
        it('should return root style for root node', () => {
            const style = getNodeStyle('app.ts', '/src/app.ts', true);
            
            expect(style.background).toBe('var(--vscode-button-background)');
            expect(style.color).toBe('var(--vscode-button-foreground)');
            expect(style.shape).toBe('rect');
        });

        it('should return symbol style for symbol nodes', () => {
            const style = getNodeStyle('myFunction', '/src/app.ts:myFunction', false, true);
            
            expect(style.shape).toBe('circle');
            expect(style.border).toContain('2px solid');
        });

        it('should return node_modules style for external packages', () => {
            const style = getNodeStyle('lodash', 'lodash', false);
            
            expect(style.border).toContain('dashed');
            expect(style.background).toBe('var(--vscode-sideBar-background)');
        });

        it('should return TypeScript style for .ts files', () => {
            const style = getNodeStyle('app.ts', '/src/app.ts', false);
            
            expect(style.border).toContain('#3178c6'); // TS Blue
        });

        it('should return TypeScript style for .tsx files', () => {
            const style = getNodeStyle('App.tsx', '/src/App.tsx', false);
            
            expect(style.border).toContain('#3178c6'); // TS Blue
        });

        it('should return JavaScript style for .js files', () => {
            const style = getNodeStyle('app.js', '/src/app.js', false);
            
            expect(style.border).toContain('#f7df1e'); // JS Yellow
        });

        it('should return Vue style for .vue files', () => {
            const style = getNodeStyle('App.vue', '/src/App.vue', false);
            
            expect(style.border).toContain('#41b883'); // Vue Green
        });

        it('should return Svelte style for .svelte files', () => {
            const style = getNodeStyle('App.svelte', '/src/App.svelte', false);
            
            expect(style.border).toContain('#ff3e00'); // Svelte Orange
        });

        it('should return GraphQL style for .gql files', () => {
            const style = getNodeStyle('query.gql', '/src/query.gql', false);
            
            expect(style.border).toContain('#e535ab'); // GraphQL Pink
        });

        it('should return base style for unknown extensions', () => {
            const style = getNodeStyle('readme.md', '/readme.md', false);
            
            expect(style.border).toBe('1px solid var(--vscode-widget-border)');
        });
    });

    describe('isNodeModulePath', () => {
        it('should return true for npm packages', () => {
            expect(isNodeModulePath('lodash')).toBe(true);
            expect(isNodeModulePath('react')).toBe(true);
            expect(isNodeModulePath('vscode')).toBe(true);
        });

        it('should return false for relative paths', () => {
            expect(isNodeModulePath('./utils')).toBe(false);
            expect(isNodeModulePath('../lib/helper')).toBe(false);
        });

        it('should return false for absolute unix paths', () => {
            expect(isNodeModulePath('/home/user/project/file.ts')).toBe(false);
        });

        it('should return false for absolute windows paths', () => {
            expect(isNodeModulePath(String.raw`C:\Users\project\file.ts`)).toBe(false);
        });
    });

    describe('buildNodeStyle', () => {
        it('should build rect style', () => {
            const style = buildNodeStyle(false, 'rect', 'white', 'black', '1px solid gray');
            
            expect(style.borderRadius).toBe(4);
            expect(style.width).toBe(nodeWidth);
            expect(style.height).toBe(nodeHeight);
            expect(style.fontWeight).toBe('normal');
            expect(style.textDecoration).toBe('none');
        });

        it('should build circle style', () => {
            const style = buildNodeStyle(false, 'circle', 'white', 'black', '1px solid gray');
            
            expect(style.borderRadius).toBe('50%');
            expect(style.width).toBe(80);
            expect(style.height).toBe(80);
        });

        it('should apply root styling', () => {
            const style = buildNodeStyle(true, 'rect', 'blue', 'white', '1px solid blue');
            
            expect(style.fontWeight).toBe('bold');
            expect(style.textDecoration).toBe('underline');
        });

        it('should apply all common styles', () => {
            const style = buildNodeStyle(false, 'rect', 'white', 'black', '1px solid gray');
            
            expect(style.padding).toBe(10);
            expect(style.fontSize).toBe('12px');
            expect(style.cursor).toBe('pointer');
            expect(style.textAlign).toBe('center');
            expect(style.display).toBe('flex');
            expect(style.alignItems).toBe('center');
            expect(style.justifyContent).toBe('center');
        });
    });

    describe('createEdgeStyle', () => {
        it('should create normal edge style', () => {
            const result = createEdgeStyle(false);
            
            expect(result.style.stroke).toBe('var(--vscode-editor-foreground)');
            expect(result.label).toBeUndefined();
        });

        it('should create circular edge style', () => {
            const result = createEdgeStyle(true);
            
            expect(result.style.stroke).toBe('#ff4d4d');
            expect(result.style.strokeWidth).toBe(2);
            expect(result.style.strokeDasharray).toBe('5,5');
            expect(result.label).toBe('Cycle');
            expect(result.labelStyle?.fill).toBe('#ff4d4d');
        });
    });

    describe('calculateFileNameCounts', () => {
        it('should count filename occurrences', () => {
            const paths = [
                '/src/utils/index.ts',
                '/src/components/index.ts',
                '/src/app.ts',
                '/src/hooks/index.ts',
            ];
            const counts = calculateFileNameCounts(paths);
            
            expect(counts.get('index.ts')).toBe(3);
            expect(counts.get('app.ts')).toBe(1);
        });

        it('should handle empty array', () => {
            const counts = calculateFileNameCounts([]);
            expect(counts.size).toBe(0);
        });

        it('should handle Set input', () => {
            const paths = new Set(['/src/a.ts', '/src/b.ts', '/lib/a.ts']);
            const counts = calculateFileNameCounts(paths);
            
            expect(counts.get('a.ts')).toBe(2);
            expect(counts.get('b.ts')).toBe(1);
        });

        it('should handle paths with trailing slashes', () => {
            const paths = ['/src/project/', '/src/other/'];
            const counts = calculateFileNameCounts(paths);
            
            expect(counts.get('project')).toBe(1);
            expect(counts.get('other')).toBe(1);
        });
    });

    describe('getNodeLabel', () => {
        it('should return custom label if available', () => {
            const label = getNodeLabel('/src/app.ts', { '/src/app.ts': 'Main App' });
            expect(label).toBe('Main App');
        });

        it('should return filename if no duplicates', () => {
            const counts = new Map([['app.ts', 1]]);
            const label = getNodeLabel('/src/app.ts', undefined, counts);
            expect(label).toBe('app.ts');
        });

        it('should disambiguate duplicate filenames', () => {
            const counts = new Map([['index.ts', 3]]);
            const label = getNodeLabel('/src/utils/index.ts', undefined, counts);
            expect(label).toBe('utils/index.ts');
        });

        it('should prefer custom label over disambiguation', () => {
            const counts = new Map([['index.ts', 3]]);
            const label = getNodeLabel('/src/utils/index.ts', { '/src/utils/index.ts': 'Utils' }, counts);
            expect(label).toBe('Utils');
        });

        it('should handle path with no parent', () => {
            const counts = new Map([['app.ts', 2]]);
            const label = getNodeLabel('app.ts', undefined, counts);
            expect(label).toBe('app.ts');
        });
    });

    describe('getLayoutedElements', () => {
        it('should layout single node', () => {
            const nodes = [{
                id: 'a',
                position: { x: 0, y: 0 },
                data: { label: 'A' },
            }];
            const edges: { id: string; source: string; target: string }[] = [];
            
            const result = getLayoutedElements(nodes, edges);
            
            expect(result.nodes).toHaveLength(1);
            expect(result.nodes[0].position).toBeDefined();
            expect(result.nodes[0].sourcePosition).toBe('right');
            expect(result.nodes[0].targetPosition).toBe('left');
        });

        it('should layout connected nodes', () => {
            const nodes = [
                { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
                { id: 'b', position: { x: 0, y: 0 }, data: { label: 'B' } },
            ];
            const edges = [{ id: 'a-b', source: 'a', target: 'b' }];
            
            const result = getLayoutedElements(nodes, edges);
            
            expect(result.nodes).toHaveLength(2);
            // In LR layout, source should be to the left of target
            expect(result.nodes[0].position.x).toBeLessThan(result.nodes[1].position.x);
        });

        it('should preserve edges unchanged', () => {
            const nodes = [
                { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
                { id: 'b', position: { x: 0, y: 0 }, data: { label: 'B' } },
            ];
            const edges = [{ id: 'a-b', source: 'a', target: 'b' }];
            
            const result = getLayoutedElements(nodes, edges);
            
            expect(result.edges).toEqual(edges);
        });

        it('should handle complex graph', () => {
            const nodes = [
                { id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } },
                { id: 'b', position: { x: 0, y: 0 }, data: { label: 'B' } },
                { id: 'c', position: { x: 0, y: 0 }, data: { label: 'C' } },
                { id: 'd', position: { x: 0, y: 0 }, data: { label: 'D' } },
            ];
            const edges = [
                { id: 'a-b', source: 'a', target: 'b' },
                { id: 'a-c', source: 'a', target: 'c' },
                { id: 'b-d', source: 'b', target: 'd' },
                { id: 'c-d', source: 'c', target: 'd' },
            ];
            
            const result = getLayoutedElements(nodes, edges);
            
            expect(result.nodes).toHaveLength(4);
            // All nodes should have valid positions
            result.nodes.forEach(node => {
                expect(typeof node.position.x).toBe('number');
                expect(typeof node.position.y).toBe('number');
            });
        });
    });
});
