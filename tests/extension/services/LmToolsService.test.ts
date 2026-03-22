import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// ─── vscode mock ──────────────────────────────────────────────────────────────

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(public readonly value: string) {}
  }

  class LanguageModelToolResult {
    constructor(public readonly parts: LanguageModelTextPart[]) {}
  }

  return {
    lm: {
      registerTool: registerToolFn,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    },
    LanguageModelTextPart,
    LanguageModelToolResult,
  };
});

// ─── Dynamic-import mocks ─────────────────────────────────────────────────────

vi.mock('@/analyzer/SignatureAnalyzer', () => ({
  SignatureAnalyzer: class {
    analyzeBreakingChanges(_file: string, _old: string, _new: string) {
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

vi.mock('@/shared/path', () => ({
  normalizePath: (p: string) => p.replaceAll('\\', '/'),
}));

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

const fakeToken = {} as vscode.CancellationToken;

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
    vi.mocked(fsPromises.readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
  });

  // ─── registerAll ──────────────────────────────────────────────────────────

  describe('registerAll', () => {
    it('registers 20 tools and returns 20 disposables', () => {
      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      const disposables = service.registerAll();

      expect(disposables).toHaveLength(20);
      expect(registerToolFn).toHaveBeenCalledTimes(20);
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

    it('registers graph-it-live_resolve_module_path', () => {
      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      service.registerAll();
      expect(registeredTools.has('graph-it-live_resolve_module_path')).toBe(true);
    });

    it('registers graph-it-live_analyze_breaking_changes', () => {
      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      service.registerAll();
      expect(registeredTools.has('graph-it-live_analyze_breaking_changes')).toBe(true);
    });

    it('registers graph-it-live_query_call_graph', () => {
      const provider = createProvider();
      const service = new LmToolsService({ provider, logger });
      service.registerAll();
      expect(registeredTools.has('graph-it-live_query_call_graph')).toBe(true);
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
      expect(result.resolvedPath).toBe('/workspace/src/b.ts');
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

    it('filters results by symbolName when provided', async () => {
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

      // Mock only returns results for 'myFn', filter for 'other' yields nothing
      expect(resultNonMatching.breakingChangesCount).toBe(0);
      expect(resultNonMatching.hasBreakingChanges).toBe(false);
    });

    it('returns error when newContent is missing and file cannot be read', async () => {
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('File not found'));

      const result = await invokeTool(TOOL, {
        filePath: '/workspace/src/missing.ts',
        oldContent: 'export function myFn() {}',
      }) as Record<string, unknown>;

      expect(result).toMatchObject({ error: expect.stringContaining('Cannot read current file') });
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
      expect(fsPromises.readFile).toHaveBeenCalledWith('/workspace/src/a.ts', 'utf-8');
    });
  });

  // ─── query_call_graph ─────────────────────────────────────────────────────

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
  });
});
