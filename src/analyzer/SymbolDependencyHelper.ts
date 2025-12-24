import { normalizePath } from './types';
import { getLogger } from '../shared/logger';

const log = getLogger('SymbolDependencyHelper');

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
    
    log.debug(`Comparing: dep.targetFilePath='${normalizedDepTarget}' vs targetFilePath='${normalizedTarget}'`);
    
    if (normalizedDepTarget === normalizedTarget) {
      log.debug('✓ Direct match');
      return true;
    }
    
    // Fallback: try resolving if dep.targetFilePath is still a module specifier
    // (shouldn't happen if SpiderSymbolService resolves correctly, but defensive)
    log.debug(`Attempting fallback resolution for '${dep.targetFilePath}' from '${sourceFilePath}'`);
    const resolved = await this.resolveFn(sourceFilePath, dep.targetFilePath);
    if (resolved) {
      const normalizedResolved = normalizePath(resolved);
      log.debug(`Resolved to: '${normalizedResolved}'`);
      const matches = normalizedResolved === normalizedTarget;
      log.debug(matches ? '✓ Fallback match' : '✗ No match after resolution');
      return matches;
    }
    
    log.debug('✗ Resolution failed, no match');
    return false;
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

  /**
   * Resolve a dependency's target path to an absolute path.
   * Returns normalized absolute path or null if resolution fails.
   * Used for batch processing optimization.
   */
  async resolveTargetPath(
    dep: import('./types').SymbolDependency,
    sourceFilePath: string
  ): Promise<string | null> {
    const normalizedDepTarget = normalizePath(dep.targetFilePath);
    
    // If already absolute, return as-is
    if (normalizedDepTarget.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedDepTarget)) {
      return normalizedDepTarget;
    }
    
    // Otherwise resolve module specifier
    try {
      const resolved = await this.resolveFn(sourceFilePath, dep.targetFilePath);
      return resolved ? normalizePath(resolved) : null;
    } catch {
      return null;
    }
  }
}
