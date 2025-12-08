import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { PathResolver } from '../../src/analyzer/PathResolver';
import { normalizePath } from '../../src/analyzer/types';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('PathResolver - Directory Handling', () => {
    let resolver: PathResolver;
    const rootDir = path.resolve(process.cwd(), 'temp-test-root');
    const np = (p: string) => normalizePath(p);

    beforeEach(() => {
        vi.clearAllMocks();
        resolver = new PathResolver();
    });

    it('should resolve to index file when importing a directory', async () => {
        const dirPath = path.join(rootDir, 'utils');
        const indexPath = path.join(rootDir, 'utils', 'index.ts');
        const mainPath = path.join(rootDir, 'main.ts');

        // Mock fs.stat to distinguish between directory and file
        vi.mocked(fs.stat).mockImplementation(async (p) => {
            const pathStr = np(p.toString());
            if (pathStr === np(indexPath)) {
                return { isFile: () => true } as any;
            }
            if (pathStr === np(dirPath)) {
                return { isFile: () => false } as any;
            }
            throw new Error('ENOENT');
        });

        // CURRENT BUG HYPOTHESIS:
        // PathResolver uses fs.access to check existence.
        // fs.access returns success for directories too.
        // So resolveWithExtensions sees '/root/utils' exists, and returns it.
        // It SHOULD check if it's a file.

        const result = await resolver.resolve(mainPath, './utils');
        
        // We expect it to resolve to the index file, NOT the directory
        expect(np(result!)).toBe(np(indexPath));
    });
});
