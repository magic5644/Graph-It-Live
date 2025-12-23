import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { Spider } from '../../src/analyzer/Spider';

describe('Spider - Verify Usage', () => {
    const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/verify_usage');
    let spider: Spider;

    beforeAll(async () => {
        spider = new Spider({
            rootDir: fixturesDir,
            enableReverseIndex: true
        });
        await spider.buildFullIndex();
    });

    afterAll(async () => {
        await spider.dispose();
    });

    it('should confirm usage in exported function', async () => {
        const source = path.join(fixturesDir, 'source_used.ts');
        const target = path.join(fixturesDir, 'target.ts');
        const isUsed = await spider.verifyDependencyUsage(source, target);
        expect(isUsed).toBe(true);
    });

    it('should deny usage for unused import', async () => {
        const source = path.join(fixturesDir, 'source_unused.ts');
        const target = path.join(fixturesDir, 'target.ts');
        const isUsed = await spider.verifyDependencyUsage(source, target);
        expect(isUsed).toBe(false);
    });

    // This test confirms if top-level usage is detected or not
    it('should confirm usage in top-level statement', async () => {
         const source = path.join(fixturesDir, 'source_toplevel.ts');
         const target = path.join(fixturesDir, 'target.ts');
         const isUsed = await spider.verifyDependencyUsage(source, target);
         expect(isUsed).toBe(true);
    });
});
