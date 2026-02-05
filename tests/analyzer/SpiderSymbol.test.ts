import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';

describe('Spider - Symbol Analysis', () => {
  const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/symbols');
  const utilsPath = path.join(fixturesDir, 'utils.ts');
  
  let spider: Spider;

  beforeAll(async () => {
    spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withReverseIndex(true)
     .build();
    
    // Build the index first
    await spider.buildFullIndex();
  });

  it('should find unused symbols', async () => {
    const unused = await spider.findUnusedSymbols(utilsPath);
    
    const names = unused.map((s) => s.name).sort();
    expect(names).toEqual(['UnusedType', 'unusedFunc']);
  });

  it('should find symbol dependents', async () => {
    const dependents = await spider.getSymbolDependents(utilsPath, 'usedFunc');
    
    expect(dependents).toHaveLength(1);
    expect(dependents[0].sourceSymbolId).toContain('main');
    expect(dependents[0].targetSymbolId).toContain('usedFunc');
  });
});
