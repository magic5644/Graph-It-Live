import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReferencingFilesFinder } from '../../src/analyzer/ReferencingFilesFinder';

const sampleFiles = [
  '/root/src/a.ts',
  '/root/src/b.ts',
  '/root/src/c.js',
];

describe('ReferencingFilesFinder', () => {
  const collectAllSourceFiles = vi.fn(async () => sampleFiles);
  const findReferenceInFile = vi.fn(async (filePath: string, normalizedTarget: string) => {
    if (filePath.endsWith('b.ts')) {
      return {
        path: filePath,
        type: 'import',
        line: 1,
        module: './a',
      } as any;
    }
    return null;
  });

  beforeEach(() => {
    collectAllSourceFiles.mockClear();
    findReferenceInFile.mockClear();
  });

  it('returns empty when basename cannot be derived', async () => {
    const finder = new ReferencingFilesFinder({
      sourceFileCollector: { collectAllSourceFiles } as any,
      getRootDir: () => '/root',
      getConcurrency: () => 2,
      findReferenceInFile,
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
      findReferenceInFile,
    });

    const result = await finder.findReferencingFilesFallback('/root/src/a.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('/root/src/b.ts');
    expect(collectAllSourceFiles).toHaveBeenCalledWith('/root');
    // Should skip target file itself
    expect(findReferenceInFile).toHaveBeenCalledTimes(2);
  });
});
