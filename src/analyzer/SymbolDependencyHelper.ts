import { normalizePath } from './types';

export interface SymbolDependencyHelperOptions {
  resolve: (from: string, to: string) => Promise<string | null>;
}

/**
 * Helper to encapsulate symbol dependency comparisons and naming utilities.
 */
export class SymbolDependencyHelper {
  private readonly resolveFn: (from: string, to: string) => Promise<string | null>;

  constructor(options: SymbolDependencyHelperOptions) {
    this.resolveFn = options.resolve;
  }

  /**
   * Check if a dependency targets the given file path (normalized).
   * Both targetFilePath in the dependency and the targetFilePath parameter
   * should be normalized absolute paths for reliable comparison.
   */
  async doesDependencyTargetFile(
    dep: import('./types').SymbolDependency,
    sourceFilePath: string,
    targetFilePath: string
  ): Promise<boolean> {
    // Normalize both paths for cross-platform comparison (handles Windows vs Unix separators)
    const normalizedDepTarget = normalizePath(dep.targetFilePath);
    const normalizedTarget = normalizePath(targetFilePath);
    
    if (normalizedDepTarget === normalizedTarget) {
      return true;
    }
    
    // Fallback: try resolving if dep.targetFilePath is still a module specifier
    // (shouldn't happen if SpiderSymbolService resolves correctly, but defensive)
    const resolved = await this.resolveFn(sourceFilePath, dep.targetFilePath);
    return resolved ? normalizePath(resolved) === normalizedTarget : false;
  }

  extractSymbolName(symbolId: string): string {
    return symbolId.split(':').pop() || '';
  }

  extractBasename(filePath: string): string | undefined {
    return filePath.split(/[/\\]/).pop()?.replace(/\.[^/.]+$/, '');
  }

  /**
   * Normalize target symbol id for used-symbol tracking.
   */
  buildUsedSymbolId(targetFilePath: string, symbolName: string): string {
    return `${normalizePath(targetFilePath)}:${symbolName}`;
  }
}
