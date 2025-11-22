import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import * as fs from 'node:fs/promises';

// Mock fs
vi.mock('node:fs/promises');

describe('Spider - Deep Recursion', () => {
    let spider: Spider;

    beforeEach(() => {
        vi.clearAllMocks();
        spider = new Spider({ rootDir: '/root' });
    });

    it('should crawl 10 levels deep when maxDepth is sufficient', async () => {
        spider.updateConfig({ maxDepth: 20 });

        // Mock file content for a chain of 10 files: file0 -> file1 -> ... -> file9
        vi.mocked(fs.readFile).mockImplementation(async (path) => {
            const p = path.toString();
            const match = p.match(/file(\d+)\.ts/);
            if (match) {
                const index = parseInt(match[1]);
                if (index < 9) {
                    return `import {} from './file${index + 1}'`;
                }
            }
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

        const result = await spider.crawl('/root/file0.ts');
        
        // Should find file0 to file9 (10 files)
        expect(result.nodes).toHaveLength(10);
        expect(result.nodes).toContain('/root/file0.ts');
        expect(result.nodes).toContain('/root/file9.ts');
        
        // Should have 9 edges
        expect(result.edges).toHaveLength(9);
    });

    it('should stop at maxDepth', async () => {
        spider.updateConfig({ maxDepth: 5 });

        // Mock file content for a chain of 10 files
        vi.mocked(fs.readFile).mockImplementation(async (path) => {
            const p = path.toString();
            const match = p.match(/file(\d+)\.ts/);
            if (match) {
                const index = parseInt(match[1]);
                if (index < 9) {
                    return `import {} from './file${index + 1}'`;
                }
            }
            return "";
        });

        // Mock file existence
        vi.mocked(fs.access).mockImplementation(async (path) => {
            const p = path.toString();
            if (p.endsWith('.ts')) return undefined;
            throw new Error('File not found');
        });

        const result = await spider.crawl('/root/file0.ts');
        
        // Depth 0: file0
        // Depth 1: file1
        // ...
        // Depth 5: file5
        // Depth 6: file6 (found as dependency of file5, but NOT crawled)
        
        // So we expect file0...file6 to be in nodes.
        // file0->file1 (1)
        // file1->file2 (2)
        // file2->file3 (3)
        // file3->file4 (4)
        // file4->file5 (5)
        // file5->file6 (6)
        
        // Wait, let's trace logic:
        // crawl(file0, 0) -> adds file0. Analyzes file0. Finds file1.
        //   -> crawl(file1, 1) -> adds file1. Analyzes file1. Finds file2.
        //     -> crawl(file2, 2) -> adds file2. Analyzes file2. Finds file3.
        //       -> crawl(file3, 3) -> adds file3. Analyzes file3. Finds file4.
        //         -> crawl(file4, 4) -> adds file4. Analyzes file4. Finds file5.
        //           -> crawl(file5, 5) -> adds file5. Analyzes file5. Finds file6.
        //             -> crawl(file6, 6) -> depth > 5. Returns.
        
        // So file6 IS added to nodes (by file5 analysis), but file6 is NOT analyzed.
        // So file6's dependencies (file7) are NOT found.
        
        expect(result.nodes).toContain('/root/file0.ts');
        expect(result.nodes).toContain('/root/file5.ts');
        expect(result.nodes).toContain('/root/file6.ts');
        expect(result.nodes).not.toContain('/root/file7.ts');
        
        expect(result.edges).toHaveLength(6);
    });
});
