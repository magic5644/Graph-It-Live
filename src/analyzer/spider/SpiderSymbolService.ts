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
      this.symbolCache.set(key, result);
      return result;
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
}

