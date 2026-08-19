import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpiderDependencyAnalyzer } from '../../src/analyzer/spider/SpiderDependencyAnalyzer';
import { SpiderError, SpiderErrorCode } from '../../src/analyzer/types';
import { Cache } from '../../src/analyzer/Cache';

function makeAnalyzer(
  parseImports: () => Promise<unknown>,
  isWithinWorkspace: (candidate: string) => boolean = () => true,
) {
  const languageService = {
    getAnalyzer: vi.fn(() => ({
      parseImports,
      resolvePath: vi.fn().mockResolvedValue(null),
    })),
  } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[0];

  const resolver = {
    isWithinWorkspace,
  } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[1];

  const cache = new Cache<Parameters<typeof SpiderDependencyAnalyzer.prototype.analyze>[0][]>({ maxSize: 100 });

  const reverseIndexManager = {
    isEnabled: vi.fn().mockReturnValue(false),
    addDependencies: vi.fn(),
  } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[3];

  return new SpiderDependencyAnalyzer(languageService, resolver, cache as never, reverseIndexManager);
}

describe('SpiderDependencyAnalyzer', () => {
  describe('analyze - skippable errors', () => {
    it('returns empty array when file is too large (no crash)', async () => {
      const analyzer = makeAnalyzer(() =>
        Promise.reject(new SpiderError('File too large', SpiderErrorCode.FILE_TOO_LARGE))
      );
      const result = await analyzer.analyze('/large.graphql');
      expect(result).toEqual([]);
    });

    it('returns empty array on read timeout (no crash)', async () => {
      const analyzer = makeAnalyzer(() =>
        Promise.reject(new SpiderError('Timed out', SpiderErrorCode.TIMEOUT))
      );
      const result = await analyzer.analyze('/slow.graphql');
      expect(result).toEqual([]);
    });

    it('rethrows other errors (e.g. PARSE_ERROR)', async () => {
      const analyzer = makeAnalyzer(() =>
        Promise.reject(new SpiderError('Parse failed', SpiderErrorCode.PARSE_ERROR))
      );
      await expect(analyzer.analyze('/bad.ts')).rejects.toMatchObject({
        code: SpiderErrorCode.PARSE_ERROR,
      });
    });

    it('skips a resolved dependency outside the workspace', async () => {
      const resolvedPath = '/outside/secret.ts';
      const languageService = {
        getAnalyzer: vi.fn(() => ({
          parseImports: vi.fn().mockResolvedValue([
            { path: '/workspace/app.ts', type: 'import', line: 1, module: '../secret' },
          ]),
          resolvePath: vi.fn().mockResolvedValue(resolvedPath),
        })),
      } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[0];
      const resolver = {
        isWithinWorkspace: vi.fn().mockReturnValue(false),
      } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[1];
      const dependencyAnalyzer = new SpiderDependencyAnalyzer(
        languageService,
        resolver,
        new Cache({ maxSize: 100 }),
        { isEnabled: () => false } as never,
      );

      await expect(dependencyAnalyzer.analyze('/workspace/app.ts')).resolves.toEqual([]);
      expect(resolver.isWithinWorkspace).toHaveBeenCalledWith(resolvedPath);
    });
  });
});
