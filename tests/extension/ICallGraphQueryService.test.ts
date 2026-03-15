import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  default: {},
  Uri: {
    file: (p: string) => ({ fsPath: p }),
    joinPath: (...args: unknown[]) => ({ fsPath: (args as string[]).join('/') }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

import type { ExternalCallerResult, ICallGraphQueryService } from '../../src/extension/services/ICallGraphQueryService';

/**
 * Create a mock implementation of ICallGraphQueryService backed by
 * a simple in-memory data structure (no sql.js needed).
 */
function createMockService(opts: {
  indexed: boolean;
  callers?: ExternalCallerResult[];
}): ICallGraphQueryService {
  return {
    isIndexed: () => opts.indexed,
    findExternalCallers: (_filePath, _symbolNames, _max) => opts.callers ?? [],
  };
}

describe('ICallGraphQueryService contract', () => {

  it('returns empty array when not indexed', () => {
    const service = createMockService({ indexed: false });
    expect(service.isIndexed()).toBe(false);
    expect(service.findExternalCallers('/src/a.ts', ['foo'])).toEqual([]);
  });

  it('returns callers when indexed', () => {
    const callers: ExternalCallerResult[] = [
      { targetSymbolName: 'foo', callerName: 'main', callerFilePath: '/src/main.ts', callerStartLine: 10 },
      { targetSymbolName: 'foo', callerName: 'init', callerFilePath: '/src/init.ts', callerStartLine: 5 },
    ];
    const service = createMockService({ indexed: true, callers });
    expect(service.isIndexed()).toBe(true);

    const result = service.findExternalCallers('/src/a.ts', ['foo']);
    expect(result).toHaveLength(2);
    expect(result[0].callerName).toBe('main');
    expect(result[1].callerName).toBe('init');
  });

  it('returns empty array for empty symbol names', () => {
    const service = createMockService({ indexed: true, callers: [] });
    expect(service.findExternalCallers('/src/a.ts', [])).toEqual([]);
  });
});
