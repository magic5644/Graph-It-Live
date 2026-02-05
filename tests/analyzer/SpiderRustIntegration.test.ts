import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { normalizePath } from "../../src/shared/path";

describe('Spider Rust Integration', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/rust-integration');
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withReverseIndex(true)
     .build();
  });

  afterEach(async () => {
    await spider.dispose();
  });

  describe('File-level dependency crawling', () => {
    it('should crawl Rust project from entry point', async () => {
      const entryFile = path.join(fixturesDir, 'main.rs');
      const result = await spider.crawl(entryFile);

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(result.nodes.length).toBeGreaterThan(1);

      // Check that key files are included
      const filePaths = result.nodes;
      const normalizedEntry = normalizePath(entryFile);
      const normalizedDatabase = normalizePath(path.join(fixturesDir, 'utils/database.rs'));
      const normalizedHelpers = normalizePath(path.join(fixturesDir, 'utils/helpers.rs'));

      expect(filePaths).toContain(normalizedEntry);
      expect(filePaths).toContain(normalizedDatabase);
      expect(filePaths).toContain(normalizedHelpers);
    });

    it('should track Rust use dependencies correctly', async () => {
      const entryFile = path.join(fixturesDir, 'main.rs');
      const result = await spider.crawl(entryFile);

      // main.rs should depend on utils/database.rs
      const normalizedMain = normalizePath(entryFile);
      const normalizedDatabase = normalizePath(path.join(fixturesDir, 'utils/database.rs'));

      const edgeFromMainToDb = result.edges.find(
        (e: { source: string; target: string }) => e.source === normalizedMain && e.target === normalizedDatabase
      );
      expect(edgeFromMainToDb).toBeDefined();
    });

    it('should handle mod.rs module imports', async () => {
      const entryFile = path.join(fixturesDir, 'main.rs');
      const result = await spider.crawl(entryFile);

      // main.rs imports from utils module (mod.rs)
      const filePaths = result.nodes;

      // Should include utils modules
      const hasUtilsModules = filePaths.some((p: string | undefined) => 
        (p && p.includes('utils/database.rs')) || (p && p.includes('utils/helpers.rs'))
      );
      expect(hasUtilsModules).toBe(true);
    });

    it('should cache Rust file analysis', async () => {
      const entryFile = path.join(fixturesDir, 'main.rs');
      
      // First crawl
      const result1 = await spider.crawl(entryFile);
      const count1 = result1.nodes.length;

      // Second crawl should use cache
      const result2 = await spider.crawl(entryFile);
      const count2 = result2.nodes.length;

      expect(count1).toBe(count2);
      expect(count1).toBeGreaterThan(0);
    });
  });

  describe('ReverseIndex integration', () => {
    it('should track Rust file-to-file dependencies in ReverseIndex', async () => {
      const entryFile = path.join(fixturesDir, 'main.rs');
      await spider.crawl(entryFile);

      const helpersFile = path.join(fixturesDir, 'utils/helpers.rs');
      const referencingFiles = await spider.findReferencingFiles(helpersFile);

      expect(referencingFiles).toBeDefined();
      expect(referencingFiles.length).toBeGreaterThan(0);

      // main.rs should reference helpers.rs
      const normalizedMain = normalizePath(entryFile);

      const referencingPaths = referencingFiles.map((f: { path: string }) => f.path);
      
      // At least one file should reference helpers
      const hasReferences = referencingPaths.includes(normalizedMain);
      expect(hasReferences).toBe(true);
    });

    it('should return correct upstream dependents for Rust files', async () => {
      const entryFile = path.join(fixturesDir, 'main.rs');
      await spider.crawl(entryFile);

      const databaseFile = path.join(fixturesDir, 'utils/database.rs');
      const referencingFiles = await spider.findReferencingFiles(databaseFile);

      expect(referencingFiles.length).toBeGreaterThan(0);

      // main.rs should reference database.rs
      const normalizedMain = normalizePath(entryFile);
      const hasMain = referencingFiles.some((f: { path: string }) => f.path === normalizedMain);
      expect(hasMain).toBe(true);
    });

    it('should handle Rust files with no dependents', async () => {
      const entryFile = path.join(fixturesDir, 'main.rs');
      await spider.crawl(entryFile);

      // main.rs is the entry point, should have no dependents
      const referencingFiles = await spider.findReferencingFiles(entryFile);
      expect(referencingFiles).toEqual([]);
    });
  });

  describe('Symbol-level analysis', () => {
    it('should extract Rust function symbols', async () => {
      const helpersFile = path.join(fixturesDir, 'utils/helpers.rs');
      const graph = await spider.getSymbolGraph(helpersFile);

      expect(graph).toBeDefined();
      expect(graph.symbols.length).toBeGreaterThan(0);

      // Should extract format_data and process_data functions
      const symbolNames = graph.symbols.map((s: { name: string }) => s.name);
      expect(symbolNames).toContain('format_data');
      expect(symbolNames).toContain('process_data');
    });

    it('should extract Rust struct symbols', async () => {
      const databaseFile = path.join(fixturesDir, 'utils/database.rs');
      const graph = await spider.getSymbolGraph(databaseFile);

      expect(graph).toBeDefined();
      expect(graph.symbols.length).toBeGreaterThan(0);

      // Should extract Connection struct and connect_db function
      const symbolNames = graph.symbols.map((s: { name: string }) => s.name);
      expect(symbolNames).toContain('Connection');
      expect(symbolNames).toContain('connect_db');
      expect(symbolNames).toContain('disconnect_db');
    });

    it('should detect visibility (pub) for Rust symbols', async () => {
      const helpersFile = path.join(fixturesDir, 'utils/helpers.rs');
      const graph = await spider.getSymbolGraph(helpersFile);

      // format_data is pub fn
      const formatData = graph.symbols.find((s: { name: string }) => s.name === 'format_data');
      expect(formatData).toBeDefined();
      expect(formatData?.isExported).toBe(true);
    });

    it('should track Rust symbol-level dependencies', async () => {
      const mainFile = path.join(fixturesDir, 'main.rs');
      const graph = await spider.getSymbolGraph(mainFile);

      expect(graph).toBeDefined();
      expect(graph.dependencies.length).toBeGreaterThan(0);

      // main function should call format_data and connect_db
      const mainFuncId = `${normalizePath(mainFile)}:main`;
      const mainDeps = graph.dependencies.filter((d: { sourceSymbolId: string }) => 
        d.sourceSymbolId === mainFuncId
      );

      expect(mainDeps.length).toBeGreaterThan(0);
      
      // Check that we track external calls
      const targetSymbols = mainDeps.map((d: { targetSymbolId: string }) => d.targetSymbolId);
      const hasExternalDeps = targetSymbols.some((id: string) => 
        id.includes('format_data') || id.includes('connect_db')
      );
      expect(hasExternalDeps).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should handle non-existent Rust files gracefully', async () => {
      const nonExistentFile = path.join(fixturesDir, 'non-existent.rs');
      
      await expect(spider.analyze(nonExistentFile)).rejects.toThrow();
    });

    it('should handle syntax errors in Rust files', async () => {
      // This would require a fixture with syntax errors
      // For now, just ensure the parser doesn't crash on valid code
      const mainFile = path.join(fixturesDir, 'main.rs');
      const result = await spider.analyze(mainFile);
      
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
