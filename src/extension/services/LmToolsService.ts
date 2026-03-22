/**
 * LmToolsService — registers Graph-It-Live analyzer tools as native VS Code
 * Language Model Tools (`vscode.lm.registerTool`).
 *
 * This is separate from the MCP server:
 *   - MCP targets external clients (Claude Desktop, Cursor, …)
 *   - LM Tools target Copilot Chat inside VS Code directly
 *
 * Architecture rule: this file IS in the extension layer and MAY import vscode.
 */

import { LspCallHierarchyAnalyzer } from '@/analyzer/LspCallHierarchyAnalyzer';
import type { Dependency } from '@/analyzer/types';
import { convertSpiderToLspFormat } from '@/shared/converters';
import { detectLanguageFromExtension } from '@/shared/utils/languageDetection';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import type { GraphProvider } from '../GraphProvider';
import type { VsCodeLogger } from '../extensionLogger';

// ─── Input types for each tool ────────────────────────────────────────────────

interface FindReferencingFilesInput {
  targetPath: string;
}

interface AnalyzeDependenciesInput {
  filePath: string;
}

interface CrawlDependencyGraphInput {
  entryFile: string;
  maxDepth?: number;
}

interface GetSymbolGraphInput {
  filePath: string;
}

interface FindUnusedSymbolsInput {
  filePath: string;
}

interface GetSymbolCallersInput {
  filePath: string;
  symbolName: string;
}

interface GetImpactAnalysisInput {
  filePath: string;
  symbolName: string;
  includeTransitive?: boolean;
  maxDepth?: number;
}

interface ParseImportsInput {
  filePath: string;
}

interface GenerateCodemapInput {
  filePath: string;
}

interface ExpandNodeInput {
  filePath: string;
  knownPaths?: string[];
  extraDepth?: number;
}

interface VerifyDependencyUsageInput {
  sourceFile: string;
  targetFile: string;
}

interface InvalidateFilesInput {
  filePaths: string[];
}

interface GetSymbolDependentsInput {
  filePath: string;
  symbolName: string;
}

interface TraceFunctionExecutionInput {
  filePath: string;
  symbolName: string;
  maxDepth?: number;
}

interface AnalyzeFileLogicInput {
  filePath: string;
}

interface ResolveModulePathInput {
  fromFile: string;
  moduleSpecifier: string;
}

interface AnalyzeBreakingChangesInput {
  filePath: string;
  oldContent: string;
  symbolName?: string;
  newContent?: string;
}

interface QueryCallGraphInput {
  filePath: string;
  symbolName: string;
  direction?: 'callers' | 'callees' | 'both';
  depth?: number;
  relationTypes?: string[];
}

// ─── Service options ──────────────────────────────────────────────────────────

interface LmToolsServiceOptions {
  provider: GraphProvider;
  logger: VsCodeLogger;
}

// ─── Local path helper (mirrors mcp/shared/helpers without importing MCP) ────

function toRelativePath(absolutePath: string, workspaceRoot: string): string {
  const rel = nodePath.relative(workspaceRoot, absolutePath);
  if (rel.startsWith('..') || nodePath.isAbsolute(rel)) {
    return absolutePath;
  }
  return rel.replaceAll('\\', '/');
}

