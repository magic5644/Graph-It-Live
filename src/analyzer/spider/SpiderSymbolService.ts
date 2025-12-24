import type { Dependency, SpiderConfig, SymbolDependency, SymbolInfo } from '../types';
import { SpiderError, normalizePath } from '../types';
import { getLogger } from '../../shared/logger';
import { Cache } from '../Cache';
import { FileReader } from '../FileReader';
import { PathResolver } from '../PathResolver';
import { AstWorkerHost } from '../AstWorkerHost';
import { SymbolDependencyHelper } from '../SymbolDependencyHelper';
import { isInIgnoredDirectory } from '../utils/PathPredicates';

const log = getLogger('SpiderSymbolService');

type SymbolGraph = { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };

export type ReferencingFilesProvider = (targetPath: string) => Promise<Dependency[]>;

/**
 * Single responsibility: symbol-level analysis/features built on top of file analysis
 * (drill-down, unused exports, dependents, execution tracing).
 */
export class SpiderSymbolService {
  constructor(
    private readonly astWorkerHost: AstWorkerHost,
    private readonly symbolCache: Cache<SymbolGraph>,
    private readonly fileReader: FileReader,
    private readonly resolver: PathResolver,
    private readonly symbolDependencyHelper: SymbolDependencyHelper,
    private readonly getConfig: () => SpiderConfig,
    private readonly findReferencingFiles: ReferencingFilesProvider
  ) {}

  async getSymbolGraph(filePath: string): Promise<SymbolGraph> {
    if (!filePath.startsWith('/') && !/^[a-zA-Z]:\//.test(filePath)) {
      try {
        const maybeResolved = await this.resolveModuleSpecifier(this.getConfig().rootDir, filePath);
        if (maybeResolved) {
          filePath = maybeResolved;
        }
      } catch {
        // ignore
      }
    }

    const key = normalizePath(filePath);
    const cached = this.symbolCache.get(key);
    if (cached) {
      return cached;
    }

    try {
      const content = await this.fileReader.readFile(filePath);
      const result = await this.astWorkerHost.analyzeFile(key, content);
      
      // Resolve targetFilePath in dependencies from module specifier to absolute path
      // This is critical for cross-platform path comparison in verifyDependencyUsage
      const resolvedDependencies = await Promise.all(
        result.dependencies.map(async (dep) => {
          try {
            const resolved = await this.resolver.resolve(key, dep.targetFilePath);
            if (resolved) {
              return {
                ...dep,
                targetFilePath: normalizePath(resolved),
              };
            }
          } catch {
            // If resolution fails, keep original module specifier
          }
          return dep;
        })
      );

      const resolvedResult = {
        symbols: result.symbols,
        dependencies: resolvedDependencies,
      };
      
      this.symbolCache.set(key, resolvedResult);
      return resolvedResult;
    } catch (error) {
      const spiderError = SpiderError.fromError(error, filePath);
      log.error('Symbol analysis failed:', spiderError.toUserMessage());
      if (spiderError.isRecoverable()) {
        return { symbols: [], dependencies: [] };
      }
      throw spiderError;
    }
  }

  async findUnusedSymbols(filePath: string): Promise<SymbolInfo[]> {
    try {
      const normalizedTarget = normalizePath(filePath);
      const { symbols } = await this.getSymbolGraph(normalizedTarget);
      const exportedSymbols = symbols.filter((s) => s.isExported);
      if (exportedSymbols.length === 0) {
        return [];
      }

      const referencingFiles = await this.findReferencingFiles(normalizedTarget);
      const usedSymbolIds = await this.collectUsedSymbolIds(referencingFiles, normalizedTarget);

      const content = await this.fileReader.readFile(normalizedTarget);
      const internalGraph = await this.astWorkerHost.getInternalExportDependencyGraph(normalizedTarget, content);
      const usedWithClosure = this.expandUsedSymbolsViaInternalGraph(usedSymbolIds, internalGraph);

      return exportedSymbols.filter((s) => !usedWithClosure.has(s.id));
    } catch (error) {
      const spiderError = SpiderError.fromError(error, filePath);
      log.error('Find unused symbols failed:', spiderError.toUserMessage());
      return [];
    }
  }

  async getSymbolDependents(filePath: string, symbolName: string): Promise<SymbolDependency[]> {
    const referencingFiles = await this.findReferencingFiles(filePath);
    return this.collectSymbolDependents(referencingFiles, filePath, symbolName);
  }

