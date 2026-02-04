import { ReverseIndex } from './ReverseIndex';
import { SymbolReverseIndex } from './SymbolReverseIndex';
import type { Dependency, FileHash, SymbolDependency } from './types';

/**
 * Encapsulates reverse index lifecycle and operations for Spider/MCP.
 */
export class ReverseIndexManager {
  private reverseIndex: ReverseIndex | null = null;
  private symbolReverseIndex: SymbolReverseIndex | null = null;

  constructor(private readonly rootDir: string) {}

  enable(serializedData?: string): boolean {
    let restored = false;
    this.reverseIndex ??= new ReverseIndex(this.rootDir);
    this.symbolReverseIndex ??= new SymbolReverseIndex(this.rootDir);

    if (serializedData) {
      try {
        const data = JSON.parse(serializedData);
        const restoredIndex = ReverseIndex.deserialize(data, this.rootDir);
        if (restoredIndex) {
          this.reverseIndex = restoredIndex;
          restored = true;
        }
      } catch {
        restored = false;
      }
    }

    return restored;
  }

  disable(): void {
    this.reverseIndex?.clear();
    this.reverseIndex = null;
    this.symbolReverseIndex?.clear();
    this.symbolReverseIndex = null;
  }

  clear(): void {
    this.reverseIndex?.clear();
    this.symbolReverseIndex?.clear();
  }

  isEnabled(): boolean {
    return this.reverseIndex !== null;
  }

  hasEntries(): boolean {
    return this.reverseIndex?.hasEntries() ?? false;
  }

  ensure(): void {
    this.reverseIndex ??= new ReverseIndex(this.rootDir);
  }

  addDependencies(sourcePath: string, dependencies: Dependency[], fileHash?: FileHash): void {
    this.reverseIndex?.addDependencies(sourcePath, dependencies, fileHash);
  }

  removeDependenciesFromSource(sourcePath: string): void {
    this.reverseIndex?.removeDependenciesFromSource(sourcePath);
  }

  getReferencingFiles(targetPath: string): Dependency[] {
    return this.reverseIndex ? this.reverseIndex.getReferencingFiles(targetPath) : [];
  }

  getCallerCount(targetPath: string): number {
    return this.reverseIndex ? this.reverseIndex.getCallerCount(targetPath) : 0;
  }

  getSerialized(): string | null {
    return this.reverseIndex ? JSON.stringify(this.reverseIndex.serialize()) : null;
  }

  validate(staleThreshold = 0.2) {
    return this.reverseIndex?.validateIndex(staleThreshold) ?? null;
  }

  getStats() {
    return this.reverseIndex?.getStats();
  }

  // ===========================
  // Symbol Reverse Index Methods
  // ===========================

  /**
   * Add symbol dependencies to the symbol reverse index
   */
  addSymbolDependencies(sourcePath: string, dependencies: SymbolDependency[], fileHash?: FileHash): void {
    this.symbolReverseIndex?.addDependencies(sourcePath, dependencies, fileHash);
  }

  /**
   * Remove symbol dependencies from a source file
   */
  removeSymbolDependenciesFromSource(sourcePath: string): void {
    this.symbolReverseIndex?.removeDependenciesFromSource(sourcePath);
  }

  /**
   * Get all files that reference a symbol
   * @param symbolId Symbol ID in format "filePath:symbolName"
   * @returns Array of file paths that import/reference the symbol
   */
  getSymbolReferencingFiles(symbolId: string): string[] {
    return this.symbolReverseIndex?.getCallerFiles(symbolId) ?? [];
  }

  /**
   * Get symbol reverse index stats
   */
  getSymbolStats() {
    return this.symbolReverseIndex?.getStats();
  }
}
