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

import { IndexCache } from '@/analyzer/cache/IndexCache';
import { LspCallHierarchyAnalyzer } from '@/analyzer/LspCallHierarchyAnalyzer';
import { ReviewGateAnalyzer } from '@/analyzer/ReviewGateAnalyzer';
import { reportOutOfRootImports } from '@/analyzer/utils/workspaceBoundary';
import { scanDeadCode } from '@/analyzer/deadcode/DeadCodeScanner';
import {
  ExportArchitectureDiagramParamsSchema,
  createErrorResponse,
  createSuccessResponse,
  QueryNaturalLanguageParamsSchema,
  ReviewPrParamsSchema,
  type ExportArchitectureDiagramParams,
  type GraphContextParams,
  type QueryNaturalLanguageParams,
  type ReviewPrParams,
} from '@/mcp/types';
import { formatToolResponse, type ResponseFormat } from '@/mcp/responseFormatter';
import { LM_RESPONSE_FORMAT_PROPERTY } from '@/mcp/toolDescriptions';
import type { Dependency, SymbolDependency } from '@/analyzer/types';
import { checkSymbolInFile, symbolNotFoundMessage } from '@/analyzer/utils/SymbolLookup';
import { mapWithConcurrency } from '@/shared/concurrency';
import { convertSpiderToLspFormat } from '@/shared/converters';
import { lookupCallGraphSymbol } from '@/analyzer/callgraph/CallGraphSymbolLookup';
import { normalizePath } from '@/shared/path';
import {
  toWorkspaceRelativePath,
  validateWorkspacePath,
} from '@/shared/pathSecurity';
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

type GraphContextInput = GraphContextParams;

interface GetSymbolCallersInput {
  filePath: string;
  symbolName: string;
  includeTypeOnly?: boolean;
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
  symbolId?: string;
  startLine?: number;
  direction?: 'callers' | 'callees' | 'both';
  depth?: number;
  relationTypes?: string[];
}

interface ScanDeadCodeInput {
  scopePath?: string;
  maxFiles?: number;
}

// ─── Service options ──────────────────────────────────────────────────────────

interface LmToolsServiceOptions {
  provider: GraphProvider;
  logger: VsCodeLogger;
  /** Locates the WASM parsers review_pr needs to read import cycles outside JS/TS. */
  extensionPath?: string;
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

const FILE_SCOPE_SUFFIX = ':(file)';

function symbolFilePath(symbolId: string): string {
  const idx = symbolId.lastIndexOf(':');
  return idx > 0 ? symbolId.slice(0, idx) : symbolId;
}

interface LmCallerInfo {
  callerSymbolId: string;
  callerFilePath: string;
  callerRelativePath: string;
  line: number | null;
  isTypeOnly: boolean;
  /** How the caller reaches the symbol: a call, a runtime reference (`<Card />`, `onClick={save}`) or a type use */
  relation: 'CALLS' | 'REFERENCES' | 'USES';
}

/** Which edge of a caller wins: a call over a reference over a type-only use. */
const CALLER_RELATION_RANK: Record<LmCallerInfo['relation'], number> = { CALLS: 0, REFERENCES: 1, USES: 2 };

function dependentRelation(dep: { isTypeOnly?: boolean; relation?: 'REFERENCES' }): LmCallerInfo['relation'] {
  if (dep.isTypeOnly) return 'USES';
  return dep.relation ?? 'CALLS';
}

/** Every LM tool accepts `response_format`; anything else falls back to the TOON default. */
function readResponseFormat(input: unknown): ResponseFormat {
  const value = (input as { response_format?: unknown } | undefined)?.response_format;
  return LM_RESPONSE_FORMAT_PROPERTY.enum.find((format) => format === value) ?? 'toon';
}

const INDEX_PASS_STATES = new Set(['counting', 'indexing', 'validating']);

/** The message of an `errorResult()` payload: an object whose only key is `error`. */
function readErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const entries = Object.entries(payload);
  const [key, value] = entries[0] ?? [];
  return entries.length === 1 && key === 'error' && typeof value === 'string' ? value : undefined;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class LmToolsService {
  private readonly provider: GraphProvider;
  private readonly logger: VsCodeLogger;
  private readonly extensionPath?: string;

  constructor(options: LmToolsServiceOptions) {
    this.provider = options.provider;
    this.logger = options.logger;
    this.extensionPath = options.extensionPath;
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
      this.registerScanDeadCode(),
      this.registerGraphContext(),
      this.registerReviewPr(),
      this.registerQueryNaturalLanguage(),
      this.registerExportArchitectureDiagram(),
    ];
  }

