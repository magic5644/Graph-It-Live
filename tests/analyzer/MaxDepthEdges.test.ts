import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('Spider - Max Depth Edges', () => {
    let spider: Spider;

    beforeEach(() => {
        vi.clearAllMocks();
        spider = new Spider({ rootDir: '/root' });
    });

    it('should create edges for node at maxDepth, but not for its children', async () => {
        // Max depth 2
        // root -> child1 (depth 1) -> child2 (depth 2) -> child3 (depth 3)
        spider.updateConfig({ maxDepth: 2 });

        vi.mocked(fs.readFile).mockImplementation(async (path) => {
            const p = path.toString();
            if (p.endsWith('root.ts')) return "import {} from './child1'";
            if (p.endsWith('child1.ts')) return "import {} from './child2'";
            if (p.endsWith('child2.ts')) return "import {} from './child3'";
            if (p.endsWith('child3.ts')) return "import {} from './child4'";
            return "";
        });

        vi.mocked(fs.stat).mockImplementation(async (path) => {
            const p = path.toString();
            if (p.endsWith('.ts')) {
                return { isFile: () => true } as any;
            }
            throw new Error('File not found');
        });

        const result = await spider.crawl('/root/root.ts');

        // Nodes expected: root, child1, child2, child3
        // child3 is found because child2 (at depth 2) is analyzed.
        // child3 is at depth 3. It is NOT analyzed.
        
        const edges = result.edges;
        
        // Edge root -> child1
        expect(edges.some(e => e.source.endsWith('root.ts') && e.target.endsWith('child1.ts'))).toBe(true);
        
        // Edge child1 -> child2
        expect(edges.some(e => e.source.endsWith('child1.ts') && e.target.endsWith('child2.ts'))).toBe(true);
        
        // Edge child2 -> child3 (child2 is at depth 2 == maxDepth. It SHOULD be analyzed)
        expect(edges.some(e => e.source.endsWith('child2.ts') && e.target.endsWith('child3.ts'))).toBe(true);
        
        // Edge child3 -> child4 (child3 is at depth 3 > maxDepth. It should NOT be analyzed)
        expect(edges.some(e => e.source.endsWith('child3.ts'))).toBe(false);
        
        // So:
        // root: Has outgoing edges -> Has (+)
        // child1: Has outgoing edges -> Has (+)
        // child2: Has outgoing edges -> Has (+)
        // child3: NO outgoing edges -> NO (+)
        
        // If user looks at child3, they see no (+), even though child3.ts has imports.
    });
});
