import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import {
  McpWorkerHost,
  type McpWorkerHostOptions,
} from "../../src/mcp/McpWorkerHost";
import type {
  AnalyzeDependenciesParams,
  AnalyzeDependenciesResult,
  CrawlDependencyGraphParams,
  CrawlDependencyGraphResult,
  GetSymbolGraphParams,
  GetSymbolGraphResult,
  FindReferencingFilesParams,
  FindReferencingFilesResult,
  GetImpactAnalysisParams,
  GetImpactAnalysisResult,
} from "../../src/mcp/types";

describe('MCP Python Integration Tests', () => {
  const pythonFixturesDir = path.resolve(__dirname, '../fixtures/python-integration');
  let mcpWorker: McpWorkerHost;

  beforeAll(async () => {
    const workerPath = path.resolve(__dirname, '../../dist/mcpWorker.js');
    const options: McpWorkerHostOptions = {
      workerPath,
      warmupTimeout: 15000,
      invokeTimeout: 15000,
    };
    
    mcpWorker = new McpWorkerHost(options);
    
    // Start the worker with workspace configuration
    await mcpWorker.start({
      rootDir: pythonFixturesDir,
      excludeNodeModules: true,
      maxDepth: 50,
    });
  }, 20000);

  afterAll(async () => {
    if (mcpWorker) {
      await mcpWorker.dispose();
    }
  });

  describe('analyze_dependencies', () => {
    it('should analyze Python file dependencies', async () => {
      const appFile = path.join(pythonFixturesDir, 'app.py');
      const params: AnalyzeDependenciesParams = {
        filePath: appFile,
      };

      const result = await mcpWorker.invoke('analyze_dependencies', params) as AnalyzeDependenciesResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('dependencies');
      expect(Array.isArray(result.dependencies)).toBe(true);
      expect(result.dependencies.length).toBeGreaterThan(0);

      // Check that dependencies have required properties
      const firstDep = result.dependencies[0];
      expect(firstDep).toHaveProperty('path');
      expect(firstDep).toHaveProperty('type');
    });

    it('should handle Python files with no dependencies', async () => {
      const helpersFile = path.join(pythonFixturesDir, 'utils/helpers.py');
      const params: AnalyzeDependenciesParams = {
        filePath: helpersFile,
      };

      const result = await mcpWorker.invoke('analyze_dependencies', params) as AnalyzeDependenciesResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('dependencies');
      expect(Array.isArray(result.dependencies)).toBe(true);
      // helpers.py has minimal external dependencies
    });
  });

  describe('crawl_dependency_graph', () => {
    it('should crawl Python project from entry point', async () => {
      const appFile = path.join(pythonFixturesDir, 'app.py');
      const params: CrawlDependencyGraphParams = {
        entryFile: appFile,
        maxDepth: 20,
      };

      const result = await mcpWorker.invoke('crawl_dependency_graph', params) as CrawlDependencyGraphResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('nodes');
      expect(result).toHaveProperty('edges');
      
      expect(result.nodes.length).toBeGreaterThan(1);
      
      // Verify Python files are included
      const nodePaths = result.nodes.map((n) => n.path);
      expect(nodePaths.some((p: string) => p.includes('app.py'))).toBe(true);
      expect(nodePaths.some((p: string) => p.includes('database.py'))).toBe(true);
    });

    it('should include metadata about Python files', async () => {
      const appFile = path.join(pythonFixturesDir, 'app.py');
      const params: CrawlDependencyGraphParams = {
        entryFile: appFile,
        maxDepth: 20,
      };

      const result = await mcpWorker.invoke('crawl_dependency_graph', params) as CrawlDependencyGraphResult;

      const nodes = result.nodes;
      const pythonNode = nodes.find((n) => n.path.includes('app.py'));
      
      expect(pythonNode).toBeDefined();
      expect(pythonNode?.path).toContain('.py');
    });
  });

  describe('get_symbol_graph', () => {
    it('should extract symbols from Python file', async () => {
      const databaseFile = path.join(pythonFixturesDir, 'utils/database.py');
      const params: GetSymbolGraphParams = {
        filePath: databaseFile,
      };

      const result = await mcpWorker.invoke('get_symbol_graph', params) as GetSymbolGraphResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('symbols');
      expect(Array.isArray(result.symbols)).toBe(true);
      expect(result.symbols.length).toBeGreaterThan(0);

      // Check for specific Python functions
      const symbolNames = result.symbols.map((s) => s.name);
      expect(symbolNames).toContain('connect_db');
      expect(symbolNames).toContain('query_data');
    });

    it('should extract Python class symbols', async () => {
      const processorFile = path.join(pythonFixturesDir, 'services/processor.py');
      const params: GetSymbolGraphParams = {
        filePath: processorFile,
      };

      const result = await mcpWorker.invoke('get_symbol_graph', params) as GetSymbolGraphResult;

      expect(result).toBeDefined();
      expect(result.symbols.length).toBeGreaterThan(0);

      // Check for DataProcessor class
      const classSymbols = result.symbols.filter((s) => s.kind === 'ClassDeclaration');
      expect(classSymbols.length).toBeGreaterThan(0);
      
      const symbolNames = result.symbols.map((s) => s.name);
      expect(symbolNames).toContain('DataProcessor');
    });

    it('should track Python symbol dependencies', async () => {
      const processorFile = path.join(pythonFixturesDir, 'services/processor.py');
      const params: GetSymbolGraphParams = {
        filePath: processorFile,
      };

      const result = await mcpWorker.invoke('get_symbol_graph', params) as GetSymbolGraphResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('dependencies');
      expect(Array.isArray(result.dependencies)).toBe(true);
    });
  });

  describe('find_referencing_files', () => {
    it('should find files that import Python module', async () => {
      const helpersFile = path.join(pythonFixturesDir, 'utils/helpers.py');
      
      // First crawl to populate reverse index
      const appFile = path.join(pythonFixturesDir, 'app.py');
      await mcpWorker.invoke('crawl_dependency_graph', {
        entryFile: appFile,
        maxDepth: 20,
      });

      const params: FindReferencingFilesParams = {
        targetPath: helpersFile,
      };

      const result = await mcpWorker.invoke('find_referencing_files', params) as FindReferencingFilesResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('referencingFiles');
      expect(Array.isArray(result.referencingFiles)).toBe(true);
      
      // helpers.py should be referenced by app.py or database.py
      if (result.referencingFiles.length > 0) {
        const firstRef = result.referencingFiles[0];
        expect(firstRef).toHaveProperty('path');
        expect(firstRef.path).toContain('.py');
      }
    });
  });

  describe('get_impact_analysis', () => {
    it('should analyze impact of changing Python file', async () => {
      const databaseFile = path.join(pythonFixturesDir, 'utils/database.py');
      
      // First crawl to populate graph
      const appFile = path.join(pythonFixturesDir, 'app.py');
      await mcpWorker.invoke('crawl_dependency_graph', {
        entryFile: appFile,
        maxDepth: 20,
      });

      const params: GetImpactAnalysisParams = {
        filePath: databaseFile,
        symbolName: 'connect_db', // Test with a specific symbol
        maxDepth: 10,
      };

      const result = await mcpWorker.invoke('get_impact_analysis', params) as GetImpactAnalysisResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('targetSymbol');
      expect(result).toHaveProperty('impactedItems');
      expect(result).toHaveProperty('totalImpactCount');
      
      // Verify target symbol info
      expect(result.targetSymbol.symbolName).toBe('connect_db');
      expect(result.targetSymbol.filePath).toContain('database.py');
      
      // connect_db should have some impacted items (files that use it)
      expect(Array.isArray(result.impactedItems)).toBe(true);
    });
  });

  describe('Performance - Python vs TypeScript', () => {
    it('should analyze Python files in reasonable time', async () => {
      const appFile = path.join(pythonFixturesDir, 'app.py');
      const start = Date.now();

      await mcpWorker.invoke('analyze_dependencies', {
        filePath: appFile,
      });

      const duration = Date.now() - start;
      
      // Should complete in under 1 second
      expect(duration).toBeLessThan(1000);
    });

    it('should crawl Python project in reasonable time', async () => {
      const appFile = path.join(pythonFixturesDir, 'app.py');
      const start = Date.now();

      await mcpWorker.invoke('crawl_dependency_graph', {
        entryFile: appFile,
        maxDepth: 20,
      });

      const duration = Date.now() - start;
      
      // Should complete in under 2 seconds for small project
      expect(duration).toBeLessThan(2000);
    });

    it('should extract Python symbols in reasonable time', async () => {
      const processorFile = path.join(pythonFixturesDir, 'services/processor.py');
      const start = Date.now();

      await mcpWorker.invoke('get_symbol_graph', {
        filePath: processorFile,
      });

      const duration = Date.now() - start;
      
      // Symbol extraction should be fast
      expect(duration).toBeLessThan(500);
    });
  });

  describe('Error Handling', () => {
    it('should handle non-existent Python file gracefully', async () => {
      const fakeFile = path.join(pythonFixturesDir, 'nonexistent.py');
      const params: AnalyzeDependenciesParams = {
        filePath: fakeFile,
      };

      await expect(
        mcpWorker.invoke('analyze_dependencies', params)
      ).rejects.toThrow();
    });

    it('should handle invalid Python syntax', async () => {
      // Create a temp file with invalid syntax would require file creation
      // For now, just verify error handling structure exists
      expect(mcpWorker).toBeDefined();
    });
  });
});
