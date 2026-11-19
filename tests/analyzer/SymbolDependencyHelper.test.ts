import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { SymbolDependencyHelper } from '../../src/analyzer/SymbolDependencyHelper';

describe('SymbolDependencyHelper', () => {
  it('detects matching dependencies with resolver fallback', async () => {
    const resolver = vi.fn(async (from: string, to: string) => {
      if (from === '/root/src/a.ts' && to === './b') return '/root/src/b.ts';
      return null;
    });
    const helper = new SymbolDependencyHelper({ resolve: resolver });

    const matchDirect = await helper.doesDependencyTargetFile(
      { targetFilePath: '/root/src/a.ts' } as any,
      '/root/src/a.ts',
      '/root/src/a.ts'
    );
    expect(matchDirect).toBe(true);

    const matchResolved = await helper.doesDependencyTargetFile(
      { targetFilePath: './b' } as any,
      '/root/src/a.ts',
      '/root/src/b.ts'
    );
    expect(matchResolved).toBe(true);
    expect(resolver).toHaveBeenCalled();

    const noMatch = await helper.doesDependencyTargetFile(
      { targetFilePath: './c' } as any,
      '/root/src/a.ts',
      '/root/src/b.ts'
    );
    expect(noMatch).toBe(false);
  });

  // #774: re-resolving every resolved dependency against every target file dominated a warm init.
  it('never resolves again a target that is already an absolute path', async () => {
    const resolver = vi.fn(async () => '/root/src/b.ts');
    const helper = new SymbolDependencyHelper({ resolve: resolver });
    const other = path.join(path.parse(process.cwd()).root, 'root', 'src', 'c.ts');

    expect(await helper.doesDependencyTargetFile({ targetFilePath: other } as never, '/root/src/a.ts', '/root/src/b.ts')).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('extracts names and builds normalized symbol ids', () => {
    const helper = new SymbolDependencyHelper({ resolve: async () => null });
    expect(helper.extractSymbolName('/path/file.ts:MyFunc')).toBe('MyFunc');
    const normalized = helper.buildUsedSymbolId('C:\\root\\src\\a.ts', 'Func');
    expect(normalized.toLowerCase()).toBe('c:/root/src/a.ts:func'.replace('func', 'Func').toLowerCase());
  });
});
