import { FileReader } from '../FileReader';
import { ReferencingFilesFinder } from '../ReferencingFilesFinder';
import { ReverseIndexManager } from '../ReverseIndexManager';
import type { Dependency } from '../types';
import { normalizePath } from '../types';
import { SpiderDependencyAnalyzer } from './SpiderDependencyAnalyzer';

/**
 * Single responsibility: reverse dependency lookup (reverse index if available,
 * otherwise fallback scan).
 */
export class SpiderReferenceLookup {
  private fallbackFinder: ReferencingFilesFinder | null = null;

  /**
   * Cache for fallback scan results (used when reverse index is not populated).
   * Keyed by normalised target path. Invalidated as a whole whenever any file
   * in the project is modified (by incrementing `_fallbackCacheVersion`).
   * This prevents repeated O(n) full-project scans for each symbol-view
   * refresh while background indexing is still completing.
   */
  private readonly _fallbackCache = new Map<string, Dependency[]>();
  /**
   * Version counter – incremented on any file change so stale entries are
   * never served without being invalidated.
   */
  private _fallbackCacheVersion = 0;
  private readonly _fallbackCacheEntryVersion = new Map<string, number>();

  constructor(
    private readonly reverseIndexManager: ReverseIndexManager,
    private readonly dependencyAnalyzer: SpiderDependencyAnalyzer,
    private readonly fileReader: FileReader
  ) {}

  setFallbackFinder(finder: ReferencingFilesFinder): void {
    this.fallbackFinder = finder;
  }

  /**
   * Invalidate the fallback cache.  Should be called whenever any source file
   * is added, modified or deleted so that the next lookup re-scans if needed.
   */
  clearFallbackCache(): void {
    this._fallbackCacheVersion++;
  }

  async findReferencingFiles(targetPath: string): Promise<Dependency[]> {
    if (this.reverseIndexManager.hasEntries()) {
      return this.reverseIndexManager.getReferencingFiles(targetPath);
    }

    // Check fallback cache before doing an expensive O(n) project-wide scan
    const cachedVersion = this._fallbackCacheEntryVersion.get(targetPath);
    if (cachedVersion === this._fallbackCacheVersion) {
      const cached = this._fallbackCache.get(targetPath);
      if (cached !== undefined) {
        return cached;
      }
    }

    const result = this.fallbackFinder
      ? await this.fallbackFinder.findReferencingFilesFallback(targetPath)
      : [];

    this._fallbackCache.set(targetPath, result);
    this._fallbackCacheEntryVersion.set(targetPath, this._fallbackCacheVersion);
    return result;
  }

  async findReferenceInFile(
    filePath: string,
    targetPath: string,
    targetBasename: string
  ): Promise<Dependency | null> {
    try {
      const content = await this.fileReader.readFile(filePath);
      if (!content.includes(targetBasename)) {
        return null;
      }

      const dependencies = await this.dependencyAnalyzer.analyze(filePath);
      const matchingDep = dependencies.find((dep) => normalizePath(dep.path) === targetPath);

      if (!matchingDep) {
        return null;
      }

      return {
        path: normalizePath(filePath),
        type: matchingDep.type,
        line: matchingDep.line,
        module: matchingDep.module,
      };
    } catch {
      return null;
    }
  }
}
