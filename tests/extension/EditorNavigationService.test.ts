import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorNavigationService } from '../../src/extension/services/EditorNavigationService';
import type { Spider } from '../../src/analyzer/Spider';

const vscodeHoist = vi.hoisted(() => {
  const mocks = {
    showInformationMessage: vi.fn(),
    mockEditor: {
      document: { uri: { scheme: 'file' }, fileName: '/workspace/src/app.ts' },
      selection: null as unknown,
      revealRange: vi.fn(),
    },
    openTextDocument: vi.fn(async (path: string) => ({ uri: { fsPath: path } })),
    showTextDocument: vi.fn(async () => mocks.mockEditor),
  };
  return { mocks };
});

class Position {
  constructor(public line: number, public character: number) {}
}

class Selection {
  constructor(public start: Position, public end: Position) {}
}

class Range {
  constructor(public start: Position, public end: Position) {}
}

vi.mock('vscode', () => {
  const { mocks } = vscodeHoist;
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Selection {
    constructor(public start: Position, public end: Position) {}
  }
  class Range {
    constructor(public start: Position, public end: Position) {}
  }
  return {
    window: {
      activeTextEditor: mocks.mockEditor,
      showInformationMessage: mocks.showInformationMessage,
      showTextDocument: mocks.showTextDocument,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      openTextDocument: mocks.openTextDocument,
    },
    ViewColumn: { One: 1 },
    Position,
    Selection,
    Range,
    TextEditorRevealType: { InCenter: 0 },
  };
});

const { mocks } = vscodeHoist;
const { showInformationMessage, mockEditor } = mocks;

const createSpider = () =>
  ({
    resolveModuleSpecifier: vi.fn(async () => '/workspace/src/utils.ts'),
    getSymbolGraph: vi.fn(async () => ({ symbols: [{ name: 'foo', id: '/workspace/src/utils.ts:foo', line: 5 }] })),
  }) as unknown as Spider;

describe('EditorNavigationService', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = createSpider();
    showInformationMessage.mockReset();
  });

  afterEach(() => {
    (mockEditor as any).document.fileName = '/workspace/src/app.ts';
  });

  it('parses symbol identifiers correctly', () => {
    const service = new EditorNavigationService(spider, console);
    const parsed = service.parseFilePathAndSymbol('src/utils.ts:formatDate');
    expect(parsed.actualFilePath).toBe('src/utils.ts');
    expect(parsed.symbolName).toBe('formatDate');
  });

  it('resolves module path using active editor as base', async () => {
    const service = new EditorNavigationService(spider, console);
    const resolved = await service.resolveDrillDownPath('./utils', undefined);
    expect(resolved).toBe('/workspace/src/utils.ts');
  });

  it('shows message when resolution base is missing', async () => {
    const service = new EditorNavigationService(spider, console);
    (mockEditor as any).document.uri.scheme = 'untitled';
    const result = await service.resolveDrillDownPath('./utils', undefined);
    expect(result).toBeUndefined();
    expect(showInformationMessage).toHaveBeenCalled();
    (mockEditor as any).document.uri.scheme = 'file';
  });
});
