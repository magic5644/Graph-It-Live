import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Spider } from '../src/analyzer/Spider';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'reverse-deps');

describe('Spider - Reverse Dependencies', () => {
    let spider: Spider;

    beforeEach(async () => {
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
        await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
    });

    it('should find files referencing b.ts', async () => {
        const bPath = path.join(FIXTURES_DIR, 'b.ts');
        const referencingFiles = await spider.findReferencingFiles(bPath);
        
        const referencingPaths = referencingFiles.map(d => d.path).sort();
        expect(referencingPaths).toContain(path.join(FIXTURES_DIR, 'a.ts'));
        expect(referencingPaths).toContain(path.join(FIXTURES_DIR, 'c.ts'));
        expect(referencingPaths).toHaveLength(2);
    });

    it('should find files referencing a.ts', async () => {
        const aPath = path.join(FIXTURES_DIR, 'a.ts');
        const referencingFiles = await spider.findReferencingFiles(aPath);
        
        const referencingPaths = referencingFiles.map(d => d.path).sort();
        expect(referencingPaths).toContain(path.join(FIXTURES_DIR, 'd.ts'));
        expect(referencingPaths).toHaveLength(1);
    });

    it('should return empty array for file with no references', async () => {
        const dPath = path.join(FIXTURES_DIR, 'd.ts');
        const referencingFiles = await spider.findReferencingFiles(dPath);
        
        expect(referencingFiles).toHaveLength(0);
    });
});
