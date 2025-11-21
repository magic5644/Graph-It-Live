import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PathResolver } from '../../src/analyzer/PathResolver';
import * as fs from 'node:fs/promises';

// Mock fs
vi.mock('node:fs/promises');

describe('PathResolver - VueJS Support', () => {
    let resolver: PathResolver;

    beforeEach(() => {
        vi.clearAllMocks();
        resolver = new PathResolver();
    });

    it('should resolve .vue extension explicitly', async () => {
        // Mock file existence
        vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);

        const result = await resolver.resolve('/src/main.ts', './components/Button.vue');
        
        expect(result).toBe('/src/components/Button.vue');
    });

    it('should resolve .vue extension implicitly', async () => {
        // Mock file existence logic
        vi.mocked(fs.stat).mockImplementation(async (path) => {
            if (path.toString().endsWith('Button.vue')) {
                return { isFile: () => true } as any; // File exists
            }
            throw new Error('File not found');
        });

        const result = await resolver.resolve('/src/main.ts', './components/Button');
        
        expect(result).toBe('/src/components/Button.vue');
    });
});
