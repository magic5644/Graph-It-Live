import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Spider } from '../src/analyzer/Spider';
import { normalizePath } from '../src/analyzer/types';

const FIXTURES_BASE = path.join(__dirname, 'fixtures', 'reverse-deps');
let FIXTURES_DIR: string;

describe('Spider - Reverse Dependencies', () => {
    let spider: Spider;

    beforeEach(async () => {
        // Use a unique temp directory per test run to avoid concurrent test interference
        FIXTURES_DIR = path.join(FIXTURES_BASE, `run-${Date.now()}-${Math.random().toString(36).slice(2,6)}`);
        // Create fixture files
        await fs.mkdir(FIXTURES_DIR, { recursive: true });
        
        // a.ts imports b.ts
        await fs.writeFile(path.join(FIXTURES_DIR, 'a.ts'), `import { b } from './b';`);
        
        // b.ts has no imports
        await fs.writeFile(path.join(FIXTURES_DIR, 'b.ts'), `export const b = 1;`);
        
        // c.ts imports b.ts
        await fs.writeFile(path.join(FIXTURES_DIR, 'c.ts'), `import { b } from './b';`);
        
        // d.ts imports a.ts
        await fs.writeFile(path.join(FIXTURES_DIR, 'd.ts'), `import { a } from './a';`);

        spider = new Spider({
            rootDir: FIXTURES_DIR,
            excludeNodeModules: true
        });
    });

    afterEach(async () => {
        // Attempt cleanup; Windows can be flaky about rapid deletes, so force and ignore errors
        try {
            await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
        } catch (e) {
            // If cleanup fails, try once more after a short delay
            await new Promise(resolve => setTimeout(resolve, 10));
            try { await fs.rm(FIXTURES_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('should find files referencing b.ts', async () => {
        const bPath = path.join(FIXTURES_DIR, 'b.ts');
        const referencingFiles = await spider.findReferencingFiles(bPath);
        
        const referencingPaths = referencingFiles.map(d => d.path).sort();
        // Use normalizePath for cross-platform comparison
        expect(referencingPaths).toContain(normalizePath(path.join(FIXTURES_DIR, 'a.ts')));
        expect(referencingPaths).toContain(normalizePath(path.join(FIXTURES_DIR, 'c.ts')));
        expect(referencingPaths).toHaveLength(2);
    });

    it('should find files referencing a.ts', async () => {
        const aPath = path.join(FIXTURES_DIR, 'a.ts');
        const referencingFiles = await spider.findReferencingFiles(aPath);
        
        const referencingPaths = referencingFiles.map(d => d.path).sort();
        // Use normalizePath for cross-platform comparison
        expect(referencingPaths).toContain(normalizePath(path.join(FIXTURES_DIR, 'd.ts')));
        expect(referencingPaths).toHaveLength(1);
    });

    it('should return empty array for file with no references', async () => {
        const dPath = path.join(FIXTURES_DIR, 'd.ts');
        const referencingFiles = await spider.findReferencingFiles(dPath);
        
        expect(referencingFiles).toHaveLength(0);
    });

    it('should skip node_modules directory when excludeNodeModules is true', async () => {
        // Create a node_modules directory with a file that imports b.ts
        const nodeModulesDir = path.join(FIXTURES_DIR, 'node_modules');
        await fs.mkdir(nodeModulesDir, { recursive: true });
        await fs.writeFile(path.join(nodeModulesDir, 'some-lib.ts'), `import { b } from '../b';`);

        const bPath = path.join(FIXTURES_DIR, 'b.ts');
        const referencingFiles = await spider.findReferencingFiles(bPath);
        
        // Should NOT include files from node_modules
        const referencingPaths = referencingFiles.map(d => d.path);
        expect(referencingPaths.some(p => p.includes('node_modules'))).toBe(false);
        
        await fs.rm(nodeModulesDir, { recursive: true, force: true });
    });

    it('should skip hidden directories', async () => {
        // Create a .hidden directory with a file that imports b.ts
        const hiddenDir = path.join(FIXTURES_DIR, '.hidden');
        await fs.mkdir(hiddenDir, { recursive: true });
        await fs.writeFile(path.join(hiddenDir, 'hidden.ts'), `import { b } from '../b';`);

        const bPath = path.join(FIXTURES_DIR, 'b.ts');
        const referencingFiles = await spider.findReferencingFiles(bPath);
        
        // Should NOT include files from hidden directories
        const referencingPaths = referencingFiles.map(d => d.path);
        expect(referencingPaths.some(p => p.includes('.hidden'))).toBe(false);
        
        await fs.rm(hiddenDir, { recursive: true, force: true });
    });

    it('should only check supported file types', async () => {
        // Create files with unsupported extensions
        await fs.writeFile(path.join(FIXTURES_DIR, 'readme.md'), `import { b } from './b';`);
        await fs.writeFile(path.join(FIXTURES_DIR, 'config.json'), `{"import": "./b"}`);

        const bPath = path.join(FIXTURES_DIR, 'b.ts');
        const referencingFiles = await spider.findReferencingFiles(bPath);
        
        // Should only find .ts files
        const referencingPaths = referencingFiles.map(d => d.path);
        expect(referencingPaths.every(p => /\.(ts|tsx|js|jsx|vue|svelte)$/.test(p))).toBe(true);
        
        await fs.rm(path.join(FIXTURES_DIR, 'readme.md'));
        await fs.rm(path.join(FIXTURES_DIR, 'config.json'));
    });

    it('should return empty array for invalid path with no basename', async () => {
        const referencingFiles = await spider.findReferencingFiles('');
        expect(referencingFiles).toHaveLength(0);
    });

    it('should handle Windows-style paths with backslashes', async () => {
        const bPath = path.join(FIXTURES_DIR, 'b.ts');
        // Simulate a Windows-style path by replacing forward slashes with backslashes
        const windowsStylePath = bPath.replaceAll('/', '\\');
        
        const referencingFiles = await spider.findReferencingFiles(windowsStylePath);
        
        // Should still find the files even with Windows-style paths
        const referencingPaths = referencingFiles.map(d => d.path);
        // Paths should be normalized to forward slashes
        expect(referencingPaths.every(p => !p.includes('\\'))).toBe(true);
        expect(referencingPaths).toHaveLength(2); // a.ts and c.ts
    });

    it('should normalize paths in returned dependencies', async () => {
        const bPath = path.join(FIXTURES_DIR, 'b.ts');
        const referencingFiles = await spider.findReferencingFiles(bPath);
        
        // All returned paths should use forward slashes (normalized)
        for (const dep of referencingFiles) {
            expect(dep.path).not.toContain('\\');
        }
    });
});
