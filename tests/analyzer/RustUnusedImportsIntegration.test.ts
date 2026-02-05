import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import path from 'node:path';

describe('Rust Unused Imports - Integration Fixture', () => {
  let spider: Spider;
  const fixtureRoot = path.resolve(__dirname, '../fixtures/rust-integration');

  beforeAll(async () => {
    spider = new SpiderBuilder()
     .withRootDir(fixtureRoot)
     .withMaxDepth(10)
     .withExcludeNodeModules(true)
     .withIndexingConcurrency(4)
     .build();
  });

  afterAll(() => {
    spider.dispose();
  });

  it('should detect that format_data and connect_db are USED (called)', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const { dependencies } = await spider.getSymbolGraph(mainPath);
    
    // Should have dependencies for functions that are CALLED
    const formatDataDep = dependencies.find(dep => 
      dep.targetSymbolId.includes('format_data')
    );
    const connectDbDep = dependencies.find(dep => 
      dep.targetSymbolId.includes('connect_db')
    );
    
    expect(formatDataDep).toBeDefined();
    expect(connectDbDep).toBeDefined();
  });

  it('should NOT detect process_data and disconnect_db in dependencies (never called)', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const { dependencies } = await spider.getSymbolGraph(mainPath);
    
    // process_data and disconnect_db are imported but never called
    // So they should NOT be in symbol dependencies
    const processDataDep = dependencies.find(dep => 
      dep.targetSymbolId.includes('process_data')
    );
    const disconnectDbDep = dependencies.find(dep => 
      dep.targetSymbolId.includes('disconnect_db')
    );
    
    expect(processDataDep).toBeUndefined(); // Not called = not in dependencies
    expect(disconnectDbDep).toBeUndefined(); // Not called = not in dependencies
  });

  it('should verify file-level dependency usage correctly', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const helpersPath = path.join(fixtureRoot, 'utils/helpers.rs');
    const databasePath = path.join(fixtureRoot, 'utils/database.rs');

    // helpers.rs has format_data (USED) and process_data (UNUSED import)
    // But format_data IS called, so file-level dependency is USED
    const helpersUsed = await spider.verifyDependencyUsage(mainPath, helpersPath);
    expect(helpersUsed).toBe(true); // At least one symbol (format_data) is used
    
    // database.rs has connect_db (USED) and disconnect_db (UNUSED import)
    // But connect_db IS called, so file-level dependency is USED
    const databaseUsed = await spider.verifyDependencyUsage(mainPath, databasePath);
    expect(databaseUsed).toBe(true); // At least one symbol (connect_db) is used
  });

  it('should count only actually CALLED functions in dependencies', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const { dependencies } = await spider.getSymbolGraph(mainPath);
    
    // Filter out internal dependencies (same file)
    const externalDeps = dependencies.filter(dep => 
      dep.targetFilePath !== mainPath && !dep.targetFilePath.includes('main.rs')
    );
    
    const symbolNames = externalDeps.map(dep => {
      const parts = dep.targetSymbolId.split(':');
      return parts[parts.length - 1];
    });
    
    // Should only have dependencies on functions that are CALLED
    expect(symbolNames).toContain('format_data'); // Called
    expect(symbolNames).toContain('connect_db'); // Called
    
    // Should NOT have dependencies on functions that are only imported but never called
    expect(symbolNames).not.toContain('process_data'); // Imported but not called
    expect(symbolNames).not.toContain('disconnect_db'); // Imported but not called
    
    // Exactly 2 external dependencies (format_data + connect_db)
    expect(externalDeps.length).toBe(2);
  });
});
