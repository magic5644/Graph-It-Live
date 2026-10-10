import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GraphProvider } from '../../../src/extension/GraphProvider';
import type { VsCodeLogger } from '../../../src/extension/extensionLogger';
import { LmToolsService } from '../../../src/extension/services/LmToolsService';

// ─── Shared mock state (vi.hoisted ensures it's accessible inside vi.mock factories) ──

const { registeredTools, registerToolFn } = vi.hoisted(() => {
  const registeredTools = new Map<string, { invoke: (...args: unknown[]) => Promise<unknown> }>();
  const registerToolFn = vi.fn(
    (name: string, handler: { invoke: (...args: unknown[]) => Promise<unknown> }) => {
      registeredTools.set(name, handler);
      return { dispose: vi.fn() };
    },
  );
  return { registeredTools, registerToolFn };
});

const executeGraphContextWithIndexes = vi.hoisted(() => vi.fn());
const { reviewAnalyze, reviewGateCtor, queryEngineQuery, queryEngineCtor } = vi.hoisted(() => ({
  reviewAnalyze: vi.fn(),
  reviewGateCtor: vi.fn(),
  queryEngineQuery: vi.fn(),
  queryEngineCtor: vi.fn(),
}));

// ─── vscode mock ──────────────────────────────────────────────────────────────

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(public readonly value: string) {}
  }

  class LanguageModelToolResult {
    constructor(public readonly content: LanguageModelTextPart[]) {}
    get parts(): LanguageModelTextPart[] {
      return this.content;
    }
  }

  class CancellationError extends Error {}

  return {
    lm: {
      registerTool: registerToolFn,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    },
    LanguageModelTextPart,
    LanguageModelToolResult,
    CancellationError,
  };
});

// ─── Dynamic-import mocks ─────────────────────────────────────────────────────

vi.mock('@/analyzer/SignatureAnalyzer', () => ({
  SignatureAnalyzer: class {
    analyzeBreakingChanges(_file: string, _old: string, _new: string, symbolName?: string) {
      if (symbolName && symbolName !== 'myFn') {
        throw new Error(`Symbol '${symbolName}' not found in oldContent or newContent.`);
      }
      return [
        {
          symbolName: 'myFn',
          breakingChanges: [{ type: 'parameter_added', description: 'param x added' }],
          nonBreakingChanges: [{ type: 'doc_comment', description: 'updated JSDoc' }],
        },
      ];
    }
  },
}));

vi.mock('@/analyzer/ReviewGateAnalyzer', () => ({
  ReviewGateAnalyzer: class {
    constructor(...args: unknown[]) {
      reviewGateCtor(...args);
    }
    analyze(params: unknown) {
      return reviewAnalyze(params);
    }
  },
}));

vi.mock('@/analyzer/QueryEngine', () => ({
  QueryEngine: class {
    constructor(...args: unknown[]) {
      queryEngineCtor(...args);
    }
    query(request: unknown) {
      return queryEngineQuery(request);
    }
  },
}));

vi.mock('@/shared/path', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/shared/path')>(),
  normalizePath: (p: string) => p.replaceAll('\\', '/'),
  normalizePathForComparison: (p: string) => p.replaceAll('\\', '/').replace(/\/$/u, ''),
}));

vi.mock('../../../src/mcp/tools/graphContext.js', () => ({ executeGraphContextWithIndexes }));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

import * as fsPromises from 'node:fs/promises';
import * as vscode from 'vscode';

function createLogger(): VsCodeLogger {
  return {
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    setLevel: vi.fn(),
    level: 'info',
    show: vi.fn(),
  } as unknown as VsCodeLogger;
}

function createProvider(overrides: Partial<{
  spider: unknown;
  callGraphService: unknown;
}> = {}): GraphProvider {
  const spider = overrides.spider ?? {
    resolveModuleSpecifier: vi.fn().mockResolvedValue(null),
    findReferencingFiles: vi.fn().mockResolvedValue([]),
    analyzeFileDependencies: vi.fn().mockResolvedValue({ imports: [], exports: [], language: 'typescript' }),
    crawlDependencyGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    getSymbolGraph: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
    findUnusedSymbols: vi.fn().mockResolvedValue([]),
    getSymbolCallers: vi.fn().mockResolvedValue([]),
    getImpactAnalysis: vi.fn().mockResolvedValue([]),
    getIndexStatus: vi.fn().mockResolvedValue({ totalFiles: 0, indexedFiles: 0 }),
    parseImports: vi.fn().mockResolvedValue({ imports: [] }),
    generateCodemap: vi.fn().mockResolvedValue(''),
    verifyDependencyUsage: vi.fn().mockResolvedValue(false),
    invalidateFile: vi.fn().mockReturnValue(false),
    clearCache: vi.fn(),
    buildFullIndex: vi.fn().mockResolvedValue(undefined),
    getCacheStatsAsync: vi.fn().mockResolvedValue({ dependencyCache: { size: 0 } }),
    getSymbolDependents: vi.fn().mockResolvedValue([]),
    traceFunctionExecution: vi.fn().mockResolvedValue({ rootSymbol: { id: '', filePath: '', symbolName: '' }, callChain: [], visitedSymbols: [], maxDepthReached: false }),
  };

  return {
    getSpiderForLmTools: vi.fn().mockReturnValue(spider),
    getCallGraphViewServiceForLmTools: vi.fn().mockReturnValue(overrides.callGraphService ?? null),
  } as unknown as GraphProvider;
}

function makeOptions<T>(input: T): vscode.LanguageModelToolInvocationOptions<T> {
  return { input } as vscode.LanguageModelToolInvocationOptions<T>;
}

const fakeToken = {
  isCancellationRequested: false,
  onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
} as unknown as vscode.CancellationToken;

function parseResult(result: unknown): unknown {
  const parts = (result as { parts: { value: string }[] }).parts;
  return JSON.parse(parts[0].value);
}

