import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { normalizePath } from '../../src/analyzer/types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mock fs
vi.mock('node:fs/promises');

// Use cross-platform root path
const ROOT_DIR = path.resolve(process.cwd(), 'temp-test-root');
const np = (p: string) => normalizePath(p);

describe('Spider - Crawl', () => {
    let spider: Spider;

    beforeEach(() => {
        vi.clearAllMocks();
        spider = new Spider({ rootDir: ROOT_DIR });
    });

    it('should crawl dependencies recursively', async () => {
        const mainFile = path.join(ROOT_DIR, 'main.ts');
        const childFile = path.join(ROOT_DIR, 'child.ts');
        const grandchildFile = path.join(ROOT_DIR, 'grandchild.ts');

        // Mock file content
        vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
            const p = np(filePath.toString());
            if (p === np(mainFile)) return "import {} from './child'";
            if (p === np(childFile)) return "import {} from './grandchild'";
            if (p === np(grandchildFile)) return "";
            return "";
        });

        // Mock file existence for resolver
        vi.mocked(fs.stat).mockImplementation(async (filePath) => {
            const p = np(filePath.toString());
            // Only allow our test files to exist
            if (p === np(mainFile) || p === np(childFile) || p === np(grandchildFile)) {
                return { isFile: () => true } as any;
            }
            throw new Error('File not found');
        });

        const result = await spider.crawl(mainFile);
        
        expect(result.nodes).toContain(np(mainFile));
        expect(result.nodes).toContain(np(childFile));
        expect(result.nodes).toContain(np(grandchildFile));
        
        expect(result.edges).toHaveLength(2);
        expect(result.edges).toContainEqual({ source: np(mainFile), target: np(childFile) });
        expect(result.edges).toContainEqual({ source: np(childFile), target: np(grandchildFile) });
    });

    it('should respect max depth', async () => {
        spider.updateConfig({ maxDepth: 1 });

        const mainFile = path.join(ROOT_DIR, 'main.ts');
        const childFile = path.join(ROOT_DIR, 'child.ts');
        const grandchildFile = path.join(ROOT_DIR, 'grandchild.ts');

        // Mock file content
        vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
            const p = np(filePath.toString());
            if (p === np(mainFile)) return "import {} from './child'";
            if (p === np(childFile)) return "import {} from './grandchild'";
            return "";
        });

        // Mock file existence
        vi.mocked(fs.stat).mockImplementation(async (filePath) => {
            const p = np(filePath.toString());
            if (p === np(mainFile) || p === np(childFile) || p === np(grandchildFile)) {
                return { isFile: () => true } as any;
            }
            throw new Error('File not found');
        });

        const result = await spider.crawl(mainFile);
        
        // Should contain main and child, but NOT grandchild (depth 2)
        // Wait, crawl logic:
        // depth 0: main -> analyze -> finds child. recurses to child at depth 1.
        // depth 1: child -> analyze -> finds grandchild. recurses to grandchild at depth 2.
        // depth 2: > maxDepth (1) -> return.
        
        // So grandchild is added to nodes/edges because it was found in child's dependencies,
        // BUT we didn't crawl it (didn't analyze its content).
        // So if grandchild had dependencies, they wouldn't be found.
        
        expect(result.nodes).toContain(np(mainFile));
        expect(result.nodes).toContain(np(childFile));
        expect(result.nodes).toContain(np(grandchildFile)); // Found as dependency
        
        // Let's verify we didn't analyze grandchild - check the normalized path pattern
        const readFileCalls = vi.mocked(fs.readFile).mock.calls.map(call => np(call[0].toString()));
        expect(readFileCalls.some(p => p === np(grandchildFile))).toBe(false);
    });
});
