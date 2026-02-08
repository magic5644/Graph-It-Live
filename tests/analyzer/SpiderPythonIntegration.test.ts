import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { normalizePath } from "../../src/shared/path";

describe('Spider Python Integration', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/python-integration');
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withReverseIndex(true)
     .withExtensionPath(process.cwd())
     .build();
  });

  afterEach(async () => {
    await spider.dispose();
  });

  describe('File-level dependency crawling', () => {
    it('should crawl Python project from entry point', async () => {
      const entryFile = path.join(fixturesDir, 'app.py');
      const result = await spider.crawl(entryFile);

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(result.nodes.length).toBeGreaterThan(1);

      // Check that key files are included
      const filePaths = result.nodes; // nodes are already just file paths (strings)
      const normalizedEntry = normalizePath(entryFile);
      const normalizedDatabase = normalizePath(path.join(fixturesDir, 'utils/database.py'));
      const normalizedHelpers = normalizePath(path.join(fixturesDir, 'utils/helpers.py'));
      const normalizedProcessor = normalizePath(path.join(fixturesDir, 'services/processor.py'));

      expect(filePaths).toContain(normalizedEntry);
      expect(filePaths).toContain(normalizedDatabase);
      expect(filePaths).toContain(normalizedHelpers);
      expect(filePaths).toContain(normalizedProcessor);
    });

    it('should track Python import dependencies correctly', async () => {
      const entryFile = path.join(fixturesDir, 'app.py');
      const result = await spider.crawl(entryFile);

      // app.py should depend on utils/database.py
      const normalizedApp = normalizePath(entryFile);
      const normalizedDatabase = normalizePath(path.join(fixturesDir, 'utils/database.py'));

      const edgeFromAppToDb = result.edges.find(
        (e: { source: string; target: string }) => e.source === normalizedApp && e.target === normalizedDatabase
      );
      expect(edgeFromAppToDb).toBeDefined();
    });

    it('should handle __init__.py package imports', async () => {
      const entryFile = path.join(fixturesDir, 'app.py');
      const result = await spider.crawl(entryFile);

      // app.py imports from utils package (__init__.py)
      const filePaths = result.nodes; // nodes are already just file paths (strings)

      // May or may not include __init__.py depending on implementation
      // But should include the actual modules
      const hasUtilsModules = filePaths.some((p: string | undefined) => p && p.includes('utils/database.py') || p && p.includes('utils/helpers.py'));
      expect(hasUtilsModules).toBe(true);
    });

    it('should resolve relative imports from subpackages', async () => {
      const processorFile = path.join(fixturesDir, 'services/processor.py');
      const deps = await spider.analyze(processorFile);

      expect(deps).toBeDefined();
      expect(deps.length).toBeGreaterThan(0);

      // processor.py imports from ..utils.helpers (relative import)
      // Check that dependencies are resolved (path should be absolute, not just module name)
      const hasResolvedPaths = deps.some((d: { path: string }) => d.path && !d.path.startsWith('.'));
      expect(hasResolvedPaths).toBe(true);
      
      // Verify the relative import was resolved correctly
      const helpersImport = deps.find((d: { module: string }) => d.module === '..utils.helpers');
      expect(helpersImport).toBeDefined();
      expect(helpersImport?.path).toContain('utils/helpers.py');
    });

    it('should cache Python file analysis', async () => {
      const entryFile = path.join(fixturesDir, 'app.py');
      
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
    it('should track Python file-to-file dependencies in ReverseIndex', async () => {
      const entryFile = path.join(fixturesDir, 'app.py');
      await spider.crawl(entryFile);

      const helpersFile = path.join(fixturesDir, 'utils/helpers.py');
      const referencingFiles = await spider.findReferencingFiles(helpersFile);

      expect(referencingFiles).toBeDefined();
      expect(referencingFiles.length).toBeGreaterThan(0);

      // app.py and utils/database.py should reference helpers.py
      const normalizedApp = normalizePath(entryFile);
      const normalizedDatabase = normalizePath(path.join(fixturesDir, 'utils/database.py'));
      const normalizedProcessor = normalizePath(path.join(fixturesDir, 'services/processor.py'));

      const referencingPaths = referencingFiles.map((f: { path: string }) => f.path);
      
      // At least one file should reference helpers
      const hasReferences = referencingPaths.some((p: string) => 
        p === normalizedApp || p === normalizedDatabase || p === normalizedProcessor
      );
      expect(hasReferences).toBe(true);
    });

    it('should return correct upstream dependents for Python files', async () => {
      const entryFile = path.join(fixturesDir, 'app.py');
      await spider.crawl(entryFile);

      const databaseFile = path.join(fixturesDir, 'utils/database.py');
      const referencingFiles = await spider.findReferencingFiles(databaseFile);

      expect(referencingFiles.length).toBeGreaterThan(0);

      // app.py should reference database.py
      const normalizedApp = normalizePath(entryFile);
      const hasApp = referencingFiles.some((f: { path: string }) => f.path === normalizedApp);
      expect(hasApp).toBe(true);
    });

    it('should handle Python files with no dependents', async () => {
      const entryFile = path.join(fixturesDir, 'app.py');
      await spider.crawl(entryFile);

      // app.py is the entry point, should have no dependents
      const referencingFiles = await spider.findReferencingFiles(entryFile);
      expect(referencingFiles).toEqual([]);
    });
  });

  describe('Symbol-level analysis', () => {
    it('should extract Python symbols from files', async () => {
      const databaseFile = path.join(fixturesDir, 'utils/database.py');
      const symbolGraph = await spider.getSymbolGraph(databaseFile);

      expect(symbolGraph.symbols).toBeDefined();
      expect(symbolGraph.symbols.length).toBeGreaterThan(0);

      const symbolNames = symbolGraph.symbols.map((s: { name: string }) => s.name);
      expect(symbolNames).toContain('connect_db');
      expect(symbolNames).toContain('query_data');
      expect(symbolNames).toContain('save_data');
    });

    it('should track Python symbol dependencies', async () => {
      const processorFile = path.join(fixturesDir, 'services/processor.py');
      const symbolGraph = await spider.getSymbolGraph(processorFile);

      expect(symbolGraph.dependencies).toBeDefined();
      
      // DataProcessor class should have methods
      const classSymbols = symbolGraph.symbols.filter((s: { kind: string }) => s.kind === 'ClassDeclaration');
      expect(classSymbols.length).toBeGreaterThan(0);

      const methods = symbolGraph.symbols.filter((s: { parentSymbolId?: string }) => s.parentSymbolId);
      expect(methods.length).toBeGreaterThan(0);
    });

    it('should handle Python class methods correctly', async () => {
      const processorFile = path.join(fixturesDir, 'services/processor.py');
      const symbolGraph = await spider.getSymbolGraph(processorFile);
      
      // Find DataProcessor class
      const dataProcessorClass = symbolGraph.symbols.find(
        (s: { name: string; kind: string }) => s.name === 'DataProcessor' && s.kind === 'ClassDeclaration'
      );
      expect(dataProcessorClass).toBeDefined();

      // Find methods of DataProcessor
      const processMethods = symbolGraph.symbols.filter(
        (s: { name: string }) => s.name === 'process' || s.name === '_transform' || s.name === 'clear_cache'
      );
      expect(processMethods.length).toBeGreaterThan(0);
    });
  });

  describe('Mixed TypeScript and Python projects', () => {
    it('should handle projects with both TS and Python files', async () => {
      // This test would require a mixed fixture
      // For now, just verify Python analysis doesn't break TS
      const tsFixturesDir = path.resolve(__dirname, '../fixtures/sample-project');
      const tsSpider = new SpiderBuilder()
     .withRootDir(tsFixturesDir)
     .withTsConfigPath(path.join(tsFixturesDir, 'tsconfig.json'))
     .withExtensionPath(process.cwd())
     .build();

      const tsEntryFile = path.join(tsFixturesDir, 'src/main.ts');
      const tsResult = await tsSpider.crawl(tsEntryFile);

      expect(tsResult.nodes.length).toBeGreaterThan(0);
      
      await tsSpider.dispose();
    });
  });
});
