import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { Spider } from '../../src/analyzer/Spider';

describe('Spider - Symbol Analysis', () => {
  const fixturesDir = path.join(__dirname, '../fixtures/symbols');
  const utilsPath = path.join(fixturesDir, 'utils.ts');
  const mainPath = path.join(fixturesDir, 'main.ts');
  
  let spider: Spider;

  beforeAll(async () => {
    spider = new Spider({
      rootDir: fixturesDir,
      enableReverseIndex: true
    });
    
    // Build the index first
    await spider.buildFullIndex();
  });

  it('should find unused symbols', async () => {
    const unused = await spider.findUnusedSymbols(utilsPath);
    
    expect(unused).toHaveLength(1);
    expect(unused[0].name).toBe('unusedFunc');
  });

  it('should find symbol dependents', async () => {
    const dependents = await spider.getSymbolDependents(utilsPath, 'usedFunc');
    
    expect(dependents).toHaveLength(1);
    expect(dependents[0].sourceSymbolId).toContain('main');
    expect(dependents[0].targetSymbolId).toContain('usedFunc');
  });
});
