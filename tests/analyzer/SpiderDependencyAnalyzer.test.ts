import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpiderDependencyAnalyzer } from '../../src/analyzer/spider/SpiderDependencyAnalyzer';
import { SpiderError, SpiderErrorCode } from '../../src/analyzer/types';
import { Cache } from '../../src/analyzer/Cache';
import { normalizePath } from '../../src/shared/path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

describe('SpiderDependencyAnalyzer - reverse index file hashes', () => {
  /**
   * Regression: the analyzer used to bail out before recording a file hash when a
   * file had no dependencies. fileHashes is the "already analyzed" set, so those
   * files stayed indistinguishable from never-indexed ones — a restored index
   * looked massively incomplete and was rebuilt from scratch every time.
   */
  it('records a file hash for a file with no dependencies', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-nodeps-'));
    try {
      const filePath = path.join(tmpDir, 'leaf.ts');
      fs.writeFileSync(filePath, 'export const leaf = 1;\n');

      const addDependencies = vi.fn();
      const analyzer = makeAnalyzer(() => Promise.resolve([]));
      Object.assign(
        (analyzer as unknown as { reverseIndexManager: Record<string, unknown> }).reverseIndexManager,
        { isEnabled: () => true, addDependencies },
      );

      await analyzer.analyze(filePath);

      expect(addDependencies).toHaveBeenCalledWith(
        normalizePath(filePath),
        [],
        expect.objectContaining({ mtime: expect.any(Number), size: expect.any(Number) }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('SpiderDependencyAnalyzer - module resolution and cache invalidation', () => {
  function makeAnalyzerWithResolver(resolve: (from: string, spec: string) => Promise<string | null>) {
    const languageService = {
      getAnalyzer: vi.fn(() => ({ parseImports: () => Promise.resolve([]), resolvePath: vi.fn() })),
    } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[0];
    const resolver = { isWithinWorkspace: () => true, resolve } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[1];
    const cache = new Cache<never[]>({ maxSize: 10 });
    const reverseIndexManager = {
      isEnabled: () => false,
      addDependencies: vi.fn(),
    } as unknown as ConstructorParameters<typeof SpiderDependencyAnalyzer>[3];
    return {
      analyzer: new SpiderDependencyAnalyzer(languageService, resolver, cache as never, reverseIndexManager),
      cache,
    };
  }

  it('resolveModuleSpecifier returns the resolved path', async () => {
    const { analyzer } = makeAnalyzerWithResolver(() => Promise.resolve('/abs/target.ts'));

    await expect(analyzer.resolveModuleSpecifier('/abs/src.ts', './target')).resolves.toBe('/abs/target.ts');
  });

  it('resolveModuleSpecifier returns null when the resolver throws', async () => {
    const { analyzer } = makeAnalyzerWithResolver(() => Promise.reject(new Error('nope')));

    await expect(analyzer.resolveModuleSpecifier('/abs/src.ts', 'missing-pkg')).resolves.toBeNull();
  });

  it('invalidateDependencyCache drops the entry under its normalized key', () => {
    const { analyzer, cache } = makeAnalyzerWithResolver(() => Promise.resolve(null));
    const filePath = '/abs/src/a.ts';
    cache.set(normalizePath(filePath), [] as never[]);

    analyzer.invalidateDependencyCache(filePath);

    expect(cache.get(normalizePath(filePath))).toBeUndefined();
  });
});