  async traceFunctionExecution(
    filePath: string,
    symbolName: string,
    maxDepth: number = 10
  ): Promise<{
    rootSymbol: { id: string; filePath: string; symbolName: string };
    callChain: Array<{
      depth: number;
      callerSymbolId: string;
      calledSymbolId: string;
      calledFilePath: string;
      resolvedFilePath: string | null;
    }>;
    visitedSymbols: string[];
    maxDepthReached: boolean;
  }> {
    const rootId = `${filePath}:${symbolName}`;
    const callChain: Array<{
      depth: number;
      callerSymbolId: string;
      calledSymbolId: string;
      calledFilePath: string;
      resolvedFilePath: string | null;
    }> = [];
    const visitedSymbols = new Set<string>();
    let maxDepthReached = false;

    const trace = async (currentFilePath: string, currentSymbolName: string, depth: number): Promise<void> => {
      if (depth > maxDepth) {
        maxDepthReached = true;
        return;
      }

      const currentId = `${currentFilePath}:${currentSymbolName}`;
      if (visitedSymbols.has(currentId)) {
        return;
      }
      visitedSymbols.add(currentId);

      try {
        const { symbols, dependencies } = await this.getSymbolGraph(currentFilePath);
        const currentSymbol = symbols.find((s) => s.name === currentSymbolName);
        if (!currentSymbol) return;

        const symbolDeps = dependencies.filter((d) => d.sourceSymbolId === currentSymbol.id);

        for (const dep of symbolDeps) {
          let resolvedFilePath: string | null = null;
          try {
            resolvedFilePath = await this.resolver.resolve(currentFilePath, dep.targetFilePath);
          } catch {
            // keep null
          }

          const targetSymbolName = dep.targetSymbolId.split(':').pop() || '';

          callChain.push({
            depth,
            callerSymbolId: currentId,
            calledSymbolId: dep.targetSymbolId,
            calledFilePath: dep.targetFilePath,
            resolvedFilePath,
          });

          if (resolvedFilePath && !isInIgnoredDirectory(resolvedFilePath)) {
            await trace(resolvedFilePath, targetSymbolName, depth + 1);
          }
        }
      } catch (error) {
        const spiderError = SpiderError.fromError(error, currentFilePath);
        log.error('Trace execution failed:', currentId, spiderError.toUserMessage());
      }
    };

    await trace(filePath, symbolName, 1);

    return {
      rootSymbol: { id: rootId, filePath, symbolName },
      callChain,
      visitedSymbols: Array.from(visitedSymbols),
      maxDepthReached,
    };
  }

  async resolveModuleSpecifier(fromFilePath: string, moduleSpecifier: string): Promise<string | null> {
    try {
      const resolved = await this.resolver.resolve(fromFilePath, moduleSpecifier);
      return resolved;
    } catch {
      return null;
    }
  }

  private expandUsedSymbolsViaInternalGraph(used: Set<string>, internalGraph: Map<string, Set<string>>): Set<string> {
    const expanded = new Set<string>(used);
    const queue: string[] = Array.from(expanded);

    while (queue.length > 0) {
      const current = queue.pop()!;
      const deps = internalGraph.get(current);
      if (!deps) continue;
      for (const dep of deps) {
        if (expanded.has(dep)) continue;
        expanded.add(dep);
        queue.push(dep);
      }
    }

    return expanded;
  }

  private async collectUsedSymbolIds(referencingFiles: Dependency[], targetFilePath: string): Promise<Set<string>> {
    const usedSymbolIds = new Set<string>();

    for (const ref of referencingFiles) {
      const { dependencies } = await this.getSymbolGraph(ref.path);

      for (const dep of dependencies) {
        const isMatch = await this.symbolDependencyHelper.doesDependencyTargetFile(dep, ref.path, targetFilePath);
        if (isMatch) {
          const symbolName = this.symbolDependencyHelper.extractSymbolName(dep.targetSymbolId);
          usedSymbolIds.add(this.symbolDependencyHelper.buildUsedSymbolId(targetFilePath, symbolName));
        }
      }
    }

    return usedSymbolIds;
  }