  // ─── Shared helpers ───────────────────────────────────────────────────────

  private errorResult(message: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify({ error: message })),
    ]);
  }

  private registerTool<T>(
    name: string,
    tool: vscode.LanguageModelTool<T>,
  ): vscode.Disposable {
    return vscode.lm.registerTool<T>(name, {
      ...tool,
      invoke: async (options, token) => {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const startedAt = Date.now();
        const result = await tool.invoke(options, token);
        return result
          ? this.encodeToolResult(name, result, readResponseFormat(options.input), startedAt)
          : result;
      },
    });
  }

  /**
   * Redacts every JSON text part, then encodes it like the MCP server does:
   * `json` keeps the redacted payload as is, `toon` and `markdown` go through
   * the shared MCP formatter with the error and freshness envelope.
   */
  private encodeToolResult(
    name: string,
    result: vscode.LanguageModelToolResult,
    format: ResponseFormat,
    startedAt: number,
  ): vscode.LanguageModelToolResult {
    const content: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart
    > = result.content.map((part) => {
      if (!(part instanceof vscode.LanguageModelTextPart)) {
        return part as vscode.LanguageModelPromptTsxPart;
      }
      let payload: unknown;
      try {
        payload = this.redactPublicValue(JSON.parse(part.value) as unknown);
      } catch {
        return part;
      }
      if (format === 'json') return new vscode.LanguageModelTextPart(JSON.stringify(payload));
      const error = readErrorMessage(payload);
      const executionTimeMs = Date.now() - startedAt;
      const workspaceRoot = this.getWorkspaceRoot() ?? '';
      const response = error === undefined
        ? createSuccessResponse(payload, executionTimeMs, workspaceRoot, undefined, this.freshness())
        : createErrorResponse<unknown>(error, executionTimeMs, workspaceRoot);
      const mcpToolName = name.replace('graph-it-live_', 'graphitlive_');
      return new vscode.LanguageModelTextPart(formatToolResponse(response, format, mcpToolName).content[0].text);
    });
    return new vscode.LanguageModelToolResult(content);
  }

  /**
   * `indexedAt` is the end of the last full index pass. The extension re-analyzes
   * each changed file on its own, so results lag only while an index pass or a
   * file change job is still running.
   */
  private freshness(): { indexedAt: string | null; stale: boolean } | undefined {
    const spider = this.provider.getSpiderForLmTools();
    if (!spider) return undefined;
    const { completedAt, state } = spider.getIndexStatus();
    return {
      indexedAt: completedAt === undefined ? null : new Date(completedAt).toISOString(),
      stale: INDEX_PASS_STATES.has(state) || (this.provider.fileChangeScheduler?.getPendingCount() ?? 0) > 0,
    };
  }

  private redactPublicValue(value: unknown): unknown {
    if (typeof value === 'string' && nodePath.isAbsolute(value)) {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const relative = toWorkspaceRelativePath(value, folder.uri.fsPath);
        if (!relative.startsWith('[external:')) return relative;
      }
      return `[external:${nodePath.basename(value)}]`;
    }
    if (Array.isArray(value)) return value.map((item) => this.redactPublicValue(item));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, this.redactPublicValue(child)]),
    );
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private resolveWorkspacePath(inputPath: string): string {
    if (inputPath.length > 1024 || inputPath.includes('\0') || !nodePath.isAbsolute(inputPath)) {
      throw new Error('File path must be an absolute path of at most 1024 characters.');
    }

    const resolvedPath = nodePath.resolve(inputPath);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        validateWorkspacePath(resolvedPath, folder.uri.fsPath);
        return resolvedPath;
      } catch {
        // Try the next root in a multi-root workspace.
      }
    }
    throw new Error('File path must remain inside an open workspace folder.');
  }

  // ─── Tool: find_referencing_files ─────────────────────────────────────────

  private registerFindReferencingFiles(): vscode.Disposable {
    return this.registerTool<FindReferencingFilesInput>(
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
          const targetPath = this.resolveWorkspacePath(options.input.targetPath);
          const rootDir = this.getWorkspaceRoot();
          try {
            const references = await spider.findReferencingFilesThroughBarrels(targetPath);
            const relative = (p: string) => (rootDir ? toRelativePath(p, rootDir) : p);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  targetPath,
                  referencingFileCount: references.length,
                  referencingFiles: references.map((ref) => ({
                    path: ref.path,
                    relativePath: relative(ref.path),
                    type: ref.type,
                    line: ref.line,
                    module: ref.module,
                    ...(ref.via ? { via: relative(ref.via) } : {}),
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
    return this.registerTool<AnalyzeDependenciesInput>(
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
          const filePath = this.resolveWorkspacePath(options.input.filePath);
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
    return this.registerTool<CrawlDependencyGraphInput>(
      'graph-it-live_crawl_dependency_graph',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<CrawlDependencyGraphInput>,
          token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          if (!spider) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          const { maxDepth } = options.input;
          const entryFile = this.resolveWorkspacePath(options.input.entryFile);
          const rootDir = this.getWorkspaceRoot();
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            const graph = await spider.crawl(entryFile, {
              maxDepth,
              signal: controller.signal,
            });
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
            if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
              throw new vscode.CancellationError();
            }
            return this.errorResult(error instanceof Error ? error.message : String(error));
          } finally {
            cancellation.dispose();
          }
        },
      },
    );
  }

  // ─── Tool: get_symbol_graph ───────────────────────────────────────────────

  private registerGetSymbolGraph(): vscode.Disposable {
    return this.registerTool<GetSymbolGraphInput>(
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
          const filePath = this.resolveWorkspacePath(options.input.filePath);
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
    return this.registerTool<FindUnusedSymbolsInput>(
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
          const filePath = this.resolveWorkspacePath(options.input.filePath);
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
    return this.registerTool<GetSymbolCallersInput>(
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
          const { symbolName, includeTypeOnly = false } = options.input;
          const filePath = this.resolveWorkspacePath(options.input.filePath);
          const rootDir = this.getWorkspaceRoot();
          try {
            const fromCallGraph = await this.collectCallersFromCallGraph(filePath, symbolName, includeTypeOnly, rootDir);
            const callers = fromCallGraph
              ?? this.collectCallersFromDependents(await spider.getSymbolDependents(filePath, symbolName), includeTypeOnly, rootDir);
            const typeOnlyCallerCount = callers.filter((c) => c.isTypeOnly).length;
            const referenceCallerCount = callers.filter((c) => c.relation === 'REFERENCES').length;
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  filePath,
                  symbolName,
                  source: fromCallGraph ? 'call-graph' : 'symbol-dependents',
                  callerCount: callers.length,
                  runtimeCallerCount: callers.length - typeOnlyCallerCount,
                  typeOnlyCallerCount,
                  referenceCallerCount,
                  callers,
                  callerFiles: [...new Set(callers.map((c) => c.callerFilePath))],
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

  /**
   * Call sites from the call graph (CALLS and REFERENCES edges; USES only when requested).
   * Returns null when the call graph index is not built — it only exists once the Call Graph panel was opened.
   */
  private async collectCallersFromCallGraph(
    filePath: string,
    symbolName: string,
    includeTypeOnly: boolean,
    rootDir: string | undefined,
  ): Promise<LmCallerInfo[] | null> {
    const indexer = this.provider.getCallGraphViewServiceForLmTools()?.getCallGraphIndexerForLmTools();
    if (!indexer) return null;

    const db = indexer.getDb();
    const symbolRows = db.exec('SELECT id FROM nodes WHERE path = ? AND name = ?', [normalizePath(filePath), symbolName]);
    const symbolId = symbolRows[0]?.values[0]?.[0] as string | undefined;
    if (!symbolId) return [];

    const relations: LmCallerInfo['relation'][] = includeTypeOnly ? ['CALLS', 'REFERENCES', 'USES'] : ['CALLS', 'REFERENCES'];
    const edges = this.callGraphBfs(db, symbolId, 'callers', 1, relations) as Array<{
      relation: LmCallerInfo['relation']; sourceLine: number; sourceName: string; sourceFile: string;
    }>;

    // One entry per caller symbol: its first edge of the strongest relation (call, then reference, then type use).
    const byCaller = new Map<string, LmCallerInfo>();
    for (const edge of edges) {
      const callerSymbolId = `${edge.sourceFile}:${edge.sourceName}`;
      const existing = byCaller.get(callerSymbolId);
      if (existing && CALLER_RELATION_RANK[existing.relation] <= CALLER_RELATION_RANK[edge.relation]) continue;
      byCaller.set(callerSymbolId, {
        callerSymbolId,
        callerFilePath: edge.sourceFile,
        callerRelativePath: rootDir ? toRelativePath(edge.sourceFile, rootDir) : edge.sourceFile,
        line: edge.sourceLine,
        isTypeOnly: edge.relation === 'USES',
        relation: edge.relation,
      });
    }
    return [...byCaller.values()];
  }

  /**
   * Fallback when the call graph is not indexed: symbol-level dependents,
   * without file-level imports and, unless requested, without type-only references.
   * JSX and handler references are labelled REFERENCES; ponytail: other references (e.g. a function passed as a
   * callback argument) count as calls here; exact parity needs the shared index (#173).
   */
  private collectCallersFromDependents(
    dependents: Array<{ sourceSymbolId: string; isTypeOnly?: boolean; relation?: 'REFERENCES' }>,
    includeTypeOnly: boolean,
    rootDir: string | undefined,
  ): LmCallerInfo[] {
    const byCaller = new Map<string, LmCallerInfo>();
    for (const dep of dependents) {
      const isTypeOnly = dep.isTypeOnly === true;
      if (isTypeOnly && !includeTypeOnly) continue;
      const existing = byCaller.get(dep.sourceSymbolId);
      if (existing && (existing.isTypeOnly === false || isTypeOnly)) continue;
      const callerFilePath = symbolFilePath(dep.sourceSymbolId);
      byCaller.set(dep.sourceSymbolId, {
        callerSymbolId: dep.sourceSymbolId,
        callerFilePath,
        callerRelativePath: rootDir ? toRelativePath(callerFilePath, rootDir) : callerFilePath,
        line: null,
        isTypeOnly,
        relation: dependentRelation(dep),
      });
    }
    // Module-level code (`<file>:(file)`) is a real caller (MCP impact keeps it) but adds nothing once a symbol of that file already calls.
    const filesWithSymbolCaller = new Set(
      [...byCaller.values()].filter((c) => !c.callerSymbolId.endsWith(FILE_SCOPE_SUFFIX)).map((c) => normalizePath(c.callerFilePath)),
    );
    return [...byCaller.values()].filter(
      (c) => !c.callerSymbolId.endsWith(FILE_SCOPE_SUFFIX) || !filesWithSymbolCaller.has(normalizePath(c.callerFilePath)),
    );
  }

  // ─── Tool: get_impact_analysis ────────────────────────────────────────────

  private buildImpactItem(
    dep: { sourceSymbolId: string; targetFilePath: string; isTypeOnly?: boolean; relation?: 'REFERENCES' },
    depth: number,
    rootDir: string | undefined,
  ): { symbolId: string; filePath: string; relativePath: string; usageType: 'runtime' | 'type-only'; relation?: 'REFERENCES'; depth: number } {
    // The impacted item is the caller: dep.targetFilePath is the file being changed.
    const callerFilePath = symbolFilePath(dep.sourceSymbolId);
    return {
      symbolId: dep.sourceSymbolId,
      filePath: callerFilePath,
      relativePath: rootDir ? toRelativePath(callerFilePath, rootDir) : callerFilePath,
      usageType: dep.isTypeOnly ? 'type-only' : 'runtime',
      ...(dep.relation && { relation: dep.relation }),
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
    const sourceKey = normalizePath(dep.sourceSymbolId);
    if (visited.has(sourceKey)) return;
    visited.add(sourceKey);
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
    targetSymbolId: string,
  ): Promise<ReturnType<LmToolsService['buildImpactItem']>[]> {
    // The target is seeded so a mutual recursion never lists it as its own impact.
    const visited = new Set<string>([targetSymbolId, ...directDependents.map((d) => d.sourceSymbolId)].map(normalizePath));
    const transitiveItems: ReturnType<LmToolsService['buildImpactItem']>[] = [];
    // Breadth-first, one depth level at a time, results processed in queue order, so `visited` and the
    // item order match a one-by-one walk.
    const walkLevel = async (level: Array<{ symbolId: string; depth: number }>): Promise<void> => {
      const current = level.filter((item) => item.depth <= maxDepth);
      if (current.length === 0) return;
      const results = await mapWithConcurrency(current, 4, (item) => this.symbolDependentsOf(spider, item.symbolId));
      const next: Array<{ symbolId: string; depth: number }> = [];
      results.forEach((deps, i) => {
        for (const dep of deps) {
          this.processTransitiveDep(dep, current[i].depth, maxDepth, visited, rootDir, next, transitiveItems);
        }
      });
      return walkLevel(next);
    };
    await walkLevel(directDependents.map((d) => ({ symbolId: d.sourceSymbolId, depth: 2 })));
    return transitiveItems;
  }

  /** Dependents of a `file:symbol` id; none for a malformed id or a symbol that fails to analyze. */
  private async symbolDependentsOf(
    spider: ReturnType<GraphProvider['getSpiderForLmTools']> & object,
    symbolId: string,
  ): Promise<SymbolDependency[]> {
    const colonIdx = symbolId.lastIndexOf(':');
    if (colonIdx <= 0) return [];
    try {
      return await spider.getSymbolDependents(symbolId.slice(0, colonIdx), symbolId.slice(colonIdx + 1));
    } catch {
      return []; // skip symbols that fail to analyze
    }
  }

  private registerGetImpactAnalysis(): vscode.Disposable {
    return this.registerTool<GetImpactAnalysisInput>(
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
          const { symbolName, includeTransitive = false, maxDepth = 3 } = options.input;
          const filePath = this.resolveWorkspacePath(options.input.filePath);
          const rootDir = this.getWorkspaceRoot();
          try {
            const symbolCheck = await checkSymbolInFile(spider, filePath, symbolName);
            if (symbolCheck.status === 'missing') {
              const fileLabel = rootDir ? toWorkspaceRelativePath(filePath, rootDir) : nodePath.basename(filePath);
              return this.errorResult(symbolNotFoundMessage(symbolName, fileLabel, symbolCheck.suggestions));
            }
            const directDependents = await spider.getSymbolDependents(filePath, symbolName);
            const impactedItems = directDependents.map((dep) => this.buildImpactItem(dep, 1, rootDir));

            if (includeTransitive && maxDepth > 1) {
              const transitiveItems = await this.collectTransitiveDependents(
                directDependents, spider, maxDepth, rootDir, `${filePath}:${symbolName}`,
              );
              impactedItems.push(...transitiveItems);
            }

            const runtimeCount = impactedItems.filter((i) => i.usageType === 'runtime').length;
            const affectedFiles = new Set(impactedItems.map((i) => i.filePath));

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
                  affectedFiles: [...affectedFiles],
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
    return this.registerTool<Record<string, never>>(
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
                  ...reportOutOfRootImports(spider.getOutOfRootImports(), spider.workspaceRoot),
                  cacheFiles: IndexCache.fileSizes(IndexCache.dirFor(spider.workspaceRoot)),
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
    return this.registerTool<ParseImportsInput>(
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
          const filePath = this.resolveWorkspacePath(options.input.filePath);
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
    return this.registerTool<GenerateCodemapInput>(
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
          const filePath = this.resolveWorkspacePath(options.input.filePath);
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
    return this.registerTool<ExpandNodeInput>(
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
          const filePath = this.resolveWorkspacePath(options.input.filePath);
          const knownPaths = (options.input.knownPaths ?? []).map((knownPath) =>
            this.resolveWorkspacePath(knownPath),
          );
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
    return this.registerTool<VerifyDependencyUsageInput>(
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
          const sourceFile = this.resolveWorkspacePath(options.input.sourceFile);
          const targetFile = this.resolveWorkspacePath(options.input.targetFile);
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
    return this.registerTool<InvalidateFilesInput>(
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
          if (options.input.filePaths.length > 10_000) {
            return this.errorResult('At most 10000 files can be invalidated per invocation.');
          }
          const filePaths = options.input.filePaths.map((filePath) =>
            this.resolveWorkspacePath(filePath),
          );
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
    return this.registerTool<Record<string, never>>(
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
    return this.registerTool<GetSymbolDependentsInput>(
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
          const { symbolName } = options.input;
          const filePath = this.resolveWorkspacePath(options.input.filePath);
          const rootDir = this.getWorkspaceRoot();
          try {
            const dependents = await spider.getSymbolDependents(filePath, symbolName);
            const symbolId = `${filePath}:${symbolName}`;
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(
                JSON.stringify({
                  symbolId,
                  dependentCount: dependents.length,
                  // The dependent is the edge source; target* fields are the queried symbol.
                  dependents: dependents.map((d) => {
                    const dependentFilePath = symbolFilePath(d.sourceSymbolId);
                    return {
                      symbolId: d.sourceSymbolId,
                      filePath: dependentFilePath,
                      relativePath: rootDir ? toRelativePath(dependentFilePath, rootDir) : dependentFilePath,
                    };
                  }),
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
    return this.registerTool<TraceFunctionExecutionInput>(
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
          const { symbolName, maxDepth = 10 } = options.input;
          const filePath = this.resolveWorkspacePath(options.input.filePath);
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
                    ...(entry.line !== undefined && { line: entry.line }),
                    ...(entry.relation && { relation: entry.relation }),
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
    return this.registerTool<AnalyzeFileLogicInput>(
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
          const filePath = this.resolveWorkspacePath(options.input.filePath);
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
    return this.registerTool<ResolveModulePathInput>(
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
          const { moduleSpecifier } = options.input;
          const fromFile = this.resolveWorkspacePath(options.input.fromFile);
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
    return this.registerTool<AnalyzeBreakingChangesInput>(
      'graph-it-live_analyze_breaking_changes',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<AnalyzeBreakingChangesInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const { oldContent, symbolName, newContent: inputNewContent } = options.input;
          const filePath = this.resolveWorkspacePath(options.input.filePath);
          // Only an omitted newContent falls back to the file on disk: "" means the file was emptied.
          let newContent = inputNewContent;
          if (newContent === undefined) {
            try {
              newContent = await fs.readFile(filePath, 'utf-8');
            } catch {
              return this.errorResult(`Cannot read current file: ${filePath}`);
            }
          }
          try {
            const { SignatureAnalyzer } = await import('../../analyzer/SignatureAnalyzer.js');
            const analyzer = new SignatureAnalyzer();
            const results = analyzer.analyzeBreakingChanges(filePath, oldContent, newContent, symbolName);
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

  private registerGraphContext(): vscode.Disposable {
    return this.registerTool<GraphContextInput>(
      'graph-it-live_graph_context',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<GraphContextInput>,
          token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          const callGraphService = this.provider.getCallGraphViewServiceForLmTools();
          const indexer = callGraphService?.getCallGraphIndexerForLmTools();
          const rootDir = this.getWorkspaceRoot();
          if (!spider || !indexer || !rootDir) {
            return this.errorResult('No workspace or graph index is available.');
          }
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            const { executeGraphContextWithIndexes } = await import('../../mcp/tools/graphContext.js');
            const { projectGraphContextOutput } = await import('../../shared/graph-context-output.js');
            const response = await executeGraphContextWithIndexes(options.input, {
              rootDir,
              spider,
              callGraphIndexer: indexer,
            }, controller.signal);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify(projectGraphContextOutput(response, options.input.detail))),
            ]);
          } catch (error) {
            if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
              throw new vscode.CancellationError();
            }
            return this.errorResult(error instanceof Error ? error.message : String(error));
          } finally {
            cancellation.dispose();
          }
        },
      },
    );
  }

  // ─── Tool: query_call_graph ────────────────────────────────────────────────

  private registerQueryCallGraph(): vscode.Disposable {
    return this.registerTool<QueryCallGraphInput>(
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
          const { direction = 'both', depth = 2, relationTypes } = options.input;
          const filePath = this.resolveWorkspacePath(options.input.filePath);
          try {
            const db = indexer.getDb();
            const lookup = lookupCallGraphSymbol(db, { ...options.input, filePath });
            if (lookup.symbol === null) {
              return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                  JSON.stringify({
                    symbol: null, reason: lookup.reason, candidates: lookup.candidates,
                    callers: [], callees: [], totalCallers: 0, totalCallees: 0, depth, direction,
                  }),
                ),
              ]);
            }
            const { symbol } = lookup;
            const symbolId = symbol.id;
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

  // ─── Tool: scan_dead_code ─────────────────────────────────────────────────

  private registerScanDeadCode(): vscode.Disposable {
    return this.registerTool<ScanDeadCodeInput>(
      'graph-it-live_scan_dead_code',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<ScanDeadCodeInput>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const { maxFiles } = options.input;
          const scopePath = options.input.scopePath
            ? this.resolveWorkspacePath(options.input.scopePath)
            : undefined;
          const spider = this.provider.getSpiderForLmTools();
          const rootDir = this.getWorkspaceRoot();
          if (!spider || !rootDir) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          try {
            const result = await scanDeadCode(spider, rootDir, { scopePath, maxFiles });
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify(result)),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: review_pr ──────────────────────────────────────────────────────

  private registerExportArchitectureDiagram(): vscode.Disposable {
    return this.registerTool<ExportArchitectureDiagramParams>(
      'graph-it-live_export_architecture_diagram',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<ExportArchitectureDiagramParams>,
          token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          const rootDir = this.getWorkspaceRoot();
          if (!spider || !rootDir) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          // Every source file is analysed: let the chat cancel it.
          const abort = new AbortController();
          const cancellation = token.onCancellationRequested(() => abort.abort());
          try {
            const params = ExportArchitectureDiagramParamsSchema.parse(options.input);
            const { exportArchitectureDiagram } = await import('../../mcp/tools/architecture.js');
            const result = await exportArchitectureDiagram(rootDir, (filePath) => spider.analyze(filePath), params, abort.signal);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify(result)),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          } finally {
            cancellation.dispose();
          }
        },
      },
    );
  }

  private registerReviewPr(): vscode.Disposable {
    return this.registerTool<ReviewPrParams>(
      'graph-it-live_review_pr',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<ReviewPrParams>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const spider = this.provider.getSpiderForLmTools();
          const rootDir = this.getWorkspaceRoot();
          if (!spider || !rootDir) {
            return this.errorResult('No workspace open or dependency index not initialized.');
          }
          try {
            const params = ReviewPrParamsSchema.parse(options.input);
            const { createSpiderDependentsProvider } = await import('../../mcp/tools/impact.js');
            const result = await new ReviewGateAnalyzer(rootDir, createSpiderDependentsProvider(spider, rootDir, this.extensionPath)).analyze(params);
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify(result)),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }

  // ─── Tool: query_natural_language ─────────────────────────────────────────

  private registerQueryNaturalLanguage(): vscode.Disposable {
    return this.registerTool<QueryNaturalLanguageParams>(
      'graph-it-live_query_natural_language',
      {
        invoke: async (
          options: vscode.LanguageModelToolInvocationOptions<QueryNaturalLanguageParams>,
          _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> => {
          const indexer = this.provider.getCallGraphViewServiceForLmTools()?.getCallGraphIndexerForLmTools();
          const rootDir = this.getWorkspaceRoot();
          if (!indexer || !rootDir) {
            return this.errorResult(
              'Call graph index not available. Open the Call Graph panel (graph-it-live.showCallGraph) first to build the index.',
            );
          }
          try {
            const params = QueryNaturalLanguageParamsSchema.parse(options.input);
            const { queryNaturalLanguageWithDb } = await import('../../mcp/tools/query.js');
            // No LLM client: the calling model writes the answer from the subgraph.
            // TOON output carries the subgraph pre-encoded; markdown and json need its nodes and edges.
            const outputFormat = readResponseFormat(options.input) === 'toon' ? 'toon' : 'json';
            const result = await queryNaturalLanguageWithDb(indexer.getDb(), rootDir, { ...params, outputFormat });
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(JSON.stringify(result)),
            ]);
          } catch (error) {
            return this.errorResult(error instanceof Error ? error.message : String(error));
          }
        },
      },
    );
  }
}
