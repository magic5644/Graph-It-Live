import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { PathResolver } from '../../src/analyzer/PathResolver';
import { normalizePath } from '../../src/analyzer/types';
import * as fs from 'node:fs/promises';

// Mock fs
vi.mock('node:fs/promises');

const rootDir = path.resolve(process.cwd(), 'temp-test-root');
const np = (p: string) => normalizePath(p);

describe('PathResolver - VueJS Support', () => {
    let resolver: PathResolver;

    beforeEach(() => {
        vi.clearAllMocks();
        resolver = new PathResolver();
    });

    it('should resolve .vue extension explicitly', async () => {
        // Mock file existence
        vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);

        const mainFile = path.join(rootDir, 'src', 'main.ts');
        const expectedPath = path.join(rootDir, 'src', 'components', 'Button.vue');
        const result = await resolver.resolve(mainFile, './components/Button.vue');
        
        expect(np(result!)).toBe(np(expectedPath));
    });

    it('should resolve .vue extension implicitly', async () => {
        // Mock file existence logic
        vi.mocked(fs.stat).mockImplementation(async (filePath) => {
            if (np(filePath.toString()).endsWith('Button.vue')) {
                return { isFile: () => true } as any; // File exists
            }
            throw new Error('File not found');
        });

        const mainFile = path.join(rootDir, 'src', 'main.ts');
        const expectedPath = path.join(rootDir, 'src', 'components', 'Button.vue');
        const result = await resolver.resolve(mainFile, './components/Button');
        
        expect(np(result!)).toBe(np(expectedPath));
    });
});