function stripFilePrefix(symbolId: string): string {
  const idx = symbolId.lastIndexOf(':');
  return idx >= 0 ? symbolId.slice(idx + 1) : symbolId;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class LmToolsService {
  private readonly provider: GraphProvider;
  private readonly logger: VsCodeLogger;

  constructor(options: LmToolsServiceOptions) {
    this.provider = options.provider;
    this.logger = options.logger;
  }

  /**
   * Register all LM tools. Returns an array of Disposable objects.
   * Returns an empty array if VS Code doesn't support native LM tools.
   */
  registerAll(): vscode.Disposable[] {
    if (!('registerTool' in (vscode.lm as Record<string, unknown>))) {
      this.logger.warn('vscode.lm.registerTool not available — Native LM Tools disabled.');
      return [];
    }
    this.logger.info('Registering Graph-It-Live native Language Model Tools');
    return [
      this.registerFindReferencingFiles(),
      this.registerAnalyzeDependencies(),
      this.registerCrawlDependencyGraph(),
      this.registerGetSymbolGraph(),
      this.registerFindUnusedSymbols(),
      this.registerGetSymbolCallers(),
      this.registerGetImpactAnalysis(),
      this.registerGetIndexStatus(),
      this.registerParseImports(),
      this.registerGenerateCodemap(),
      this.registerExpandNode(),
      this.registerVerifyDependencyUsage(),
      this.registerInvalidateFiles(),
      this.registerRebuildIndex(),
      this.registerGetSymbolDependents(),
      this.registerTraceFunctionExecution(),
      this.registerAnalyzeFileLogic(),
      this.registerResolveModulePath(),
      this.registerAnalyzeBreakingChanges(),
      this.registerQueryCallGraph(),
    ];
  }

  // ─── Shared helpers ───────────────────────────────────────────────────────

  private errorResult(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify({ error: message })),
    ]);
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // ─── Tool: find_referencing_files ─────────────────────────────────────────

  private registerFindReferencingFiles(): vscode.Disposable {
    return vscode.lm.registerTool<FindReferencingFilesInput>(
      'graph-it-live_find_referencing_files',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<FindReferencingFilesInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { targetPath } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const references = await spider.findReferencingFiles(targetPath);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  targetPath,
                  referencingFileCount: references.length,
                  referencingFiles: references.map((ref) => ({
                    path: ref.path,
                    relativePath: rootDir ? toRelativePath(ref.path, rootDir) : ref.path,
                    type: ref.type,
                    line: ref.line,
                    module: ref.module,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: analyze_dependencies ──────────────────────────────────────────

  private registerAnalyzeDependencies(): vscode.Disposable {
    return vscode.lm.registerTool<AnalyzeDependenciesInput>(
      'graph-it-live_analyze_dependencies',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<AnalyzeDependenciesInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const dependencies = await spider.analyze(filePath);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  dependencyCount: dependencies.length,
                  dependencies: dependencies.map((dep) => ({
                    module: dep.module,
                    path: dep.path,
                    relativePath: dep.path && rootDir ? toRelativePath(dep.path, rootDir) : null,
                    type: dep.type,
                    line: dep.line,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: crawl_dependency_graph ────────────────────────────────────────

  private registerCrawlDependencyGraph(): vscode.Disposable {
    return vscode.lm.registerTool<CrawlDependencyGraphInput>(
      'graph-it-live_crawl_dependency_graph',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<CrawlDependencyGraphInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { entryFile, maxDepth } = options.input;
          const rootDir = this.getWorkspaceRoot();
          const configuredMaxDepth = vscode.workspace
            .getConfiguration('graph-it-live')
            .get<number>('maxDepth', 50);
          if (maxDepth !== undefined) {
            spider.updateConfig({ maxDepth });
          }
          try {
            const graph = await spider.crawl(entryFile);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  entryFile,
                  nodeCount: graph.nodes.length,
                  edgeCount: graph.edges.length,
                  nodes: graph.nodes.map((n) => ({
                    path: n,
                    relativePath: rootDir ? toRelativePath(n, rootDir) : n,
                  })),
                  edges: graph.edges.map((e) => ({
                    source: e.source,
                    target: e.target,
                    sourceRelative: rootDir ? toRelativePath(e.source, rootDir) : e.source,
                    targetRelative: rootDir ? toRelativePath(e.target, rootDir) : e.target,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          } finally {
            if (maxDepth !== undefined) {
              spider.updateConfig({ maxDepth: configuredMaxDepth });
            }
          }
        },
      },
    );
  }

  // ─── Tool: get_symbol_graph ───────────────────────────────────────────────

  private registerGetSymbolGraph(): vscode.Disposable {
    return vscode.lm.registerTool<GetSymbolGraphInput>(
      'graph-it-live_get_symbol_graph',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<GetSymbolGraphInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const { symbols, dependencies } = await spider.getSymbolGraph(filePath);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  relativePath: rootDir ? toRelativePath(filePath, rootDir) : filePath,
                  symbolCount: symbols.length,
                  dependencyCount: dependencies.length,
                  symbols,
                  dependencies: dependencies.map((dep) => ({
                    ...dep,
                    targetRelativePath: rootDir
                      ? toRelativePath(dep.targetFilePath, rootDir)
                      : dep.targetFilePath,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: find_unused_symbols ───────────────────────────────────────────

  private registerFindUnusedSymbols(): vscode.Disposable {
    return vscode.lm.registerTool<FindUnusedSymbolsInput>(
      'graph-it-live_find_unused_symbols',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<FindUnusedSymbolsInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const [unusedSymbols, { symbols }] = await Promise.all([
              spider.findUnusedSymbols(filePath),
              spider.getSymbolGraph(filePath),
            ]);
            const exportedCount = symbols.filter((s) => s.isExported).length;
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  relativePath: rootDir ? toRelativePath(filePath, rootDir) : filePath,
                  unusedCount: unusedSymbols.length,
                  totalExportedSymbols: exportedCount,
                  unusedPercentage:
                    exportedCount > 0
                      ? Math.round((unusedSymbols.length / exportedCount) * 100)
                      : 0,
                  unusedSymbols,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: get_symbol_callers ─────────────────────────────────────────────

  private registerGetSymbolCallers(): vscode.Disposable {
    return vscode.lm.registerTool<GetSymbolCallersInput>(
      'graph-it-live_get_symbol_callers',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<GetSymbolCallersInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath, symbolName } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const dependents = await spider.getSymbolDependents(filePath, symbolName);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  symbolName,
                  callerCount: dependents.length,
                  callers: dependents.map((dep) => ({
                    sourceSymbolId: dep.sourceSymbolId,
                    targetSymbolId: dep.targetSymbolId,
                    targetFilePath: dep.targetFilePath,
                    targetRelativePath: rootDir
                      ? toRelativePath(dep.targetFilePath, rootDir)
                      : dep.targetFilePath,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: get_impact_analysis ────────────────────────────────────────────

  private buildImpactItem(
    dep: { sourceSymbolId: string; targetFilePath: string; isTypeOnly?: boolean },
    depth: number,
    rootDir: string | undefined,
  ): { symbolId: string; targetFilePath: string; relativePath: string; usageType: 'runtime' | 'type-only'; depth: number } {
    return {
      symbolId: dep.sourceSymbolId,
      targetFilePath: dep.targetFilePath,
      relativePath: rootDir ? toRelativePath(dep.targetFilePath, rootDir) : dep.targetFilePath,
      usageType: dep.isTypeOnly ? 'type-only' : 'runtime',
      depth,
    };
  }

  private computeImpactLevel(runtimeCount: number, totalCount: number): 'high' | 'medium' | 'low' {
    if (runtimeCount >= 10 || totalCount >= 20) return 'high';
    if (runtimeCount >= 3 || totalCount >= 5) return 'medium';
    return 'low';
  }

  private processTransitiveDep(
    dep: { sourceSymbolId: string; targetFilePath: string; isTypeOnly?: boolean },
    currentDepth: number,
    maxDepth: number,
    visited: Set<string>,
    rootDir: string | undefined,
    queue: Array<{ symbolId: string; depth: number }>,
    result: ReturnType<LmToolsService['buildImpactItem']>[],
  ): void {
    if (visited.has(dep.sourceSymbolId)) return;
    visited.add(dep.sourceSymbolId);
    result.push(this.buildImpactItem(dep, currentDepth, rootDir));
    if (currentDepth < maxDepth) {
      queue.push({ symbolId: dep.sourceSymbolId, depth: currentDepth + 1 });
    }
  }

  private async collectTransitiveDependents(
    directDependents: Array<{ sourceSymbolId: string; targetFilePath: string; isTypeOnly?: boolean }>,
    spider: ReturnType<GraphProvider['getSpiderForLmTools']> & object,
    maxDepth: number,
    rootDir: string | undefined,
  ): Promise<ReturnType<LmToolsService['buildImpactItem']>[]> {
    const visited = new Set<string>(directDependents.map((d) => d.sourceSymbolId));
    const queue = directDependents.map((d) => ({ symbolId: d.sourceSymbolId, depth: 2 }));
    const transitiveItems: ReturnType<LmToolsService['buildImpactItem']>[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth > maxDepth) continue;

      const colonIdx = current.symbolId.lastIndexOf(':');
      if (colonIdx <= 0) continue;

      const sym = current.symbolId.slice(colonIdx + 1);
      const fp = current.symbolId.slice(0, colonIdx);

      try {
        const deps = await spider.getSymbolDependents(fp, sym);
        for (const dep of deps) {
          this.processTransitiveDep(dep, current.depth, maxDepth, visited, rootDir, queue, transitiveItems);
        }
      } catch {
        // skip symbols that fail to analyze
      }
    }
    return transitiveItems;
  }

  private registerGetImpactAnalysis(): vscode.Disposable {
    return vscode.lm.registerTool<GetImpactAnalysisInput>(
      'graph-it-live_get_impact_analysis',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<GetImpactAnalysisInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath, symbolName, includeTransitive = false, maxDepth = 3 } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const directDependents = await spider.getSymbolDependents(filePath, symbolName);
            const impactedItems = directDependents.map((dep) => this.buildImpactItem(dep, 1, rootDir));

            if (includeTransitive && maxDepth > 1) {
              const transitiveItems = await this.collectTransitiveDependents(
                directDependents, spider, maxDepth, rootDir,
              );
              impactedItems.push(...transitiveItems);
            }

            const runtimeCount = impactedItems.filter((i) => i.usageType === 'runtime').length;
            const affectedFiles = new Set(impactedItems.map((i) => i.targetFilePath));

            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  symbolId: `${filePath}:${symbolName}`,
                  filePath,
                  symbolName,
                  impactLevel: this.computeImpactLevel(runtimeCount, impactedItems.length),
                  totalImpactCount: impactedItems.length,
                  directCount: impactedItems.filter((i) => i.depth === 1).length,
                  affectedFileCount: affectedFiles.size,
                  runtimeCount,
                  typeOnlyCount: impactedItems.filter((i) => i.usageType === 'type-only').length,
                  impactedItems,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: get_index_status ───────────────────────────────────────────────

  private registerGetIndexStatus(): vscode.Disposable {
    return vscode.lm.registerTool<Record<string, never>>(
      'graph-it-live_get_index_status',
      {
        invoke: async (
          _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  state: 'uninitialized',
                  isReady: false,
                  message: 'No workspace open or dependency index not initialized.',
                }),
              ),
            ]);
          }
          try {
            const indexStatus = spider.getIndexStatus();
            const cacheStats = await spider.getCacheStatsAsync();
            const normalizedState =
              indexStatus.state === 'validating' ? 'indexing' : indexStatus.state;
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  state: normalizedState,
                  isReady:
                    indexStatus.state === 'idle' ||
                    indexStatus.state === 'complete',
                  hasReverseIndex: spider.hasReverseIndex(),
                  cacheSize: cacheStats.dependencyCache.size,
                  reverseIndexStats: cacheStats.reverseIndexStats,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: parse_imports ──────────────────────────────────────────────────

  private registerParseImports(): vscode.Disposable {
    return vscode.lm.registerTool<ParseImportsInput>(
      'graph-it-live_parse_imports',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<ParseImportsInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath } = options.input;
          try {
            // spider.analyze() runs the full parser pipeline and returns resolved imports
            const imports = await spider.analyze(filePath);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  importCount: imports.length,
                  imports: imports.map((imp) => ({
                    module: imp.module,
                    type: imp.type,
                    line: imp.line,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: generate_codemap ───────────────────────────────────────────────

  private registerGenerateCodemap(): vscode.Disposable {
    return vscode.lm.registerTool<GenerateCodemapInput>(
      'graph-it-live_generate_codemap',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<GenerateCodemapInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath } = options.input;
          const rootDir = this.getWorkspaceRoot();
          const startTime = Date.now();
          try {
            const ext = nodePath.extname(filePath).toLowerCase();
            const language = detectLanguageFromExtension(ext);
            const relativePath = rootDir ? toRelativePath(filePath, rootDir) : filePath;

            const content = await fs.readFile(filePath, 'utf-8');
            const lineCount = content.split('\n').length;

            const [{ symbols, dependencies: symbolDeps }, deps] = await Promise.all([
              spider.getSymbolGraph(filePath),
              spider.analyze(filePath),
            ]);

            let refs: Dependency[] = [];
            try {
              refs = await spider.findReferencingFiles(filePath);
            } catch {
              // reverse index may not be ready yet — non-fatal
            }

            let callFlow: Array<{ caller: string; callee: string; line: number }> = [];
            let hasCycle = false;
            let cycleSymbols: string[] = [];
            try {
              const lspData = convertSpiderToLspFormat(
                { symbols, dependencies: symbolDeps },
                filePath,
              );
              const analyzer = new LspCallHierarchyAnalyzer();
              const graph = analyzer.buildIntraFileGraph(filePath, lspData);
              callFlow = graph.edges.map((e) => ({
                caller: stripFilePrefix(e.source),
                callee: stripFilePrefix(e.target),
                line: e.line,
              }));
              hasCycle = graph.hasCycle;
              cycleSymbols = (graph.cycleNodes ?? []).map(stripFilePrefix);
            } catch {
              // call hierarchy analysis failed — non-fatal, return partial result
            }

            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  relativePath,
                  language,
                  lineCount,
                  exports: symbols
                    .filter((s) => s.isExported)
                    .map((s) => ({
                      name: s.name,
                      kind: s.kind,
                      line: s.line,
                      category: s.category,
                    })),
                  internals: symbols
                    .filter((s) => !s.isExported)
                    .map((s) => ({
                      name: s.name,
                      kind: s.kind,
                      line: s.line,
                      category: s.category,
                    })),
                  dependencies: deps.map((d) => ({
                    module: d.module,
                    resolvedPath: d.path,
                    relativePath: d.path && rootDir ? toRelativePath(d.path, rootDir) : null,
                    type: d.type,
                    line: d.line,
                  })),
                  dependents: refs.map((r) => ({
                    path: r.path,
                    relativePath: rootDir ? toRelativePath(r.path, rootDir) : r.path,
                    type: r.type,
                    line: r.line,
                  })),
                  callFlow,
                  hasCycle,
                  cycleSymbols,
                  analysisTimeMs: Date.now() - startTime,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: expand_node ─────────────────────────────────────────────────────

  private registerExpandNode(): vscode.Disposable {
    return vscode.lm.registerTool<ExpandNodeInput>(
      'graph-it-live_expand_node',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<ExpandNodeInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath, knownPaths = [] } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const graph = await spider.crawl(filePath);
            const knownSet = new Set(knownPaths.map((p) => p.replaceAll('\\', '/')));
            const newNodes = graph.nodes.filter(
              (n) => !knownSet.has(n.replaceAll('\\', '/')),
            );
            const newNodeIds = new Set(newNodes);
            const newEdges = graph.edges.filter(
              (e) => newNodeIds.has(e.source) || newNodeIds.has(e.target),
            );
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  newNodeCount: newNodes.length,
                  newEdgeCount: newEdges.length,
                  newNodes: newNodes.map((n) => ({
                    path: n,
                    relativePath: rootDir ? toRelativePath(n, rootDir) : n,
                  })),
                  newEdges: newEdges.map((e) => ({
                    source: e.source,
                    target: e.target,
                    sourceRelative: rootDir ? toRelativePath(e.source, rootDir) : e.source,
                    targetRelative: rootDir ? toRelativePath(e.target, rootDir) : e.target,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: verify_dependency_usage ─────────────────────────────────────────

  private registerVerifyDependencyUsage(): vscode.Disposable {
    return vscode.lm.registerTool<VerifyDependencyUsageInput>(
      'graph-it-live_verify_dependency_usage',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<VerifyDependencyUsageInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { sourceFile, targetFile } = options.input;
          try {
            const isUsed = await spider.verifyDependencyUsage(sourceFile, targetFile);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({ sourceFile, targetFile, isUsed }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: invalidate_files ────────────────────────────────────────────────

  private registerInvalidateFiles(): vscode.Disposable {
    return vscode.lm.registerTool<InvalidateFilesInput>(
      'graph-it-live_invalidate_files',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<InvalidateFilesInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePaths } = options.input;
          try {
            const invalidatedFiles: string[] = [];
            const notFoundFiles: string[] = [];
            for (const fp of filePaths) {
              const wasInvalidated = spider.invalidateFile(fp);
              if (wasInvalidated) {
                invalidatedFiles.push(fp);
              } else {
                notFoundFiles.push(fp);
              }
            }
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  invalidatedCount: invalidatedFiles.length,
                  invalidatedFiles,
                  notFoundFiles,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: rebuild_index ───────────────────────────────────────────────────

  private registerRebuildIndex(): vscode.Disposable {
    return vscode.lm.registerTool<Record<string, never>>(
      'graph-it-live_rebuild_index',
      {
        invoke: async (
          _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          try {
            const startTime = Date.now();
            spider.clearCache();
            await spider.buildFullIndex();
            const rebuildTimeMs = Date.now() - startTime;
            const cacheStats = await spider.getCacheStatsAsync();
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  rebuildTimeMs,
                  newCacheSize: cacheStats.dependencyCache.size,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: get_symbol_dependents ──────────────────────────────────────────

  private registerGetSymbolDependents(): vscode.Disposable {
    return vscode.lm.registerTool<GetSymbolDependentsInput>(
      'graph-it-live_get_symbol_dependents',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<GetSymbolDependentsInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath, symbolName } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const dependents = await spider.getSymbolDependents(filePath, symbolName);
            const symbolId = `${filePath}:${symbolName}`;
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  symbolId,
                  dependentCount: dependents.length,
                  dependents: dependents.map((d) => ({
                    symbolId: d.targetSymbolId ?? d.sourceSymbolId,
                    filePath: d.targetFilePath,
                    relativePath: d.targetFilePath && rootDir
                      ? toRelativePath(d.targetFilePath, rootDir)
                      : d.targetFilePath,
                  })),
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: trace_function_execution ───────────────────────────────────────

  private registerTraceFunctionExecution(): vscode.Disposable {
    return vscode.lm.registerTool<TraceFunctionExecutionInput>(
      'graph-it-live_trace_function_execution',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<TraceFunctionExecutionInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath, symbolName, maxDepth = 10 } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const result = await spider.traceFunctionExecution(filePath, symbolName, maxDepth);
            const relativePath = rootDir ? toRelativePath(filePath, rootDir) : filePath;
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  rootSymbol: {
                    id: result.rootSymbol.id,
                    filePath: result.rootSymbol.filePath,
                    relativePath,
                    symbolName: result.rootSymbol.symbolName,
                  },
                  maxDepth,
                  callCount: result.callChain.length,
                  uniqueSymbolCount: result.visitedSymbols.length,
                  maxDepthReached: result.maxDepthReached,
                  callChain: result.callChain.map((entry) => ({
                    depth: entry.depth,
                    callerSymbolId: entry.callerSymbolId,
                    calledSymbolId: entry.calledSymbolId,
                    calledFilePath: entry.calledFilePath,
                    resolvedFilePath: entry.resolvedFilePath,
                    resolvedRelativePath: entry.resolvedFilePath && rootDir
                      ? toRelativePath(entry.resolvedFilePath, rootDir)
                      : null,
                  })),
                  visitedSymbols: result.visitedSymbols,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: analyze_file_logic ──────────────────────────────────────────────

  private registerAnalyzeFileLogic(): vscode.Disposable {
    return vscode.lm.registerTool<AnalyzeFileLogicInput>(
      'graph-it-live_analyze_file_logic',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<AnalyzeFileLogicInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { filePath } = options.input;
          const startTime = Date.now();
          try {
            const symbolGraphData = await spider.getSymbolGraph(filePath);
            const lspData = convertSpiderToLspFormat(symbolGraphData, filePath);
            const analyzer = new LspCallHierarchyAnalyzer();
            const graph = analyzer.buildIntraFileGraph(filePath, lspData);
            const analysisTimeMs = Date.now() - startTime;
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  graph: {
                    nodes: graph.nodes,
                    edges: graph.edges,
                    hasCycle: graph.hasCycle,
                    cycleNodes: graph.cycleNodes ?? [],
                    cycleType: graph.cycleType,
                  },
                  analysisTimeMs,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: resolve_module_path ─────────────────────────────────────────────

  private registerResolveModulePath(): vscode.Disposable {
    return vscode.lm.registerTool<ResolveModulePathInput>(
      'graph-it-live_resolve_module_path',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<ResolveModulePathInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { fromFile, moduleSpecifier } = options.input;
          const rootDir = this.getWorkspaceRoot();
          try {
            const resolvedPath = await spider.resolveModuleSpecifier(fromFile, moduleSpecifier);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  fromFile,
                  moduleSpecifier,
                  resolved: resolvedPath !== null,
                  resolvedPath,
                  resolvedRelativePath: resolvedPath && rootDir
                    ? toRelativePath(resolvedPath, rootDir)
                    : null,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: analyze_breaking_changes ───────────────────────────────────────

  private registerAnalyzeBreakingChanges(): vscode.Disposable {
    return vscode.lm.registerTool<AnalyzeBreakingChangesInput>(
      'graph-it-live_analyze_breaking_changes',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<AnalyzeBreakingChangesInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const { filePath, oldContent, symbolName, newContent: inputNewContent } = options.input;
          let newContent = inputNewContent;
          if (!newContent) {
            try {
              newContent = await fs.readFile(filePath, 'utf-8');
            } catch {
              return this.errorResult(`Cannot read current file: ${filePath}`);
            }
          }
          try {
            const { SignatureAnalyzer } = await import('@/analyzer/SignatureAnalyzer');
            const analyzer = new SignatureAnalyzer();
            let results = analyzer.analyzeBreakingChanges(filePath, oldContent, newContent);
            if (symbolName) {
              results = results.filter(r => r.symbolName === symbolName);
            }
            const breakingChanges = results.flatMap(r => r.breakingChanges);
            const nonBreakingChanges = results.flatMap(r => r.nonBreakingChanges);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  symbolName: symbolName ?? null,
                  hasBreakingChanges: breakingChanges.length > 0,
                  breakingChangesCount: breakingChanges.length,
                  nonBreakingChangesCount: nonBreakingChanges.length,
                  breakingChanges,
                  nonBreakingChanges,
                }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: query_call_graph ────────────────────────────────────────────────

  private registerQueryCallGraph(): vscode.Disposable {
    return vscode.lm.registerTool<QueryCallGraphInput>(
      'graph-it-live_query_call_graph',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<QueryCallGraphInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const callGraphService = this.provider.getCallGraphViewServiceForLmTools();
          const indexer = callGraphService?.getCallGraphIndexerForLmTools();
          if (!indexer) {
            return this.errorResult(
              'Call graph index not available. Open the Call Graph panel (graph-it-live.showCallGraph) first to build the index.',
            );
          }
          const { filePath, symbolName, direction = 'both', depth = 2, relationTypes } = options.input;
          try {
            const { normalizePath } = await import('@/shared/path');
            const db = indexer.getDb();
            const normalizedPath = normalizePath(filePath);
            const symbolRows = db.exec(
              'SELECT id, name, type, lang, path, start_line, end_line, is_exported FROM nodes WHERE path = ? AND name = ?',
              [normalizedPath, symbolName],
            );
            if (!symbolRows[0] || symbolRows[0].values.length === 0) {
              return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                  JSON.stringify({ symbol: null, callers: [], callees: [], totalCallers: 0, totalCallees: 0, depth, direction }),
                ),
              ]);
            }
            const row = symbolRows[0].values[0];
            const symbolId = row[0] as string;
            const symbol = {
              id: symbolId, name: row[1] as string, type: row[2] as string,
              lang: row[3] as string, filePath: row[4] as string,
              startLine: row[5] as number, endLine: row[6] as number,
              isExported: (row[7] as number) === 1,
            };
            const callers = (direction === 'callers' || direction === 'both')
              ? this.callGraphBfs(db, symbolId, 'callers', depth, relationTypes ?? null) : [];
            const callees = (direction === 'callees' || direction === 'both')
              ? this.callGraphBfs(db, symbolId, 'callees', depth, relationTypes ?? null) : [];
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({ symbol, callers, callees, totalCallers: callers.length, totalCallees: callees.length, depth, direction }),
              ),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  private callGraphBfs(
    db: import('sql.js').Database,
    rootId: string,
    dir: 'callers' | 'callees',
    maxDepth: number,
    relationFilter: string[] | null,
  ): unknown[] {
    const visited = new Set<string>();
    const results: unknown[] = [];
    let frontier = new Set<string>([rootId]);
    for (let d = 0; d < maxDepth && frontier.size > 0; d++) {
      const next = new Set<string>();
      for (const nodeId of frontier) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        this.callGraphExpandNode(db, nodeId, dir, relationFilter, results, visited, next);
      }
      frontier = next;
    }
    return results;
  }

  private callGraphExpandNode(
    db: import('sql.js').Database,
    nodeId: string,
    dir: 'callers' | 'callees',
    relationFilter: string[] | null,
    results: unknown[],
    visited: Set<string>,
    next: Set<string>,
  ): void {
    const joinCol = dir === 'callers' ? 'e.target_id' : 'e.source_id';
    const otherCol = dir === 'callers' ? 'e.source_id' : 'e.target_id';
    let sql = `SELECT e.source_id, e.target_id, e.type_relation, e.is_cyclic, e.source_line,
      src.name, src.path, tgt.name, tgt.path
      FROM edges e
      JOIN nodes src ON src.id = e.source_id
      JOIN nodes tgt ON tgt.id = e.target_id
      WHERE ${joinCol} = ?`;
    const params: (string | number)[] = [nodeId];
    if (relationFilter && relationFilter.length > 0) {
      sql += ` AND e.type_relation IN (${relationFilter.map(() => '?').join(',')})`;
      params.push(...relationFilter);
    }
    sql += ` AND ${otherCol} NOT LIKE '@@external:%'`;
    const rows = db.exec(sql, params);
    if (!rows[0]) return;
    for (const r of rows[0].values) {
      results.push({
        sourceId: r[0], targetId: r[1], relation: r[2],
        isCyclic: (r[3] as number) === 1, sourceLine: r[4],
        sourceName: r[5], sourceFile: r[6], targetName: r[7], targetFile: r[8],
      });
      const nextId = (dir === 'callers' ? r[0] : r[1]) as string;
      if (!visited.has(nextId)) next.add(nextId);
    }
  }
}
