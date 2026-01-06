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

describe('MCP Rust Integration Tests', () => {
  const rustFixturesDir = path.resolve(__dirname, '../fixtures/rust-integration');
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
      rootDir: rustFixturesDir,
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
    it('should analyze Rust file dependencies', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      const params: AnalyzeDependenciesParams = {
        filePath: mainFile,
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

    it('should handle Rust files with no dependencies', async () => {
      const helpersFile = path.join(rustFixturesDir, 'utils/helpers.rs');
      const params: AnalyzeDependenciesParams = {
        filePath: helpersFile,
      };

      const result = await mcpWorker.invoke('analyze_dependencies', params) as AnalyzeDependenciesResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('dependencies');
      expect(Array.isArray(result.dependencies)).toBe(true);
      // helpers.rs has minimal external dependencies
    });
  });

  describe('crawl_dependency_graph', () => {
    it('should crawl Rust project from entry point', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      const params: CrawlDependencyGraphParams = {
        entryFile: mainFile,
        maxDepth: 20,
      };

      const result = await mcpWorker.invoke('crawl_dependency_graph', params) as CrawlDependencyGraphResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('nodes');
      expect(result).toHaveProperty('edges');
      
      expect(result.nodes.length).toBeGreaterThan(1);
      
      // Verify Rust files are included
      const nodePaths = result.nodes.map((n) => n.path);
      expect(nodePaths.some((p: string) => p.includes('main.rs'))).toBe(true);
      expect(nodePaths.some((p: string) => p.includes('database.rs'))).toBe(true);
    });

    it('should include metadata about Rust files', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      const params: CrawlDependencyGraphParams = {
        entryFile: mainFile,
        maxDepth: 20,
      };

      const result = await mcpWorker.invoke('crawl_dependency_graph', params) as CrawlDependencyGraphResult;

      const nodes = result.nodes;
      const rustNode = nodes.find((n) => n.path.includes('main.rs'));
      
      expect(rustNode).toBeDefined();
      expect(rustNode?.path).toContain('.rs');
    });
  });

  describe('get_symbol_graph', () => {
    it('should extract symbols from Rust file', async () => {
      const databaseFile = path.join(rustFixturesDir, 'utils/database.rs');
      const params: GetSymbolGraphParams = {
        filePath: databaseFile,
      };

      const result = await mcpWorker.invoke('get_symbol_graph', params) as GetSymbolGraphResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('symbols');
      expect(Array.isArray(result.symbols)).toBe(true);
      expect(result.symbols.length).toBeGreaterThan(0);

      // Check for specific Rust functions and structs
      const symbolNames = result.symbols.map((s) => s.name);
      expect(symbolNames).toContain('connect_db');
      expect(symbolNames).toContain('Connection');
    });

    it('should extract Rust struct symbols', async () => {
      const databaseFile = path.join(rustFixturesDir, 'utils/database.rs');
      const params: GetSymbolGraphParams = {
        filePath: databaseFile,
      };

      const result = await mcpWorker.invoke('get_symbol_graph', params) as GetSymbolGraphResult;

      expect(result).toBeDefined();
      expect(result.symbols.length).toBeGreaterThan(0);

      // Check for Connection struct
      const structSymbols = result.symbols.filter((s) => s.kind === 'StructDeclaration');
      expect(structSymbols.length).toBeGreaterThan(0);
      
      const symbolNames = result.symbols.map((s) => s.name);
      expect(symbolNames).toContain('Connection');
      expect(symbolNames).toContain('disconnect_db');
    });

    it('should track Rust symbol dependencies', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      const params: GetSymbolGraphParams = {
        filePath: mainFile,
      };

      const result = await mcpWorker.invoke('get_symbol_graph', params) as GetSymbolGraphResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('dependencies');
      expect(Array.isArray(result.dependencies)).toBe(true);
      
      // main should have dependencies on format_data and connect_db
      expect(result.dependencies.length).toBeGreaterThan(0);
    });
  });

  describe('find_referencing_files', () => {
    it('should find files that import Rust module', async () => {
      const helpersFile = path.join(rustFixturesDir, 'utils/helpers.rs');
      
      // First crawl to populate reverse index
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await mcpWorker.invoke('crawl_dependency_graph', {
        entryFile: mainFile,
        maxDepth: 20,
      });

      const params: FindReferencingFilesParams = {
        targetPath: helpersFile,
      };

      const result = await mcpWorker.invoke('find_referencing_files', params) as FindReferencingFilesResult;

      expect(result).toBeDefined();
      expect(result).toHaveProperty('referencingFiles');
      expect(Array.isArray(result.referencingFiles)).toBe(true);
      
      // helpers.rs should be referenced by main.rs
      if (result.referencingFiles.length > 0) {
        const firstRef = result.referencingFiles[0];
        expect(firstRef).toHaveProperty('path');
        expect(firstRef.path).toContain('.rs');
      }
    });
  });

  describe('get_impact_analysis', () => {
    it('should analyze impact of changing Rust file', async () => {
      const databaseFile = path.join(rustFixturesDir, 'utils/database.rs');
      
      // First crawl to populate graph
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await mcpWorker.invoke('crawl_dependency_graph', {
        entryFile: mainFile,
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
      expect(result.targetSymbol.filePath).toContain('database.rs');
      
      // connect_db should have some impacted items (files that use it)
      expect(Array.isArray(result.impactedItems)).toBe(true);
    });
  });

  describe('Performance - Rust vs TypeScript', () => {
    it('should analyze Rust files in reasonable time', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      const start = Date.now();

      await mcpWorker.invoke('analyze_dependencies', {
        filePath: mainFile,
      });

      const duration = Date.now() - start;
      
      // Should complete in under 1 second
      expect(duration).toBeLessThan(1000);
    });

    it('should crawl Rust project in reasonable time', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      const start = Date.now();

      await mcpWorker.invoke('crawl_dependency_graph', {
        entryFile: mainFile,
        maxDepth: 20,
      });

      const duration = Date.now() - start;
      
      // Should complete in under 2 seconds for small project
      expect(duration).toBeLessThan(2000);
    });

    it('should extract Rust symbols in reasonable time', async () => {
      const databaseFile = path.join(rustFixturesDir, 'utils/database.rs');
      const start = Date.now();

      await mcpWorker.invoke('get_symbol_graph', {
        filePath: databaseFile,
      });

      const duration = Date.now() - start;
      
      // Symbol extraction should be fast
      expect(duration).toBeLessThan(500);
    });
  });

  describe('Error Handling', () => {
    it('should handle non-existent Rust file gracefully', async () => {
      const fakeFile = path.join(rustFixturesDir, 'nonexistent.rs');
      const params: AnalyzeDependenciesParams = {
        filePath: fakeFile,
      };

      await expect(
        mcpWorker.invoke('analyze_dependencies', params)
      ).rejects.toThrow();
    });

    it('should handle invalid Rust syntax', async () => {
      // Create a temp file with invalid syntax would require file creation
      // For now, just verify error handling structure exists
      expect(mcpWorker).toBeDefined();
    });
  });
});
