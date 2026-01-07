import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { normalizePath } from '../../src/shared/path';

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

describe('Spider - Verify Usage - GraphQL', () => {
    const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/graphql-project');
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

    it('should mark all GraphQL #import dependencies as used', async () => {
        const source = path.join(fixturesDir, 'schema.gql');
        const target1 = path.join(fixturesDir, 'fragments/user.gql');
        const target2 = path.join(fixturesDir, 'fragments/post.graphql');
        
        const isUsed1 = await spider.verifyDependencyUsage(source, target1);
        const isUsed2 = await spider.verifyDependencyUsage(source, target2);
        
        expect(isUsed1).toBe(true);
        expect(isUsed2).toBe(true);
    });

    it('should mark GraphQL batch dependencies as used', async () => {
        const source = path.join(fixturesDir, 'schema.gql');
        const targets = [
            path.join(fixturesDir, 'fragments/user.gql'),
            path.join(fixturesDir, 'fragments/post.graphql')
        ];
        
        const results = await spider.verifyDependencyUsageBatch(source, targets);
        
        // verifyDependencyUsageBatch returns normalized paths as keys for cross-platform consistency
        expect(results.get(normalizePath(targets[0]))).toBe(true);
        expect(results.get(normalizePath(targets[1]))).toBe(true);
    });
});