  private async collectSymbolDependents(
    referencingFiles: Dependency[],
    targetFilePath: string,
    symbolName: string
  ): Promise<SymbolDependency[]> {
    const dependents: SymbolDependency[] = [];
    const normalizedTarget = normalizePath(targetFilePath);

    for (const ref of referencingFiles) {
      const { dependencies } = await this.getSymbolGraph(ref.path);

      for (const dep of dependencies) {
        const isMatch = await this.symbolDependencyHelper.doesDependencyTargetFile(dep, ref.path, normalizedTarget);
        if (isMatch && this.symbolDependencyHelper.extractSymbolName(dep.targetSymbolId) === symbolName) {
          dependents.push(dep);
        }
      }
    }

    return dependents;
  }

  /**
   * Verify if a source file actually uses any symbol from a target file.
   * This is used to filter out unused imports from the graph.
   * 
   * OPTIMIZATION: Uses cached symbol graph when available to minimize AST parsing.
   */
  async verifyDependencyUsage(sourceFile: string, targetFile: string): Promise<boolean> {
    try {
      // Normalize paths for comparison
      const normalizedSource = normalizePath(sourceFile);
      const normalizedTarget = normalizePath(targetFile);
      
      // Early exit: if target is in node_modules or ignored directory, assume used
      if (isInIgnoredDirectory(normalizedTarget)) {
        return true;
      }
      
      // 1. Get AST-based symbol dependencies for the source file (cached)
      const { dependencies } = await this.getSymbolGraph(normalizedSource);
      
      if (dependencies.length === 0) {
        return false; // No dependencies at all
      }

      // 2. Check if any dependency points to the target file
      // OPTIMIZATION: Pre-filter by checking if targetFilePath contains the target basename
      // to avoid expensive path resolution for obviously unrelated dependencies
      const targetBasename = normalizedTarget.split('/').pop() || '';
      const candidateDeps = dependencies.filter(dep => 
        dep.targetFilePath === normalizedTarget || 
        dep.targetFilePath.includes(targetBasename) ||
        !dep.targetFilePath.startsWith('/')
      );

      for (const dep of candidateDeps) {
        // Use helper to resolve module specifier to absolute path and compare
        const isMatch = await this.symbolDependencyHelper.doesDependencyTargetFile(
            dep,
            normalizedSource,
            normalizedTarget
        );

        if (isMatch) {
          return true; // If we find at least one used symbol, the dependency is "used"
        }
      }

      return false;
    } catch (error) {
        // If analysis fails, assume used to be safe (avoid hiding potentially useful links)
        const spiderError = SpiderError.fromError(error, sourceFile);
        log.warn('Usage verification failed, assuming used:', spiderError.message);
        return true;
    }
  }

  /**
   * BATCH OPTIMIZATION: Verify multiple target files from the same source in one pass.
   * This is more efficient than calling verifyDependencyUsage() multiple times
   * because it only fetches the source's symbol graph once.
   * 
   * @param sourceFile - The source file to check
   * @param targetFiles - Array of target files to verify
   * @returns Map of targetFile -> isUsed
   */
  async verifyDependencyUsageBatch(sourceFile: string, targetFiles: string[]): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    
    try {
      const normalizedSource = normalizePath(sourceFile);
      
      // Get symbol graph once for all targets
      const { dependencies } = await this.getSymbolGraph(normalizedSource);
      
      if (dependencies.length === 0) {
        // No dependencies, all targets are unused
        for (const target of targetFiles) {
          results.set(target, false);
        }
        return results;
      }

      // Build a set of resolved target paths from dependencies
      const resolvedTargets = new Set<string>();
      for (const dep of dependencies) {
        try {
          const resolved = await this.symbolDependencyHelper.resolveTargetPath(dep, normalizedSource);
          if (resolved) {
            resolvedTargets.add(normalizePath(resolved));
          }
        } catch {
          // Ignore resolution errors
        }
      }

      // Check each target against the resolved set
      for (const target of targetFiles) {
        const normalizedTarget = normalizePath(target);
        
        // Early exit: if target is in ignored directory, assume used
        if (isInIgnoredDirectory(normalizedTarget)) {
          results.set(target, true);
          continue;
        }

        results.set(target, resolvedTargets.has(normalizedTarget));
      }
    } catch (error) {
      // On error, assume all used to be safe
      const spiderError = SpiderError.fromError(error, sourceFile);
      log.warn('Batch usage verification failed, assuming all used:', spiderError.message);
      for (const target of targetFiles) {
        results.set(target, true);
      }
    }

    return results;
  }
}

