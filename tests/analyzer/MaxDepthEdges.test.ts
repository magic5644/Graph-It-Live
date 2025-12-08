import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { normalizePath } from '../../src/analyzer/types';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const rootDir = path.resolve(process.cwd(), 'temp-test-root');
const np = (p: string) => normalizePath(p);

describe('Spider - Max Depth Edges', () => {
    let spider: Spider;

    beforeEach(() => {
        vi.clearAllMocks();
        spider = new Spider({ rootDir });
    });

    it('should create edges for node at maxDepth, but not for its children', async () => {
        // Max depth 2
        // root -> child1 (depth 1) -> child2 (depth 2) -> child3 (depth 3)
        spider.updateConfig({ maxDepth: 2 });

        vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
            const p = np(filePath.toString());
            if (p.endsWith('root.ts')) return "import {} from './child1'";
            if (p.endsWith('child1.ts')) return "import {} from './child2'";
            if (p.endsWith('child2.ts')) return "import {} from './child3'";
            if (p.endsWith('child3.ts')) return "import {} from './child4'";
            return "";
        });

        vi.mocked(fs.stat).mockImplementation(async (filePath) => {
            const p = np(filePath.toString());
            if (p.endsWith('.ts')) {
                return { isFile: () => true } as any;
            }
            throw new Error('File not found');
        });

        const rootFile = path.join(rootDir, 'root.ts');
        const result = await spider.crawl(rootFile);

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
