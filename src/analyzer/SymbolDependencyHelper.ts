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
   */
  async doesDependencyTargetFile(
    dep: import('./types').SymbolDependency,
    sourceFilePath: string,
    targetFilePath: string
  ): Promise<boolean> {
    if (dep.targetFilePath === targetFilePath) {
      return true;
    }
    const resolved = await this.resolveFn(sourceFilePath, dep.targetFilePath);
    return resolved === targetFilePath;
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
