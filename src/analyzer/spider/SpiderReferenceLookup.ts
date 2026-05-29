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
    private readonly fileReader: FileReader,
    private readonly isIndexReady: () => boolean = () => true,
    private readonly isIndexingActive: () => boolean = () => false
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
    const normalizedTargetPath = normalizePath(targetPath);
    const hasReverseIndexEntries = this.reverseIndexManager.hasEntries();

    if (hasReverseIndexEntries && this.isIndexReady()) {
      return this.reverseIndexManager.getReferencingFiles(normalizedTargetPath);
    }

    const indexedResults = hasReverseIndexEntries
      ? this.reverseIndexManager.getReferencingFiles(normalizedTargetPath)
      : [];

    // If index has entries but indexing is not currently running, prefer
    // indexed results as authoritative to preserve deterministic MCP semantics
    // (only analyzed files contribute references).
    if (hasReverseIndexEntries && !this.isIndexingActive()) {
      return indexedResults;
    }

    if (!this.fallbackFinder) {
      return indexedResults;
    }

    const fallbackResults = await this.getFallbackReferencingFiles(normalizedTargetPath);
    if (indexedResults.length === 0) {
      return fallbackResults;
    }
    if (fallbackResults.length === 0) {
      return indexedResults;
    }

    return this.mergeDependencies(indexedResults, fallbackResults);
  }

  private async getFallbackReferencingFiles(normalizedTargetPath: string): Promise<Dependency[]> {
    if (!this.fallbackFinder) {
      return [];
    }

    // Check fallback cache before doing an expensive O(n) project-wide scan
    const cachedVersion = this._fallbackCacheEntryVersion.get(normalizedTargetPath);
    if (cachedVersion === this._fallbackCacheVersion) {
      const cached = this._fallbackCache.get(normalizedTargetPath);
      if (cached !== undefined) {
        return cached;
      }
    }

    const result = await this.fallbackFinder.findReferencingFilesFallback(normalizedTargetPath);

    this._fallbackCache.set(normalizedTargetPath, result);
    this._fallbackCacheEntryVersion.set(normalizedTargetPath, this._fallbackCacheVersion);
    return result;
  }

  private mergeDependencies(primary: Dependency[], secondary: Dependency[]): Dependency[] {
    const merged = new Map<string, Dependency>();

    for (const dependency of [...primary, ...secondary]) {
      const key = normalizePath(dependency.path);
      if (!merged.has(key)) {
        merged.set(key, dependency);
      }
    }

    return [...merged.values()];
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
