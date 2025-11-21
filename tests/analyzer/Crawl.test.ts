import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import * as fs from 'node:fs/promises';

// Mock fs
vi.mock('node:fs/promises');

describe('Spider - Crawl', () => {
    let spider: Spider;

    beforeEach(() => {
        vi.clearAllMocks();
        spider = new Spider({ rootDir: '/root' });
    });

    it('should crawl dependencies recursively', async () => {
        // Mock file content
        vi.mocked(fs.readFile).mockImplementation(async (path) => {
            const p = path.toString();
            if (p.endsWith('/main.ts')) return "import {} from './child'";
            if (p.endsWith('/child.ts')) return "import {} from './grandchild'";
            if (p.endsWith('/grandchild.ts')) return "";
            return "";
        });

        // Mock file existence for resolver
        // Mock file existence for resolver
        vi.mocked(fs.stat).mockImplementation(async (path) => {
            const p = path.toString();
            // Only allow paths with extensions to exist
            if (p.endsWith('.ts')) {
                return { isFile: () => true } as any;
            }
            throw new Error('File not found');
        });

        const result = await spider.crawl('/root/main.ts');
        
        expect(result.nodes).toContain('/root/main.ts');
        expect(result.nodes).toContain('/root/child.ts');
        expect(result.nodes).toContain('/root/grandchild.ts');
        
        expect(result.edges).toHaveLength(2);
        expect(result.edges).toContainEqual({ source: '/root/main.ts', target: '/root/child.ts' });
        expect(result.edges).toContainEqual({ source: '/root/child.ts', target: '/root/grandchild.ts' });
    });

    it('should respect max depth', async () => {
        spider.updateConfig({ maxDepth: 1 });

        // Mock file content
        vi.mocked(fs.readFile).mockImplementation(async (path) => {
            const p = path.toString();
            if (p.endsWith('/main.ts')) return "import {} from './child'";
            if (p.endsWith('/child.ts')) return "import {} from './grandchild'";
            return "";
        });

        // Mock file existence
        vi.mocked(fs.stat).mockImplementation(async (path) => {
            const p = path.toString();
            if (p.endsWith('.ts')) {
                return { isFile: () => true } as any;
            }
            throw new Error('File not found');
        });

        const result = await spider.crawl('/root/main.ts');
        
        // Should contain main and child, but NOT grandchild (depth 2)
        // Wait, crawl logic:
        // depth 0: main -> analyze -> finds child. recurses to child at depth 1.
        // depth 1: child -> analyze -> finds grandchild. recurses to grandchild at depth 2.
        // depth 2: > maxDepth (1) -> return.
        
        // So grandchild is added to nodes/edges because it was found in child's dependencies,
        // BUT we didn't crawl it (didn't analyze its content).
        // So if grandchild had dependencies, they wouldn't be found.
        
        expect(result.nodes).toContain('/root/main.ts');
        expect(result.nodes).toContain('/root/child.ts');
        expect(result.nodes).toContain('/root/grandchild.ts'); // Found as dependency
        
        // Let's verify we didn't analyze grandchild
        expect(fs.readFile).not.toHaveBeenCalledWith('/root/grandchild.ts', expect.anything());
    });
});
