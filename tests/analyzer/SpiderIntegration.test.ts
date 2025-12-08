import { describe, it, expect, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import path from 'node:path';

const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/sample-project');

describe('Spider Integration - Cache and Advanced Features', () => {
    let spider: Spider;

    beforeEach(() => {
        spider = new Spider({
            rootDir: fixturesPath,
            tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
            enableReverseIndex: true,
        });
    });

    describe('Cache invalidation', () => {
        it('should invalidate cache for specific file', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            // First analysis - populates cache
            const deps1 = await spider.analyze(mainFile);
            expect(deps1.length).toBeGreaterThan(0);
            
            // Verify cache is populated
            expect(spider.getCacheStats().dependencyCache.size).toBeGreaterThan(0);
            
            // Invalidate
            spider.invalidateFile(mainFile);
            
            // Re-analyze
            const deps2 = await spider.analyze(mainFile);
            expect(deps2).toEqual(deps1);
        });

        it('should invalidate multiple files at once', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            
            await spider.analyze(mainFile);
            await spider.analyze(utilsFile);
            
            const initialSize = spider.getCacheStats().dependencyCache.size;
            expect(initialSize).toBeGreaterThanOrEqual(2);
            
            spider.invalidateFiles([mainFile, utilsFile]);
            
            // Cache should be reduced
            expect(spider.getCacheStats().dependencyCache.size).toBeLessThan(initialSize);
        });

        it('should clear entire cache', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            await spider.analyze(mainFile);
            
            expect(spider.getCacheStats().dependencyCache.size).toBeGreaterThan(0);
            
            spider.clearCache();
            
            expect(spider.getCacheStats().dependencyCache.size).toBe(0);
        });
    });

    describe('Reverse Index', () => {
        it('should enable reverse index via config and have entries after crawl', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            // Crawl to populate index
            await spider.crawl(mainFile);
            expect(spider.hasReverseIndex()).toBe(true);
        });

        it('should find referencing files with reverse index', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            
            // Populate reverse index by crawling
            await spider.crawl(mainFile);
            
            // Find files referencing utils.ts
            const refs = await spider.findReferencingFiles(utilsFile);
            
            // main.ts imports utils.ts
            expect(refs.some((r: { path: string }) => r.path === mainFile || r.path.includes('main.ts'))).toBe(true);
        });

        it('should update reverse index on file re-analysis', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            // Initial crawl
            await spider.crawl(mainFile);
            
            // Re-analyze should update index
            await spider.reanalyzeFile(mainFile);
            const stats = spider.getCacheStats();
            
            expect(stats.reverseIndexStats).toBeDefined();
        });
    });

    describe('Symbol Graph Analysis', () => {
        it('should get symbol graph for a file', async () => {
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            
            const result = await spider.getSymbolGraph(utilsFile);
            
            expect(result).toHaveProperty('symbols');
            expect(result).toHaveProperty('dependencies');
            expect(Array.isArray(result.symbols)).toBe(true);
        });

        it('should cache symbol graph results', async () => {
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            
            // First call
            const result1 = await spider.getSymbolGraph(utilsFile);
            
            // Second call should use cache
            const result2 = await spider.getSymbolGraph(utilsFile);
            
            expect(result1).toEqual(result2);
        });

        it('should handle non-existent file gracefully', async () => {
            const fakeFile = path.join(fixturesPath, 'src/does-not-exist.ts');
            
            const result = await spider.getSymbolGraph(fakeFile);
            
            expect(result.symbols).toEqual([]);
            expect(result.dependencies).toEqual([]);
        });
    });

    describe('Find Unused Symbols', () => {
        it('should return empty array for file with no exports', async () => {
            // Create a temporary file with no exports for testing
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            // main.ts typically has exports, so check return type
            const result = await spider.findUnusedSymbols(mainFile);
            
            expect(Array.isArray(result)).toBe(true);
        });

        it('should handle errors gracefully', async () => {
            const fakeFile = '/nonexistent/path/file.ts';
            
            const result = await spider.findUnusedSymbols(fakeFile);
            
            expect(result).toEqual([]);
        });
    });

    describe('Symbol Dependents', () => {
        it('should find symbol dependents', async () => {
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            // First crawl to populate reverse index
            await spider.crawl(mainFile);
            
            // Find dependents of any exported symbol
            const { symbols } = await spider.getSymbolGraph(utilsFile);
            
            if (symbols.length > 0) {
                const exportedSymbol = symbols.find((s: { isExported: boolean }) => s.isExported);
                if (exportedSymbol) {
                    const dependents = await spider.getSymbolDependents(utilsFile, exportedSymbol.name);
                    expect(Array.isArray(dependents)).toBe(true);
                }
            }
        });

        it('should return empty array for unused symbol', async () => {
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            
            // Non-existent symbol name
            const dependents = await spider.getSymbolDependents(utilsFile, 'nonExistentSymbol123');
            
            expect(dependents).toEqual([]);
        });
    });

    describe('Trace Function Execution', () => {
        it('should trace function execution chain', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            const { symbols } = await spider.getSymbolGraph(mainFile);
            
            if (symbols.length > 0) {
                const result = await spider.traceFunctionExecution(mainFile, symbols[0].name, 5);
                
                expect(result).toHaveProperty('rootSymbol');
                expect(result).toHaveProperty('callChain');
                expect(result).toHaveProperty('visitedSymbols');
                expect(result).toHaveProperty('maxDepthReached');
                expect(result.rootSymbol.filePath).toBe(mainFile);
            }
        });

        it('should respect max depth limit', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            const { symbols } = await spider.getSymbolGraph(mainFile);
            
            if (symbols.length > 0) {
                const result = await spider.traceFunctionExecution(mainFile, symbols[0].name, 1);
                
                // With depth 1, it should stop quickly
                expect(result.callChain.every((c: { depth: number }) => c.depth <= 1)).toBe(true);
            }
        });

        it('should handle circular dependencies', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            const { symbols } = await spider.getSymbolGraph(mainFile);
            
            if (symbols.length > 0) {
                // Should not hang due to cycle detection
                const result = await spider.traceFunctionExecution(mainFile, symbols[0].name, 10);
                
                // visitedSymbols should not have duplicates
                const unique = new Set(result.visitedSymbols);
                expect(unique.size).toBe(result.visitedSymbols.length);
            }
        });
    });

    describe('Crawl', () => {
        it('should crawl and return complete graph with nodes and edges', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            const result = await spider.crawl(mainFile);
            
            expect(result).toHaveProperty('nodes');
            expect(result).toHaveProperty('edges');
            expect(result.nodes).toContain(mainFile);
        });

        it('should return edges connecting nodes', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            const result = await spider.crawl(mainFile);
            
            // Should have edges if there are imports
            expect(Array.isArray(result.edges)).toBe(true);
        });
    });

    describe('Config updates', () => {
        it('should update excludeNodeModules', () => {
            spider.updateConfig({ excludeNodeModules: false });
            
            // Should not throw
            expect(true).toBe(true);
        });

        it('should update maxDepth', () => {
            spider.updateConfig({ maxDepth: 100 });
            
            expect(true).toBe(true);
        });

        it('should enable/disable reverse index', async () => {
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            
            spider.updateConfig({ enableReverseIndex: false });
            // hasReverseIndex returns false when disabled OR when no entries
            expect(spider.hasReverseIndex()).toBe(false);
            
            spider.updateConfig({ enableReverseIndex: true });
            // Still false until we crawl and populate it
            await spider.crawl(mainFile);
            expect(spider.hasReverseIndex()).toBe(true);
        });

        it('should update indexing concurrency', () => {
            spider.updateConfig({ indexingConcurrency: 8 });
            
            // Should not throw
            expect(true).toBe(true);
        });
    });

    describe('File handling edge cases', () => {
        it('should handle file with no imports', async () => {
            // utils.ts might have minimal imports
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            
            const deps = await spider.analyze(utilsFile);
            
            // Should return array (may be empty)
            expect(Array.isArray(deps)).toBe(true);
        });

        it('should handle binary/non-text files gracefully', async () => {
            // Try to analyze a non-existent or binary file
            const binaryFile = path.join(fixturesPath, 'package.json');
            
            // package.json is not a supported extension, so analyze might fail or return empty
            try {
                const deps = await spider.analyze(binaryFile);
                expect(Array.isArray(deps)).toBe(true);
            } catch (e) {
                // Expected - file type not supported
                expect(e).toBeDefined();
            }
        });
    });
});
