import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';

describe('Debug VerifyUsage', () => {
    const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/verify_usage');
    let spider: Spider;

    beforeAll(async () => {
        spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withReverseIndex(true)
     .withExtensionPath(process.cwd())
     .build();
        await spider.buildFullIndex();
    });

    afterAll(async () => {
        await spider.dispose();
    });

    it('debug unused import', async () => {
        const source = path.join(fixturesDir, 'source_unused.ts');
        const target = path.join(fixturesDir, 'target.ts');
        
        console.log('Source:', source);
        console.log('Target:', target);
        
        // Clear any cached data for source file
        // @ts-ignore - accessing private field for debugging
        console.log('\nCache before clear:', spider['symbolService']['symbolCache'].has(source.toLowerCase().replaceAll('\\', '/')));
        
        // Get symbol graph
        const symbolGraph = await spider.getSymbolGraph(source);
        console.log('\nSymbol graph for source_unused.ts:');
        console.log('Symbols:', symbolGraph.symbols.map(s => s.name));
        console.log('Dependencies count:', symbolGraph.dependencies.length);
        console.log('Dependencies:', symbolGraph.dependencies.map(d => ({
            source: d.sourceSymbolId,
            target: d.targetSymbolId,
            targetPath: d.targetFilePath
        })));
        
        console.log('\nCalling verifyDependencyUsage...');
        const isUsed = await spider.verifyDependencyUsage(source, target);
        console.log('Result:', isUsed, '(expected: false)');
        
        expect(isUsed).toBe(false);
    });
});
