import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PathResolver } from '../../src/analyzer/PathResolver';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('PathResolver - Directory Handling', () => {
    let resolver: PathResolver;

    beforeEach(() => {
        vi.clearAllMocks();
        resolver = new PathResolver();
    });

    it('should resolve to index file when importing a directory', async () => {
        const dirPath = '/root/utils';
        const indexPath = '/root/utils/index.ts';

        // Mock fs.stat to distinguish between directory and file
        vi.mocked(fs.stat).mockImplementation(async (p) => {
            const pathStr = p.toString();
            if (pathStr === indexPath) {
                return { isFile: () => true } as any;
            }
            if (pathStr === dirPath) {
                return { isFile: () => false } as any;
            }
            throw new Error('ENOENT');
        });

        // CURRENT BUG HYPOTHESIS:
        // PathResolver uses fs.access to check existence.
        // fs.access returns success for directories too.
        // So resolveWithExtensions sees '/root/utils' exists, and returns it.
        // It SHOULD check if it's a file.

        const result = await resolver.resolve('/root/main.ts', './utils');
        
        // We expect it to resolve to the index file, NOT the directory
        expect(result).toBe(indexPath);
    });
});
