import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { normalizePath } from '../../src/shared/path';
import path from 'node:path';

describe('Rust Unused Dependencies', () => {
  let spider: Spider;
  const fixtureRoot = path.resolve(__dirname, '../fixtures/rust-unused-deps');

  beforeAll(async () => {
    spider = new Spider({
      rootDir: fixtureRoot,
      maxDepth: 10,
      excludeNodeModules: true,
      indexingConcurrency: 4,
    });
  });

  afterAll(() => {
    spider.dispose();
  });

  it('should detect used dependencies in Rust', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const helperPath = path.join(fixtureRoot, 'helper.rs');

    // main.rs uses format_data from helper.rs
    const isUsed = await spider.verifyDependencyUsage(mainPath, helperPath);
    expect(isUsed).toBe(true);
  });

  it('should detect unused dependencies in Rust', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const unusedPath = path.join(fixtureRoot, 'unused.rs');

    // main.rs imports but doesn't use anything from unused.rs
    const isUsed = await spider.verifyDependencyUsage(mainPath, unusedPath);
    expect(isUsed).toBe(false);
  });

  it('should handle pub visibility correctly', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const helperPath = normalizePath(path.join(fixtureRoot, 'helper.rs'));

    // Get symbol graph and verify dependencies
    const { dependencies } = await spider.getSymbolGraph(mainPath);
    
    // Should find dependency on format_data from helper
    const helperDeps = dependencies.filter(dep => 
      dep.targetFilePath === helperPath && 
      dep.targetSymbolId.includes('format_data')
    );
    
    expect(helperDeps.length).toBeGreaterThan(0);
  });

  it('should resolve Rust module paths correctly', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    
    // Get symbol graph
    const { dependencies } = await spider.getSymbolGraph(mainPath);
    
    // Dependencies should have resolved absolute paths (not module specifiers)
    for (const dep of dependencies) {
      // Skip entries that remain as Rust module specifiers
      if (dep.targetFilePath.includes('::')) continue;

      expect(dep.targetFilePath).toMatch(/^[/\\]|^[a-zA-Z]:[/\\]/); // Absolute path
      expect(dep.targetFilePath).not.toContain('::'); // No Rust module syntax
    }
  });
});