async function invokeTool<T>(name: string, input: T): Promise<unknown> {
  const handler = registeredTools.get(name);
  if (!handler) throw new Error(`Tool "${name}" not registered`);
  return parseResult(await handler.invoke(makeOptions(input), fakeToken));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LmToolsService', () => {
  let logger: VsCodeLogger;

  beforeEach(() => {
    logger = createLogger();
    registeredTools.clear();
    registerToolFn.mockClear();
    executeGraphContextWithIndexes.mockReset();
    vi.mocked(fsPromises.readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
  });

  // ─── registerAll ──────────────────────────────────────────────────────────

  describe('registerAll', () => {
    it('registers 24 tools and returns 24 disposables', () => {
      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      const disposables = service.registerAll();

      expect(disposables).toHaveLength(24);
      expect(registerToolFn).toHaveBeenCalledTimes(24);
    });

    it('returns empty array when vscode.lm.registerTool is unavailable', () => {
      // Remove registerTool from the lm namespace
      const origRegisterTool = (vscode.lm as Record<string, unknown>).registerTool;
      delete (vscode.lm as Record<string, unknown>).registerTool;

      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      const disposables = service.registerAll();

      expect(disposables).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not available'));

      // Restore
      (vscode.lm as Record<string, unknown>).registerTool = origRegisterTool;
    });

    it.each([
      'graph-it-live_resolve_module_path',
      'graph-it-live_analyze_breaking_changes',
      'graph-it-live_query_call_graph',
      'graph-it-live_scan_dead_code',
      'graph-it-live_graph_context',
      'graph-it-live_review_pr',
      'graph-it-live_query_natural_language',
    ])('registers %s', (toolName) => {
      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      service.registerAll();
      expect(registeredTools.has(toolName)).toBe(true);
    });

    it('rejects a pre-cancelled invocation before running the tool', async () => {
      const provider = createProvider();
      new LmToolsService({ provider, logger }).registerAll();
      const handler = registeredTools.get('graph-it-live_get_index_status');
      const cancelledToken = {
        isCancellationRequested: true,
        onCancellationRequested: vi.fn(),
      } as unknown as vscode.CancellationToken;

      await expect(handler?.invoke(makeOptions({}), cancelledToken)).rejects.toBeInstanceOf(
        vscode.CancellationError,
      );
    });
  });

  // Regression test for #264: the VS Code index status reports what a narrow folder leaves out.
  it('reports out-of-root imports in get_index_status', async () => {
    const spider = {
      getIndexStatus: vi.fn().mockReturnValue({ state: 'complete' }),
      getCacheStatsAsync: vi.fn().mockResolvedValue({ dependencyCache: { size: 0 } }),
      hasReverseIndex: vi.fn().mockReturnValue(true),
      getOutOfRootImports: vi.fn().mockReturnValue({ count: 2, examples: ['@core/x', '../../core/y'] }),
      workspaceRoot: '/no-such-dir/graph-it-264/apps/worker',
    };
    new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

    const result = await invokeTool('graph-it-live_get_index_status', {});

    expect(result).toMatchObject({
      state: 'complete',
      outOfRootImports: 2,
      outOfRootImportExamples: ['@core/x', '../../core/y'],
    });
    expect((result as { warning: string }).warning).toContain('2 imports resolve outside the workspace root');
  });

  it('reports the on-disk size of the shared cache files in get_index_status', async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'graph-it-lm-cache-'));
    try {
      const cacheDir = path.join(workspaceRoot, '.graph-it', 'cache');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(path.join(cacheDir, 'callgraph.db'), new Uint8Array(3));
      const spider = {
        getIndexStatus: vi.fn().mockReturnValue({ state: 'complete' }),
        getCacheStatsAsync: vi.fn().mockResolvedValue({ dependencyCache: { size: 0 } }),
        hasReverseIndex: vi.fn().mockReturnValue(true),
        getOutOfRootImports: vi.fn().mockReturnValue({ count: 0, examples: [] }),
        workspaceRoot,
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_get_index_status', {});

      expect(result).toMatchObject({ cacheFiles: { reverseIndexBytes: 0, callGraphBytes: 3 } });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports out-of-root imports as unknown when the reverse index is off', async () => {
    const spider = {
      getIndexStatus: vi.fn().mockReturnValue({ state: 'idle' }),
      getCacheStatsAsync: vi.fn().mockResolvedValue({ dependencyCache: { size: 0 } }),
      hasReverseIndex: vi.fn().mockReturnValue(false),
      getOutOfRootImports: vi.fn().mockReturnValue(null),
      workspaceRoot: '/no-such-dir/graph-it-264',
    };
    new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

    const result = await invokeTool('graph-it-live_get_index_status', {});

    expect(result).not.toHaveProperty('outOfRootImports');
    expect((result as { warning: string }).warning).toContain('enableBackgroundIndexing');
  });

  it('registers graph context against the live graph index', async () => {
    executeGraphContextWithIndexes.mockResolvedValueOnce({ mode: 'search', nodes: [], edges: [] });
    const spider = createProvider().getSpiderForLmTools();
    const callGraphService = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue({ getDb: vi.fn() }) };
    const provider = createProvider({ spider, callGraphService });
    new LmToolsService({ provider, logger }).registerAll();
    const result = await invokeTool('graph-it-live_graph_context', { question: 'where is auth?' });
    expect(result).toEqual({ mode: 'search', nodes: [], edges: [] });
    expect(executeGraphContextWithIndexes).toHaveBeenCalledWith(
      { question: 'where is auth?' },
      expect.objectContaining({ rootDir: '/workspace', spider }),
      expect.any(AbortSignal),
    );
  });

  it('cancels graph context while retrieval is running', async () => {
    let cancel: (() => void) | undefined;
    const dispose = vi.fn();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn((listener: () => void) => {
        cancel = listener;
        return { dispose };
      }),
    } as unknown as vscode.CancellationToken;
    executeGraphContextWithIndexes.mockImplementationOnce(
      (_input, _indexes, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        }, { once: true });
      }),
    );
    const callGraphService = {
      getCallGraphIndexerForLmTools: vi.fn().mockReturnValue({ getDb: vi.fn() }),
    };
    new LmToolsService({
      provider: createProvider({ callGraphService }),
      logger,
    }).registerAll();
    const handler = registeredTools.get('graph-it-live_graph_context');

    const invocation = handler?.invoke(makeOptions({ question: 'where is auth?' }), token);
    await vi.waitFor(() => expect(executeGraphContextWithIndexes).toHaveBeenCalled());
    cancel?.();

    await expect(invocation).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('advertises the full graph context request schema', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as {
      contributes: {
        languageModelTools: Array<{
          name: string;
          inputSchema: {
            properties: Record<string, {
              type: string;
              items?: { properties?: Record<string, unknown> };
              properties?: Record<string, unknown>;
            }>;
          };
        }>;
      };
    };
    const tool = manifest.contributes.languageModelTools.find(
      ({ name }) => name === 'graph-it-live_graph_context',
    );

    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
      'question',
      'seeds',
      'mode',
      'from',
      'to',
      'relations',
      'scope',
      'depth',
      'maxNodes',
      'tokenBudget',
      'directed',
      'cursor',
      'format',
    ]));
    expect(tool?.inputSchema.properties.seeds.items?.properties).toMatchObject({
      id: { type: 'string' },
      filePath: { type: 'string' },
      symbolName: { type: 'string' },
      label: { type: 'string' },
    });
    expect(tool?.inputSchema.properties.from.properties).toEqual(
      tool?.inputSchema.properties.seeds.items?.properties,
    );
    expect(tool?.inputSchema.properties.to.properties).toEqual(
      tool?.inputSchema.properties.seeds.items?.properties,
    );
  });

  // ─── review_pr ────────────────────────────────────────────────────────────

  describe('review_pr', () => {
    const TOOL = 'graph-it-live_review_pr';

    beforeEach(() => {
      reviewAnalyze.mockReset();
      reviewGateCtor.mockReset();
    });

    it('reviews the diff against the workspace root and the live spider', async () => {
      reviewAnalyze.mockResolvedValueOnce({ baseRef: 'main', risk: 'low', score: 0, changedFiles: ['/workspace/src/a.ts'] });
      const provider = createProvider();
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, { baseRef: 'main', maxFiles: 10 });

      expect(reviewGateCtor).toHaveBeenCalledWith('/workspace', provider.getSpiderForLmTools());
      expect(reviewAnalyze).toHaveBeenCalledWith({ baseRef: 'main', maxFiles: 10 });
      expect(result).toEqual({ baseRef: 'main', risk: 'low', score: 0, changedFiles: ['src/a.ts'] });
    });

    it('rejects input that fails the MCP schema without running git', async () => {
      new LmToolsService({ provider: createProvider(), logger }).registerAll();

      const result = await invokeTool(TOOL, { baseRef: 'main', maxDepth: 99 }) as { error: string };

      expect(result.error).toContain('maxDepth');
      expect(reviewAnalyze).not.toHaveBeenCalled();
    });

    it('returns an error when the dependency index is not ready', async () => {
      const provider = createProvider();
      vi.mocked(provider.getSpiderForLmTools).mockReturnValue(undefined);
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, { baseRef: 'main' }) as { error: string };

      expect(result.error).toContain('not initialized');
    });

    it('returns the analyzer error as a tool error', async () => {
      reviewAnalyze.mockRejectedValueOnce(new Error('baseRef must be a Git ref that does not start with "-"'));
      new LmToolsService({ provider: createProvider(), logger }).registerAll();

      const result = await invokeTool(TOOL, { baseRef: '--output=x' }) as { error: string };

      expect(result.error).toContain('baseRef');
    });
  });

  // ─── query_natural_language ───────────────────────────────────────────────

  describe('query_natural_language', () => {
    const TOOL = 'graph-it-live_query_natural_language';
    const db = { exec: vi.fn() };
    const callGraphService = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue({ getDb: () => db }) };

    beforeEach(() => {
      queryEngineQuery.mockReset();
      queryEngineCtor.mockReset();
    });

    it('queries the live call graph without an LLM client and returns JSON', async () => {
      queryEngineQuery.mockResolvedValueOnce({
        question: 'where is auth?', extractedKeywords: ['auth'], nodeCount: 1, edgeCount: 0,
        nodes: [{ id: 'n1', name: 'login', type: 'function', path: '/workspace/src/auth.ts' }],
        edges: [], meta: { truncated: false }, json: 'unused',
      });
      new LmToolsService({ provider: createProvider({ callGraphService }), logger }).registerAll();

      const result = await invokeTool(TOOL, { question: 'where is auth?', fileFilter: 'src/**' });

      expect(queryEngineCtor).toHaveBeenCalledWith(db, null);
      expect(queryEngineQuery).toHaveBeenCalledWith({
        question: 'where is auth?', workspaceRoot: '/workspace', depth: 2, tokenBudget: 4000,
        fileFilter: 'src/**', outputFormat: 'json',
      });
      expect(result).toEqual({
        question: 'where is auth?', extractedKeywords: ['auth'], nodeCount: 1, edgeCount: 0,
        nodes: [{ id: 'n1', name: 'login', type: 'function', path: 'src/auth.ts' }],
        edges: [], meta: { truncated: false },
      });
    });

    it('rejects an out-of-range depth', async () => {
      new LmToolsService({ provider: createProvider({ callGraphService }), logger }).registerAll();

      const result = await invokeTool(TOOL, { question: 'auth', depth: 50 }) as { error: string };

      expect(result.error).toContain('depth');
      expect(queryEngineQuery).not.toHaveBeenCalled();
    });

    it('returns an error until the call graph index exists', async () => {
      new LmToolsService({ provider: createProvider(), logger }).registerAll();

      const result = await invokeTool(TOOL, { question: 'auth' }) as { error: string };

      expect(result.error).toContain('Call graph index not available');
    });

    it('returns the query error as a tool error', async () => {
      queryEngineQuery.mockRejectedValueOnce(new Error('no such table: nodes_fts'));
      new LmToolsService({ provider: createProvider({ callGraphService }), logger }).registerAll();

      const result = await invokeTool(TOOL, { question: 'auth' }) as { error: string };

      expect(result.error).toBe('no such table: nodes_fts');
    });
  });

  // ─── resolve_module_path ──────────────────────────────────────────────────

  describe('resolve_module_path', () => {
    const TOOL = 'graph-it-live_resolve_module_path';

    beforeEach(() => {
      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      service.registerAll();
    });

    it('returns error when spider is unavailable', async () => {
      // Re-register with no-spider provider
      registeredTools.clear();
      const provider = createProvider();
      (provider.getSpiderForLmTools as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, { fromFile: '/workspace/src/a.ts', moduleSpecifier: './b' });
      expect(result).toMatchObject({ error: expect.stringContaining('No workspace') });
    });

    it('returns resolved: false when specifier does not resolve', async () => {
      registeredTools.clear();
      const spider = { resolveModuleSpecifier: vi.fn().mockResolvedValue(null) };
      const provider = createProvider({ spider });
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, {
        fromFile: '/workspace/src/a.ts',
        moduleSpecifier: './nonexistent',
      }) as Record<string, unknown>;

      expect(result.resolved).toBe(false);
      expect(result.resolvedPath).toBeNull();
      expect(result.resolvedRelativePath).toBeNull();
    });

    it('rejects a source path outside every open workspace', async () => {
      const handler = registeredTools.get(TOOL);
      expect(handler).toBeDefined();

      await expect(handler?.invoke(
        makeOptions({ fromFile: '/private/secret.ts', moduleSpecifier: './b' }),
        fakeToken,
      )).rejects.toThrow('inside an open workspace');
    });

    it('returns resolved: true with relative path when specifier resolves', async () => {
      registeredTools.clear();
      const spider = {
        resolveModuleSpecifier: vi.fn().mockResolvedValue('/workspace/src/b.ts'),
      };
      const provider = createProvider({ spider });
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, {
        fromFile: '/workspace/src/a.ts',
        moduleSpecifier: './b',
      }) as Record<string, unknown>;

      expect(result.resolved).toBe(true);
      expect(result.resolvedPath).toBe('src/b.ts');
      expect(result.resolvedRelativePath).toBe('src/b.ts');
    });

    it('returns error when spider throws', async () => {
      registeredTools.clear();
      const spider = {
        resolveModuleSpecifier: vi.fn().mockRejectedValue(new Error('parse error')),
      };
      const provider = createProvider({ spider });
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, {
        fromFile: '/workspace/src/a.ts',
        moduleSpecifier: './b',
      }) as Record<string, unknown>;

      expect(result).toMatchObject({ error: 'parse error' });
    });
  });

  // ─── analyze_breaking_changes ─────────────────────────────────────────────

  describe('analyze_breaking_changes', () => {
    const TOOL = 'graph-it-live_analyze_breaking_changes';

    beforeEach(() => {
      const provider = createProvider();
      new LmToolsService({ provider, logger }).registerAll();
    });

    it('returns breaking changes when both oldContent and newContent provided', async () => {
      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        oldContent: 'export function myFn() {}',
        newContent: 'export function myFn(x: string) {}',
      }) as Record<string, unknown>;

      expect(result.hasBreakingChanges).toBe(true);
      expect(result.breakingChangesCount).toBe(1);
      expect(result.breakingChanges).toHaveLength(1);
      expect(result.nonBreakingChanges).toHaveLength(1);
    });

    it('passes symbolName to the analyzer and surfaces an unknown symbol as an error', async () => {
      // The mock returns results for 'myFn' only
      const resultMatching = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        oldContent: 'export function myFn() {}',
        newContent: 'export function myFn(x: string) {}',
        symbolName: 'myFn',
      }) as Record<string, unknown>;

      expect(resultMatching.symbolName).toBe('myFn');
      expect(resultMatching.breakingChangesCount).toBe(1);

      const resultNonMatching = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        oldContent: 'export function other() {}',
        newContent: 'export function other(x: string) {}',
        symbolName: 'other',
      }) as Record<string, unknown>;

      // An unknown symbol is an error, never an empty "safe" result (#260)
      expect(resultNonMatching).toMatchObject({ error: expect.stringContaining("Symbol 'other' not found") });
    });

    it('returns error when newContent is missing and file cannot be read', async () => {
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('File not found'));

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/missing.ts',
        oldContent: 'export function myFn() {}',
      }) as Record<string, unknown>;

      expect(result).toMatchObject({ error: expect.stringContaining('Cannot read current file') });
    });

    it('analyzes an empty newContent instead of reading the file on disk (#223)', async () => {
      vi.mocked(fsPromises.readFile).mockClear();

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        oldContent: 'export function myFn() {}',
        newContent: '',
      }) as Record<string, unknown>;

      expect(result).not.toHaveProperty('error');
      expect(fsPromises.readFile).not.toHaveBeenCalled();
    });

    it('reads current file content when newContent is not provided', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue(
        'export function myFn(x: string) {}' as unknown as Awaited<ReturnType<typeof fsPromises.readFile>>,
      );

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        oldContent: 'export function myFn() {}',
      }) as Record<string, unknown>;

      expect(result.hasBreakingChanges).toBe(true);
      expect(fsPromises.readFile).toHaveBeenCalledWith(
        path.resolve('/workspace/src/a.ts'),
        'utf-8',
      );
    });
  });

  // ─── query_call_graph ─────────────────────────────────────────────────────

  // LM tool results are redacted to workspace-relative paths before reaching the model.
  describe('get_symbol_callers', () => {
    const TOOL = 'graph-it-live_get_symbol_callers';
    const edgeRow = (relation: string, line: number, name: string, file: string) =>
      ['src', 'sym1', relation, 0, line, name, file, 'helper', '/workspace/src/a.ts'];

    function callGraphService(callerRows: unknown[][]) {
      const exec = vi.fn()
        .mockReturnValueOnce([{ values: [['sym1']] }])
        .mockReturnValueOnce([{ values: callerRows }]);
      return {
        exec,
        service: { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue({ getDb: () => ({ exec }) }) },
      };
    }

    it('returns one runtime entry per caller symbol from CALLS edges when the call graph is indexed', async () => {
      const { exec, service } = callGraphService([
        edgeRow('CALLS', 12, 'runB', '/workspace/src/b.ts'),
        edgeRow('CALLS', 30, 'runB', '/workspace/src/b.ts'),
        edgeRow('CALLS', 4, 'runC', '/workspace/src/c.ts'),
      ]);
      const spider = { getSymbolDependents: vi.fn() };
      new LmToolsService({ provider: createProvider({ spider, callGraphService: service }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper' }) as Record<string, unknown>;

      expect(exec.mock.calls[1][1]).toEqual(['sym1', 'CALLS']);
      expect(spider.getSymbolDependents).not.toHaveBeenCalled();
      expect(result).toMatchObject({ source: 'call-graph', callerCount: 2, runtimeCallerCount: 2, typeOnlyCallerCount: 0 });
      expect(result.callers).toEqual([
        { callerSymbolId: 'src/b.ts:runB', callerFilePath: 'src/b.ts', callerRelativePath: 'src/b.ts', line: 12, isTypeOnly: false },
        { callerSymbolId: 'src/c.ts:runC', callerFilePath: 'src/c.ts', callerRelativePath: 'src/c.ts', line: 4, isTypeOnly: false },
      ]);
      expect(result.callerFiles).toEqual(['src/b.ts', 'src/c.ts']);
    });

    it('adds USES edges as type-only only when includeTypeOnly is set', async () => {
      const { exec, service } = callGraphService([
        edgeRow('USES', 2, 'runB', '/workspace/src/b.ts'),
        edgeRow('CALLS', 9, 'runB', '/workspace/src/b.ts'),
        edgeRow('USES', 3, 'Shape', '/workspace/src/types.ts'),
      ]);
      new LmToolsService({ provider: createProvider({ callGraphService: service }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper', includeTypeOnly: true }) as Record<string, unknown>;

      expect(exec.mock.calls[1][1]).toEqual(['sym1', 'CALLS', 'USES']);
      expect((result.callers as Array<Record<string, unknown>>).map((c) => [c.callerSymbolId, c.line, c.isTypeOnly])).toEqual([
        ['src/b.ts:runB', 9, false],
        ['src/types.ts:Shape', 3, true],
      ]);
      expect(result).toMatchObject({ runtimeCallerCount: 1, typeOnlyCallerCount: 1 });
    });

    it('returns no callers when the symbol is not in the call graph', async () => {
      const exec = vi.fn().mockReturnValue([]);
      const service = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue({ getDb: () => ({ exec }) }) };
      new LmToolsService({ provider: createProvider({ callGraphService: service }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper' }) as Record<string, unknown>;

      expect(result).toMatchObject({ source: 'call-graph', callerCount: 0, callers: [], callerFiles: [] });
    });

    it('falls back to symbol dependents without file-level or type-only entries', async () => {
      const spider = {
        getSymbolDependents: vi.fn().mockResolvedValue([
          { sourceSymbolId: '/workspace/src/b.ts:runB', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts' },
          { sourceSymbolId: '/workspace/src/b.ts:runB', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts' },
          { sourceSymbolId: '/workspace/tests/a.test.ts:(file)', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts' },
          { sourceSymbolId: '/workspace/src/types.ts:Shape', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts', isTypeOnly: true },
        ]),
      };
      new LmToolsService({ provider: createProvider({ spider, callGraphService: null }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper' }) as Record<string, unknown>;

      expect(result).toMatchObject({ source: 'symbol-dependents', callerCount: 1 });
      expect(result.callers).toEqual([
        { callerSymbolId: 'src/b.ts:runB', callerFilePath: 'src/b.ts', callerRelativePath: 'src/b.ts', line: null, isTypeOnly: false },
      ]);
    });

    it('keeps type-only dependents in the fallback when includeTypeOnly is set', async () => {
      const spider = {
        getSymbolDependents: vi.fn().mockResolvedValue([
          { sourceSymbolId: '/workspace/src/types.ts:Shape', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts', isTypeOnly: true },
          { sourceSymbolId: '/workspace/src/b.ts:runB', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts', isTypeOnly: true },
          { sourceSymbolId: '/workspace/src/b.ts:runB', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts' },
        ]),
      };
      new LmToolsService({ provider: createProvider({ spider, callGraphService: null }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper', includeTypeOnly: true }) as Record<string, unknown>;

      expect((result.callers as Array<Record<string, unknown>>).map((c) => [c.callerSymbolId, c.isTypeOnly])).toEqual([
        ['src/types.ts:Shape', true],
        ['src/b.ts:runB', false],
      ]);
      expect(result).toMatchObject({ runtimeCallerCount: 1, typeOnlyCallerCount: 1 });
    });
  });

  describe('get_symbol_dependents', () => {
    const TOOL = 'graph-it-live_get_symbol_dependents';
    const target = { targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts' };

    it('lists each dependent symbol and its own file, not the queried symbol', async () => {
      const spider = {
        getSymbolDependents: vi.fn().mockResolvedValue([
          { sourceSymbolId: '/workspace/src/b.ts:runB', ...target },
          { sourceSymbolId: '/workspace/lib/c.ts:(file)', ...target },
        ]),
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper' }) as Record<string, unknown>;

      expect(result).toMatchObject({ symbolId: 'src/a.ts:helper', dependentCount: 2 });
      expect(result.dependents).toEqual([
        { symbolId: 'src/b.ts:runB', filePath: 'src/b.ts', relativePath: 'src/b.ts' },
        { symbolId: 'lib/c.ts:(file)', filePath: 'lib/c.ts', relativePath: 'lib/c.ts' },
      ]);
    });

    it('splits a Windows-style dependent symbol id at the symbol separator, not the drive colon', async () => {
      const spider = {
        getSymbolDependents: vi.fn().mockResolvedValue([
          { sourceSymbolId: String.raw`C:\ws\src\b.ts:runB`, ...target },
        ]),
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper' }) as Record<string, unknown>;

      // Raw on POSIX, redacted to [external:<basename>] on Windows: either way the file path drops the symbol name.
      const [dependent] = result.dependents as Array<{ symbolId: string; filePath: string }>;
      expect(dependent.symbolId).toContain('runB');
      expect(dependent.filePath).not.toContain('runB');
      expect(dependent.filePath).toMatch(/b\.ts\]?$/);
    });

    it('returns an empty list when nothing depends on the symbol', async () => {
      new LmToolsService({ provider: createProvider({ spider: { getSymbolDependents: vi.fn().mockResolvedValue([]) } }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper' }) as Record<string, unknown>;

      expect(result).toMatchObject({ dependentCount: 0, dependents: [] });
    });
  });

  describe('get_impact_analysis', () => {
    const TOOL = 'graph-it-live_get_impact_analysis';

    it('reports caller files, not the changed file, for direct and transitive dependents', async () => {
      const dep = (source: string, targetFilePath: string, isTypeOnly = false) => ({
        sourceSymbolId: source, targetSymbolId: `${targetFilePath}:x`, targetFilePath, isTypeOnly,
      });
      // Keyed on the symbol only: the root path goes through path.resolve, which is OS-specific.
      const getSymbolDependents = vi.fn(async (_file: string, symbol: string) => {
        if (symbol === 'helper') {
          return [dep('/workspace/src/b.ts:runB', '/workspace/src/a.ts'), dep('/workspace/src/t.ts:TypeT', '/workspace/src/a.ts', true)];
        }
        if (symbol === 'runB') {
          return [dep('/workspace/src/c.ts:runC', '/workspace/src/b.ts')];
        }
        return [];
      });
      new LmToolsService({ provider: createProvider({ spider: { getSymbolDependents } }), logger }).registerAll();

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts', symbolName: 'helper', includeTransitive: true, maxDepth: 3,
      }) as Record<string, unknown>;

      expect((result.impactedItems as Array<Record<string, unknown>>).map((i) => [i.symbolId, i.filePath, i.relativePath, i.depth, i.usageType])).toEqual([
        ['src/b.ts:runB', 'src/b.ts', 'src/b.ts', 1, 'runtime'],
        ['src/t.ts:TypeT', 'src/t.ts', 'src/t.ts', 1, 'type-only'],
        ['src/c.ts:runC', 'src/c.ts', 'src/c.ts', 2, 'runtime'],
      ]);
      expect(result.affectedFileCount).toBe(3);
      expect(result.affectedFiles).toEqual(['src/b.ts', 'src/t.ts', 'src/c.ts']);
      expect(getSymbolDependents).toHaveBeenCalledWith('/workspace/src/b.ts', 'runB');
    });

    it('does not list the target as its own transitive impact in a mutual recursion (#259)', async () => {
      // The target path goes through path.resolve, so the recursive edge reuses the path the tool passed.
      let targetFile = '';
      const getSymbolDependents = vi.fn(async (file: string, symbol: string) => {
        if (symbol === 'isEven') {
          targetFile = file;
          return [{ sourceSymbolId: `${file}:isOdd`, targetSymbolId: `${file}:isEven`, targetFilePath: file }];
        }
        return [{ sourceSymbolId: `${targetFile}:isEven`, targetSymbolId: `${file}:isOdd`, targetFilePath: file }];
      });
      new LmToolsService({ provider: createProvider({ spider: { getSymbolDependents } }), logger }).registerAll();

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts', symbolName: 'isEven', includeTransitive: true, maxDepth: 3,
      }) as Record<string, unknown>;

      expect((result.impactedItems as Array<Record<string, unknown>>).map((i) => [i.symbolId, i.depth])).toEqual([
        ['src/a.ts:isOdd', 1],
      ]);
    });

    it('returns an error with close matches for an unknown symbol (#229)', async () => {
      const getSymbolDependents = vi.fn().mockResolvedValue([]);
      const getSymbolGraph = vi.fn().mockResolvedValue({
        symbols: [{ name: 'helper', kind: 'Function', line: 1, isExported: true, id: 'helper', category: 'function' }],
        dependencies: [],
      });
      new LmToolsService({ provider: createProvider({ spider: { getSymbolDependents, getSymbolGraph } }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helpr' }) as Record<string, unknown>;

      expect(result).toMatchObject({ error: expect.stringContaining("Symbol 'helpr' not found in src/a.ts. Did you mean: helper?") });
      expect(getSymbolDependents).not.toHaveBeenCalled();
    });

    it('keeps drive-letter paths intact when deriving the caller file', async () => {
      const getSymbolDependents = vi.fn().mockResolvedValue([
        { sourceSymbolId: 'C:/repo/src/caller.ts:run', targetSymbolId: '/workspace/src/a.ts:helper', targetFilePath: '/workspace/src/a.ts' },
      ]);
      new LmToolsService({ provider: createProvider({ spider: { getSymbolDependents } }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'helper' }) as Record<string, unknown>;

      // Outside the workspace the redaction is OS-specific (absolute on Windows only), so assert
      // the invariant instead: the drive-letter colon must not be taken as the symbol separator.
      const callerFile = (result.impactedItems as Array<Record<string, unknown>>)[0].filePath;
      expect(callerFile).toMatch(/caller\.ts/);
      expect(result.affectedFiles).toEqual([callerFile]);
    });
  });

  describe('query_call_graph', () => {
    const TOOL = 'graph-it-live_query_call_graph';

    it('returns error when call graph index is not available', async () => {
      const provider = createProvider({ callGraphService: null });
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        symbolName: 'myFn',
      }) as Record<string, unknown>;

      expect(result).toMatchObject({ error: expect.stringContaining('Call graph index not available') });
    });

    it('returns empty result when symbol is not found in DB', async () => {
      const mockDb = { exec: vi.fn().mockReturnValue([]) };
      const mockIndexer = { getDb: vi.fn().mockReturnValue(mockDb) };
      const mockCallGraphService = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue(mockIndexer) };

      const provider = createProvider({ callGraphService: mockCallGraphService });
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        symbolName: 'unknownFn',
      }) as Record<string, unknown>;

      expect(result.symbol).toBeNull();
      expect(result.callers).toEqual([]);
      expect(result.callees).toEqual([]);
      expect(result.totalCallers).toBe(0);
      expect(result.totalCallees).toBe(0);
    });

    it('returns symbol info and BFS results when symbol is found', async () => {
      const symbolRow = ['sym1', 'myFn', 'function', 'typescript', '/workspace/src/a.ts', 10, 20, 1];
      const edgeRow = ['sym2', 'sym1', 'call', 0, 15, 'caller', '/workspace/src/b.ts', 'myFn', '/workspace/src/a.ts'];

      const mockDb = {
        exec: vi.fn()
          // First call: SELECT symbol by path + name
          .mockReturnValueOnce([{ values: [symbolRow] }])
          // Second call: BFS callers (depth 1, finding sym2 → sym1)
          .mockReturnValueOnce([{ values: [edgeRow] }])
          // Third call: BFS callees
          .mockReturnValueOnce([{ values: [] }])
          // Remaining BFS iterations: no more edges
          .mockReturnValue([{ values: [] }]),
      };
      const mockIndexer = { getDb: vi.fn().mockReturnValue(mockDb) };
      const mockCallGraphService = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue(mockIndexer) };

      const provider = createProvider({ callGraphService: mockCallGraphService });
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        symbolName: 'myFn',
        direction: 'both',
        depth: 1,
      }) as Record<string, unknown>;

      expect(result.symbol).toMatchObject({
        id: 'sym1',
        name: 'myFn',
        type: 'function',
        lang: 'typescript',
      });
      expect(result.totalCallers).toBe(1);
      expect(result.totalCallees).toBe(0);
      expect(result.direction).toBe('both');
      expect(result.depth).toBe(1);
    });

    it('queries only callers when direction is "callers"', async () => {
      const symbolRow = ['sym1', 'myFn', 'function', 'typescript', '/workspace/src/a.ts', 1, 5, 1];

      const mockDb = {
        exec: vi.fn()
          .mockReturnValueOnce([{ values: [symbolRow] }]) // symbol lookup
          .mockReturnValue([{ values: [] }]),              // BFS callers (empty)
      };
      const mockIndexer = { getDb: vi.fn().mockReturnValue(mockDb) };
      const mockCallGraphService = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue(mockIndexer) };

      const provider = createProvider({ callGraphService: mockCallGraphService });
      new LmToolsService({ provider, logger }).registerAll();

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/a.ts',
        symbolName: 'myFn',
        direction: 'callers',
      }) as Record<string, unknown>;

      expect(result.direction).toBe('callers');
      expect(result.callees).toEqual([]);
    });

    it('returns the database error as a tool error', async () => {
      const exec = vi.fn().mockImplementation(() => { throw new Error('db closed'); });
      const service = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue({ getDb: () => ({ exec }) }) };
      new LmToolsService({ provider: createProvider({ callGraphService: service }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePath: '/workspace/src/a.ts', symbolName: 'myFn' });

      expect(result).toEqual({ error: 'db closed' });
    });
  });

  // ─── Shared guards and error paths ────────────────────────────────────────

  const A = '/workspace/src/a.ts';
  const B = '/workspace/src/b.ts';
  const C = '/workspace/src/c.ts';

  // Every spider-backed tool with an input that passes path validation.
  const spiderTools: Array<[string, Record<string, unknown>]> = [
    ['graph-it-live_find_referencing_files', { targetPath: A }],
    ['graph-it-live_analyze_dependencies', { filePath: A }],
    ['graph-it-live_crawl_dependency_graph', { entryFile: A }],
    ['graph-it-live_get_symbol_graph', { filePath: A }],
    ['graph-it-live_find_unused_symbols', { filePath: A }],
    ['graph-it-live_get_symbol_callers', { filePath: A, symbolName: 'helper' }],
    ['graph-it-live_get_impact_analysis', { filePath: A, symbolName: 'helper' }],
    ['graph-it-live_parse_imports', { filePath: A }],
    ['graph-it-live_generate_codemap', { filePath: A }],
    ['graph-it-live_expand_node', { filePath: A }],
    ['graph-it-live_verify_dependency_usage', { sourceFile: A, targetFile: B }],
    ['graph-it-live_invalidate_files', { filePaths: [A] }],
    ['graph-it-live_rebuild_index', {}],
    ['graph-it-live_get_symbol_dependents', { filePath: A, symbolName: 'helper' }],
    ['graph-it-live_trace_function_execution', { filePath: A, symbolName: 'helper' }],
    ['graph-it-live_analyze_file_logic', { filePath: A }],
    ['graph-it-live_scan_dead_code', {}],
  ];

  it.each(spiderTools)('%s returns an error when the dependency index is not initialized', async (tool, input) => {
    const provider = createProvider();
    vi.mocked(provider.getSpiderForLmTools).mockReturnValue(undefined);
    new LmToolsService({ provider, logger }).registerAll();

    const result = await invokeTool(tool, input);

    expect(result).toEqual({ error: 'No workspace open or dependency index not initialized.' });
  });

  it.each(spiderTools)('%s returns the analyzer failure as a tool error', async (tool, input) => {
    const fail = () => Promise.reject(new Error('analyzer failed'));
    const spider = {
      findReferencingFiles: fail, analyze: fail, crawl: fail, getSymbolGraph: fail,
      findUnusedSymbols: fail, getSymbolDependents: fail, verifyDependencyUsage: fail,
      traceFunctionExecution: fail, buildFullIndex: fail, scanDeadCode: fail,
      clearCache: vi.fn(),
      invalidateFile: () => { throw new Error('analyzer failed'); },
    };
    vi.mocked(fsPromises.readFile).mockResolvedValue(
      'x' as unknown as Awaited<ReturnType<typeof fsPromises.readFile>>,
    );
    new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

    const result = await invokeTool(tool, input);

    expect(result).toEqual({ error: 'analyzer failed' });
  });

  it('stringifies a non-Error rejection', async () => {
    const spider = { findReferencingFiles: vi.fn().mockRejectedValue('plain failure') };
    new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

    expect(await invokeTool('graph-it-live_find_referencing_files', { targetPath: A })).toEqual({ error: 'plain failure' });
  });

  it('rejects a relative input path before calling the analyzer', async () => {
    const spider = { analyze: vi.fn() };
    new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();
    const handler = registeredTools.get('graph-it-live_analyze_dependencies');

    await expect(handler?.invoke(makeOptions({ filePath: 'src/a.ts' }), fakeToken)).rejects.toThrow('absolute path');
    expect(spider.analyze).not.toHaveBeenCalled();
  });

  it('reports an uninitialized index status without a spider', async () => {
    const provider = createProvider();
    vi.mocked(provider.getSpiderForLmTools).mockReturnValue(undefined);
    new LmToolsService({ provider, logger }).registerAll();

    expect(await invokeTool('graph-it-live_get_index_status', {})).toMatchObject({ state: 'uninitialized', isReady: false });
  });

  it('returns the index status failure as a tool error', async () => {
    const spider = { getIndexStatus: () => { throw new Error('status failed'); } };
    new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

    expect(await invokeTool('graph-it-live_get_index_status', {})).toEqual({ error: 'status failed' });
  });

  it('returns an error from graph_context when no call graph index exists', async () => {
    new LmToolsService({ provider: createProvider(), logger }).registerAll();

    expect(await invokeTool('graph-it-live_graph_context', { question: 'auth' })).toEqual({
      error: 'No workspace or graph index is available.',
    });
  });

  it('returns a non-abort graph_context failure as a tool error', async () => {
    executeGraphContextWithIndexes.mockRejectedValueOnce(new Error('bad seed'));
    const callGraphService = { getCallGraphIndexerForLmTools: vi.fn().mockReturnValue({ getDb: vi.fn() }) };
    new LmToolsService({ provider: createProvider({ callGraphService }), logger }).registerAll();

    expect(await invokeTool('graph-it-live_graph_context', { question: 'auth' })).toEqual({ error: 'bad seed' });
  });

  // ─── Spider-backed handlers ───────────────────────────────────────────────

  describe('find_referencing_files', () => {
    it('lists referencing files and redacts paths outside the workspace', async () => {
      const spider = {
        findReferencingFiles: vi.fn().mockResolvedValue([
          { path: B, type: 'import', line: 3, module: './a' },
          { path: '/elsewhere/lib/d.ts', type: 'import', line: 1, module: '../a' },
        ]),
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_find_referencing_files', { targetPath: A });

      expect(result).toEqual({
        targetPath: 'src/a.ts',
        referencingFileCount: 2,
        referencingFiles: [
          { path: 'src/b.ts', relativePath: 'src/b.ts', type: 'import', line: 3, module: './a' },
          { path: '[external:d.ts]', relativePath: '[external:d.ts]', type: 'import', line: 1, module: '../a' },
        ],
      });
    });
  });

  describe('analyze_dependencies and parse_imports', () => {
    const deps = [
      { module: './b', path: B, type: 'import', line: 1 },
      { module: 'lodash', path: undefined, type: 'import', line: 2 },
    ];

    it('analyze_dependencies maps resolved and unresolved imports', async () => {
      new LmToolsService({ provider: createProvider({ spider: { analyze: vi.fn().mockResolvedValue(deps) } }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_analyze_dependencies', { filePath: A });

      expect(result).toEqual({
        filePath: 'src/a.ts',
        dependencyCount: 2,
        dependencies: [
          { module: './b', path: 'src/b.ts', relativePath: 'src/b.ts', type: 'import', line: 1 },
          { module: 'lodash', relativePath: null, type: 'import', line: 2 },
        ],
      });
    });

    it('parse_imports returns raw module specifiers only', async () => {
      new LmToolsService({ provider: createProvider({ spider: { analyze: vi.fn().mockResolvedValue(deps) } }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_parse_imports', { filePath: A });

      expect(result).toEqual({
        filePath: 'src/a.ts',
        importCount: 2,
        imports: [
          { module: './b', type: 'import', line: 1 },
          { module: 'lodash', type: 'import', line: 2 },
        ],
      });
    });
  });

  describe('crawl_dependency_graph', () => {
    const TOOL = 'graph-it-live_crawl_dependency_graph';

    it('returns nodes and edges with relative paths and forwards maxDepth', async () => {
      const crawl = vi.fn().mockResolvedValue({ nodes: [A, B], edges: [{ source: A, target: B }] });
      new LmToolsService({ provider: createProvider({ spider: { crawl } }), logger }).registerAll();

      const result = await invokeTool(TOOL, { entryFile: A, maxDepth: 2 });

      expect(crawl).toHaveBeenCalledWith(path.resolve(A), { maxDepth: 2, signal: expect.any(AbortSignal) });
      expect(result).toEqual({
        entryFile: 'src/a.ts',
        nodeCount: 2,
        edgeCount: 1,
        nodes: [{ path: 'src/a.ts', relativePath: 'src/a.ts' }, { path: 'src/b.ts', relativePath: 'src/b.ts' }],
        edges: [{ source: 'src/a.ts', target: 'src/b.ts', sourceRelative: 'src/a.ts', targetRelative: 'src/b.ts' }],
      });
    });

    it('turns an aborted crawl into a cancellation', async () => {
      const crawl = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      new LmToolsService({ provider: createProvider({ spider: { crawl } }), logger }).registerAll();

      await expect(registeredTools.get(TOOL)?.invoke(makeOptions({ entryFile: A }), fakeToken))
        .rejects.toBeInstanceOf(vscode.CancellationError);
    });
  });

  describe('expand_node', () => {
    it('returns only nodes and edges the caller does not know yet', async () => {
      const crawl = vi.fn().mockResolvedValue({
        nodes: [A, B, C],
        edges: [{ source: A, target: B }, { source: B, target: C }, { source: A, target: A }],
      });
      new LmToolsService({ provider: createProvider({ spider: { crawl } }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_expand_node', { filePath: A, knownPaths: [A] });

      expect(result).toMatchObject({
        filePath: 'src/a.ts',
        newNodeCount: 2,
        newEdgeCount: 2,
        newNodes: [{ path: 'src/b.ts', relativePath: 'src/b.ts' }, { path: 'src/c.ts', relativePath: 'src/c.ts' }],
      });
      expect((result as { newEdges: Array<{ targetRelative: string }> }).newEdges.map((e) => e.targetRelative))
        .toEqual(['src/b.ts', 'src/c.ts']);
    });
  });

  describe('get_symbol_graph and find_unused_symbols', () => {
    const symbols = [
      { name: 'used', kind: 'function', line: 1, isExported: true, category: 'function' },
      { name: 'unused', kind: 'function', line: 5, isExported: true, category: 'function' },
      { name: 'local', kind: 'variable', line: 9, isExported: false, category: 'variable' },
    ];

    it('get_symbol_graph adds the relative target path to each dependency', async () => {
      const getSymbolGraph = vi.fn().mockResolvedValue({
        symbols,
        dependencies: [{ sourceSymbolId: `${A}:used`, targetSymbolId: `${B}:run`, targetFilePath: B }],
      });
      new LmToolsService({ provider: createProvider({ spider: { getSymbolGraph } }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_get_symbol_graph', { filePath: A }) as Record<string, unknown>;

      expect(result).toMatchObject({ relativePath: 'src/a.ts', symbolCount: 3, dependencyCount: 1, symbols });
      expect(result.dependencies).toEqual([
        { sourceSymbolId: 'src/a.ts:used', targetSymbolId: 'src/b.ts:run', targetFilePath: 'src/b.ts', targetRelativePath: 'src/b.ts' },
      ]);
    });

    it.each([
      [symbols, 50, 2],
      [[], 0, 0],
    ])('find_unused_symbols reports the unused share of exports', async (fileSymbols, percentage, exported) => {
      const spider = {
        findUnusedSymbols: vi.fn().mockResolvedValue([{ name: 'unused', kind: 'function', line: 5 }]),
        getSymbolGraph: vi.fn().mockResolvedValue({ symbols: fileSymbols, dependencies: [] }),
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_find_unused_symbols', { filePath: A });

      expect(result).toEqual({
        filePath: 'src/a.ts',
        relativePath: 'src/a.ts',
        unusedCount: 1,
        totalExportedSymbols: exported,
        unusedPercentage: percentage,
        unusedSymbols: [{ name: 'unused', kind: 'function', line: 5 }],
      });
    });
  });

  describe('intra-file call flow', () => {
    // ping and pong call each other: a cycle the call-hierarchy analyzer must report.
    const graphData = {
      symbols: [
        { name: 'ping', kind: 'function', line: 1, endLine: 3, isExported: true, category: 'function' },
        { name: 'pong', kind: 'function', line: 5, endLine: 7, isExported: false, category: 'function' },
      ],
      dependencies: [
        { sourceSymbolId: `${A}:ping`, targetSymbolId: `${A}:pong`, targetFilePath: A, line: 2 },
        { sourceSymbolId: `${A}:pong`, targetSymbolId: `${A}:ping`, targetFilePath: A, line: 6 },
      ],
    };

    it('generate_codemap summarizes exports, dependencies, dependents and call flow', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue(
        'line1\nline2\nline3' as unknown as Awaited<ReturnType<typeof fsPromises.readFile>>,
      );
      const spider = {
        getSymbolGraph: vi.fn().mockResolvedValue(graphData),
        analyze: vi.fn().mockResolvedValue([{ module: './b', path: B, type: 'import', line: 1 }]),
        findReferencingFiles: vi.fn().mockResolvedValue([{ path: C, type: 'import', line: 4 }]),
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_generate_codemap', { filePath: A }) as Record<string, unknown>;

      expect(result).toMatchObject({
        relativePath: 'src/a.ts',
        language: 'typescript',
        lineCount: 3,
        exports: [{ name: 'ping', kind: 'function', line: 1, category: 'function' }],
        internals: [{ name: 'pong', kind: 'function', line: 5, category: 'function' }],
        dependencies: [{ module: './b', relativePath: 'src/b.ts', type: 'import', line: 1 }],
        dependents: [{ path: 'src/c.ts', relativePath: 'src/c.ts', type: 'import', line: 4 }],
        hasCycle: true,
      });
      expect(result.callFlow).toEqual(expect.arrayContaining([
        expect.objectContaining({ caller: 'ping', callee: 'pong' }),
        expect.objectContaining({ caller: 'pong', callee: 'ping' }),
      ]));
      expect(result.cycleSymbols).toEqual(expect.arrayContaining(['ping', 'pong']));
    });

    it('generate_codemap keeps a partial result when the reverse index is not ready', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue(
        '' as unknown as Awaited<ReturnType<typeof fsPromises.readFile>>,
      );
      const spider = {
        getSymbolGraph: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
        analyze: vi.fn().mockResolvedValue([]),
        findReferencingFiles: vi.fn().mockRejectedValue(new Error('index not ready')),
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_generate_codemap', { filePath: A });

      expect(result).toMatchObject({ lineCount: 1, exports: [], dependents: [], callFlow: [], hasCycle: false });
    });

    it('analyze_file_logic returns the intra-file call graph with its cycle', async () => {
      new LmToolsService({
        provider: createProvider({ spider: { getSymbolGraph: vi.fn().mockResolvedValue(graphData) } }),
        logger,
      }).registerAll();

      const result = await invokeTool('graph-it-live_analyze_file_logic', { filePath: A }) as {
        filePath: string; graph: { nodes: unknown[]; edges: unknown[]; hasCycle: boolean; cycleNodes: string[] };
      };

      expect(result.filePath).toBe('src/a.ts');
      expect(result.graph.nodes).toHaveLength(2);
      expect(result.graph.edges).toHaveLength(2);
      expect(result.graph.hasCycle).toBe(true);
      expect(result.graph.cycleNodes).toHaveLength(2);
    });
  });

  describe('verify_dependency_usage', () => {
    it.each([true, false])('reports isUsed = %s', async (isUsed) => {
      const verifyDependencyUsage = vi.fn().mockResolvedValue(isUsed);
      new LmToolsService({ provider: createProvider({ spider: { verifyDependencyUsage } }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_verify_dependency_usage', { sourceFile: A, targetFile: B });

      expect(result).toEqual({ sourceFile: 'src/a.ts', targetFile: 'src/b.ts', isUsed });
    });
  });

  describe('invalidate_files', () => {
    const TOOL = 'graph-it-live_invalidate_files';

    it('splits invalidated files from files that were not cached', async () => {
      const invalidateFile = vi.fn((file: string) => file.endsWith('a.ts'));
      new LmToolsService({ provider: createProvider({ spider: { invalidateFile } }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePaths: [A, B] });

      expect(result).toEqual({ invalidatedCount: 1, invalidatedFiles: ['src/a.ts'], notFoundFiles: ['src/b.ts'] });
    });

    it('rejects more than 10000 files per invocation', async () => {
      const invalidateFile = vi.fn();
      new LmToolsService({ provider: createProvider({ spider: { invalidateFile } }), logger }).registerAll();

      const result = await invokeTool(TOOL, { filePaths: Array.from({ length: 10_001 }, () => A) });

      expect(result).toEqual({ error: 'At most 10000 files can be invalidated per invocation.' });
      expect(invalidateFile).not.toHaveBeenCalled();
    });
  });

  describe('rebuild_index', () => {
    it('clears the cache before rebuilding and reports the new cache size', async () => {
      const calls: string[] = [];
      const spider = {
        clearCache: vi.fn(() => calls.push('clear')),
        buildFullIndex: vi.fn(async () => { calls.push('build'); }),
        getCacheStatsAsync: vi.fn().mockResolvedValue({ dependencyCache: { size: 7 } }),
      };
      new LmToolsService({ provider: createProvider({ spider }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_rebuild_index', {}) as Record<string, unknown>;

      expect(calls).toEqual(['clear', 'build']);
      expect(result.newCacheSize).toBe(7);
      expect(result.rebuildTimeMs).toEqual(expect.any(Number));
    });
  });

  describe('trace_function_execution', () => {
    it('returns the call chain with resolved relative paths and the default depth', async () => {
      const traceFunctionExecution = vi.fn().mockResolvedValue({
        rootSymbol: { id: `${A}:main`, filePath: A, symbolName: 'main' },
        callChain: [
          { depth: 1, callerSymbolId: `${A}:main`, calledSymbolId: `${B}:run`, calledFilePath: B, resolvedFilePath: B },
          { depth: 1, callerSymbolId: `${A}:main`, calledSymbolId: 'fs:readFile', calledFilePath: 'fs', resolvedFilePath: null },
        ],
        visitedSymbols: [`${A}:main`, `${B}:run`],
        maxDepthReached: false,
      });
      new LmToolsService({ provider: createProvider({ spider: { traceFunctionExecution } }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_trace_function_execution', { filePath: A, symbolName: 'main' }) as Record<string, unknown>;

      expect(traceFunctionExecution).toHaveBeenCalledWith(path.resolve(A), 'main', 10);
      expect(result).toMatchObject({
        rootSymbol: { id: 'src/a.ts:main', filePath: 'src/a.ts', relativePath: 'src/a.ts', symbolName: 'main' },
        maxDepth: 10,
        callCount: 2,
        uniqueSymbolCount: 2,
        maxDepthReached: false,
      });
      expect((result.callChain as Array<{ resolvedRelativePath: string | null }>).map((e) => e.resolvedRelativePath))
        .toEqual(['src/b.ts', null]);
    });
  });

  describe('scan_dead_code', () => {
    it('scans the requested scope and reports unused symbols per file', async () => {
      const scanDeadCode = vi.fn().mockResolvedValue({
        entries: [{ filePath: A, unusedSymbols: [{ name: 'old', kind: 'function', line: 3 }] }],
        scannedFiles: 4,
        skippedFiles: [],
        filesBeyondLimit: 0,
      });
      new LmToolsService({ provider: createProvider({ spider: { scanDeadCode } }), logger }).registerAll();

      const result = await invokeTool('graph-it-live_scan_dead_code', { scopePath: '/workspace/src', maxFiles: 50 });

      expect(scanDeadCode).toHaveBeenCalledWith(path.resolve('/workspace/src'), expect.objectContaining({ maxFiles: 50 }));
      expect(result).toMatchObject({
        scannedFiles: 4,
        filesWithDeadCode: 1,
        totalUnusedSymbols: 1,
        truncated: false,
        entries: [{ relativePath: 'src/a.ts', unusedCount: 1 }],
      });
    });
  });
});
