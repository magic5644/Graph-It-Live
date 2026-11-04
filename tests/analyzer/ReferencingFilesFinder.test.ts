import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReferencingFilesFinder } from '../../src/analyzer/ReferencingFilesFinder';

const sampleFiles = [
  '/root/src/a.ts',
  '/root/src/b.ts',
  '/root/src/c.js',
];

describe('ReferencingFilesFinder', () => {
  const collectAllSourceFiles = vi.fn(async () => sampleFiles);
  const findReferencesInFile = vi.fn(async (filePath: string, targets: ReadonlyArray<{ path: string; basename: string }>) =>
    filePath.endsWith('b.ts')
      ? targets.map(target => ({ target: target.path, dependency: { path: filePath, type: 'import', line: 1, module: `./${target.basename}` } as any }))
      : []);

  beforeEach(() => {
    collectAllSourceFiles.mockClear();
    findReferencesInFile.mockClear();
  });

  it('returns empty when basename cannot be derived', async () => {
    const finder = new ReferencingFilesFinder({
      sourceFileCollector: { collectAllSourceFiles } as any,
      getRootDir: () => '/root',
      getConcurrency: () => 2,
      findReferencesInFile,
    });

    const result = await finder.findReferencingFilesFallback('');
    expect(result).toEqual([]);
    expect(collectAllSourceFiles).not.toHaveBeenCalled();
  });

  it('finds references using batching and normalization', async () => {
    const finder = new ReferencingFilesFinder({
      sourceFileCollector: { collectAllSourceFiles } as any,
      getRootDir: () => '/root',
      getConcurrency: () => 2,
      findReferencesInFile,
    });

    const result = await finder.findReferencingFilesFallback('/root/src/a.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('/root/src/b.ts');
    expect(collectAllSourceFiles).toHaveBeenCalledWith('/root');
    // Should skip target file itself
    expect(findReferencesInFile).toHaveBeenCalledTimes(2);
  });

  it('answers every target from one scan, each file read once (#605)', async () => {
    const finder = new ReferencingFilesFinder({
      sourceFileCollector: { collectAllSourceFiles } as any,
      getRootDir: () => '/root',
      getConcurrency: () => 2,
      findReferencesInFile,
    });

    const result = await finder.findReferencingFilesFallbackMany(['/root/src/a.ts', String.raw`\root\src\c.js`, '']);
    expect([...result.keys()]).toEqual(['/root/src/a.ts', '/root/src/c.js', '']);
    expect(result.get('/root/src/a.ts')?.map(d => d.module)).toEqual(['./a']);
    expect(result.get('/root/src/c.js')?.map(d => d.module)).toEqual(['./c']);
    expect(result.get('')).toEqual([]);
    expect(collectAllSourceFiles).toHaveBeenCalledTimes(1);
    // Each file once, without the targets it is itself.
    expect(findReferencesInFile.mock.calls.map(([file, targets]) => `${file}:${targets.map(t => t.basename).join(',')}`))
      .toEqual(['/root/src/a.ts:c', '/root/src/b.ts:a,c', '/root/src/c.js:a']);
  });
});
