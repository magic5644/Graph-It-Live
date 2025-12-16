import { Cache } from './Cache';
import type { Dependency, SymbolDependency, SymbolInfo } from './types';
import { normalizePath } from './types';
import { ReverseIndexManager } from './ReverseIndexManager';

type SymbolGraph = { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };

/**
 * Keeps dependency cache, symbol cache, and reverse index consistent.
 * Single responsibility: cache/index coherence when files change.
 */
export class SpiderCacheCoordinator {
  constructor(
    private readonly dependencyCache: Cache<Dependency[]>,
    private readonly symbolCache: Cache<SymbolGraph>,
    private readonly reverseIndexManager: ReverseIndexManager
  ) {}

  clearAll(): void {
    this.dependencyCache.clear();
    this.symbolCache.clear();
    this.reverseIndexManager.clear();
  }

  invalidateFile(filePath: string): boolean {
    const normalized = normalizePath(filePath);
    const wasInCache = this.dependencyCache.has(normalized);

    this.dependencyCache.delete(normalized);
    this.symbolCache.delete(normalized);
    this.reverseIndexManager.removeDependenciesFromSource(normalized);

    return wasInCache;
  }

  invalidateFiles(filePaths: string[]): number {
    let invalidatedCount = 0;
    for (const filePath of filePaths) {
      if (this.invalidateFile(filePath)) {
        invalidatedCount++;
      }
    }
    return invalidatedCount;
  }

  handleFileDeleted(filePath: string): void {
    const normalized = normalizePath(filePath);
    this.dependencyCache.delete(normalized);
    this.symbolCache.delete(normalized);
    this.reverseIndexManager.removeDependenciesFromSource(normalized);
  }
}

