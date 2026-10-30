import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS } from '../../shared/constants';
import { getLogger } from '../../shared/logger';
import { AstWorkerHost } from '../ast/AstWorkerHost';
import { Cache } from '../Cache';
import { FileReader } from '../FileReader';
import { LanguageService } from '../LanguageService';
import { SourceFileCollector } from '../SourceFileCollector';
import { SymbolDependencyHelper } from '../SymbolDependencyHelper';
import type { Dependency, SpiderConfig, SymbolDependency, SymbolInfo } from '../types';
import { SpiderError, SpiderErrorCode, normalizePath } from '../types';
import { isInIgnoredDirectory } from '../utils/PathPredicates';
import { PathResolver } from '../utils/PathResolver';
import { importBindings, namespaceUse, type ImportBinding, type NamespaceUse } from '../utils/namespaceUsage';
import { mayReExport, parseNamespaceReExports, parseReExports, type ReExport, type ReExportTarget } from '../utils/reExports';

const log = getLogger('SpiderSymbolService');

type SymbolGraph = { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };

const SYMBOL_ANALYSIS_EXTENSIONS: ReadonlySet<string> = new Set(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS);

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
    private readonly findReferencingFiles: ReferencingFilesProvider,
    private readonly languageService: LanguageService
  ) {}

  async getSymbolGraph(filePath: string): Promise<SymbolGraph> {
    if (!path.isAbsolute(filePath)) {
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
    // The AST worker parses every non-Python/Rust file with ts-morph, so other
    // languages (Go, C#, Java...) would yield bogus TypeScript symbols.
    if (this.isAstUnsupportedFile(key)) {
      return { symbols: [], dependencies: [] };
    }
    const cached = this.symbolCache.get(key);
    if (cached) {
      return cached;
    }

    try {
      const content = await this.fileReader.readFile(filePath);
      const result = await this.astWorkerHost.analyzeFile(key, content);
      
      // Resolve targetFilePath in dependencies from module specifier to absolute path
      // This is critical for cross-platform path comparison in verifyDependencyUsage
      // Use language-specific resolver (Python, TypeScript, etc.)
      const resolvedDependencies = await Promise.all(
        result.dependencies.map(async (dep) => {
          try {
            // Get language-specific analyzer
            const analyzer = this.languageService.getAnalyzer(key);
            const resolved = await analyzer.resolvePath(key, dep.targetFilePath);
            if (resolved) {
              const targetFilePath = normalizePath(resolved);
              const symbolName = this.symbolDependencyHelper.extractSymbolName(dep.targetSymbolId);
              return {
                ...dep,
                targetFilePath,
                targetSymbolId: this.symbolDependencyHelper.buildUsedSymbolId(targetFilePath, symbolName),
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
      await this.addSymbolsUsedThroughBarrels(normalizedTarget, exportedSymbols, referencingFiles, usedSymbolIds);

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

  /**
   * A consumer behind a barrel targets the barrel's id, never the declaring file's. Marks each
   * exported symbol used when any `(barrel, name)` alias of it, or a namespace re-export of the
   * whole file (`export * as ns`), is imported by a file other than the barrel itself.
   * A namespace alias credits only the members its consumers access (`ns.name`); a use of the
   * namespace as a whole credits every member, so live code is never reported.
   */
  private async addSymbolsUsedThroughBarrels(
    target: string,
    exportedSymbols: SymbolInfo[],
    referencingFiles: Dependency[],
    usedSymbolIds: Set<string>
  ): Promise<void> {
    if (referencingFiles.length === 0) return;

    const namespaceAliases = await this.collectNamespaceAliases(referencingFiles, target);
    const namespaceUses = await Promise.all(namespaceAliases.map((alias) => this.collectNamespaceUse(alias)));
    const usageByFile = new Map<string, Promise<Set<string>>>();
    const parsedReExports = new Map<string, Promise<ReExport[]>>();
    const isImported = async (alias: ReExportTarget): Promise<boolean> => {
      let usage = usageByFile.get(alias.filePath);
      if (!usage) {
        usage = this.findReferencingFiles(alias.filePath).then((refs) => this.collectUsedSymbolIds(refs, alias.filePath));
        usageByFile.set(alias.filePath, usage);
      }
      return (await usage).has(this.symbolDependencyHelper.buildUsedSymbolId(alias.filePath, alias.name));
    };

    for (const symbol of exportedSymbols) {
      if (usedSymbolIds.has(symbol.id)) continue;
      const chain = await this.collectReexportAliases(target, symbol.name, parsedReExports); // NOSONAR S9382 sequential: shares the parse memo
      const candidates = chain.filter((alias) => alias.filePath !== target);
      const used = await Promise.all(candidates.map(isImported));
      if (used.some(Boolean) || namespaceUses.some((use) => use.escapes || use.members.has(symbol.name))) {
        usedSymbolIds.add(symbol.id);
      }
    }
  }

  /** Merged use of the namespace object `alias` across every file that imports it. */
  private async collectNamespaceUse(alias: ReExportTarget): Promise<NamespaceUse> {
    const merged: NamespaceUse = { members: new Set(), escapes: false };
    for (const ref of await this.findReferencingFiles(alias.filePath)) {
      let content: string;
      try {
        content = await this.fileReader.readFile(ref.path); // NOSONAR S9382 sequential: one read per importer
      } catch {
        continue;
      }
      for (const binding of importBindings(ref.path, content)) {
        const use = await this.namespaceUseOfBinding(binding, ref.path, content, alias); // NOSONAR S9382 sequential: resolver results are cached
        if (!use) continue;
        for (const member of use.members) merged.members.add(member);
        merged.escapes ||= use.escapes;
      }
    }
    return merged;
  }

  /** Use of `alias` through one import binding of `fromPath`, or null when the binding is unrelated. */
  private async namespaceUseOfBinding(
    binding: ImportBinding,
    fromPath: string,
    content: string,
    alias: ReExportTarget
  ): Promise<NamespaceUse | null> {
    if (binding.imported !== alias.name && binding.imported !== '*') return null;
    const resolved = await this.resolveModuleSpecifier(fromPath, binding.specifier);
    if (!resolved || normalizePath(resolved) !== alias.filePath) return null;
    // `import * as b` reaches the namespace as `b.ns`, which is not followed: treat it as a whole use.
    if (binding.imported === '*') return { members: new Set(), escapes: true };
    return namespaceUse(fromPath, content, binding.local);
  }

  /** `export * as ns from target` in each barrel, plus the barrels that re-export `ns` onwards. */
  private async collectNamespaceAliases(barrels: Dependency[], target: string): Promise<ReExportTarget[]> {
    const found = new Map<string, ReExportTarget>();
    for (const barrel of barrels) {
      const barrelPath = normalizePath(barrel.path);
      let namespaces: ReturnType<typeof parseNamespaceReExports>;
      try {
        namespaces = parseNamespaceReExports(barrelPath, await this.fileReader.readFile(barrelPath)); // NOSONAR S9382 sequential: one read per importer
      } catch {
        continue;
      }
      for (const { specifier, alias } of namespaces) {
        const resolved = await this.resolveModuleSpecifier(barrelPath, specifier); // NOSONAR S9382 sequential: resolver results are cached
        if (!resolved || normalizePath(resolved) !== target) continue;
        for (const onward of await this.collectReexportAliases(barrelPath, alias)) { // NOSONAR S9382 sequential: BFS shares its visited map
          found.set(`${onward.filePath}:${onward.name}`, onward);
        }
      }
    }
    return [...found.values()];
  }

  async getSymbolDependents(filePath: string, symbolName: string): Promise<SymbolDependency[]> {
    // A consumer behind a barrel targets the barrel's id, so each re-export alias is searched too.
    const dependents = new Map<string, SymbolDependency>();
    for (const alias of await this.collectReexportAliases(filePath, symbolName)) {
      const referencingFiles = await this.findReferencingFiles(alias.filePath); // NOSONAR S9382 sequential: shared dependents map
      // A file never references itself, yet its other symbols can call the target.
      const sourcePaths = [alias.filePath, ...referencingFiles.map((ref) => ref.path)];
      for (const dep of await this.collectSymbolDependents(sourcePaths, alias.filePath, alias.name)) { // NOSONAR S9382 sequential
        dependents.set(normalizePath(dep.sourceSymbolId), dep);
      }
    }
    return [...dependents.values()];
  }

  /**
   * The symbol itself plus every `(barrel, name)` that re-exports it, through any number of
   * barrels. A visited set stops barrel cycles; a barrel that cannot be read or resolved is skipped.
   */
  private async collectReexportAliases(
    filePath: string,
    symbolName: string,
    parsedReExports = new Map<string, Promise<ReExport[]>>()
  ): Promise<ReExportTarget[]> {
    const root = { filePath: normalizePath(filePath), name: symbolName };
    const aliases = new Map<string, ReExportTarget>([[`${root.filePath}:${root.name}`, root]]);
    const queue = [root];
    for (let current = queue.pop(); current; current = queue.pop()) {
      const referencing = await this.findReferencingFiles(current.filePath); // NOSONAR S9382 BFS queue
      // A barrel may also be a plain importer (`import { x } from; export { x }`), so every referencer is read.
      for (const importer of referencing) {
        for (const alias of await this.reexportedAs(importer.path, current, parsedReExports)) { // NOSONAR S9382 BFS queue
          const key = `${alias.filePath}:${alias.name}`;
          if (aliases.has(key)) continue;
          aliases.set(key, alias);
          queue.push(alias);
        }
      }
    }
    return [...aliases.values()];
  }

  /** Names under which `barrelPath` re-exports `target`. */
  private async reexportedAs(
    barrelPath: string,
    target: ReExportTarget,
    parsedReExports: Map<string, Promise<ReExport[]>>
  ): Promise<ReExportTarget[]> {
    const barrel = normalizePath(barrelPath);
    let reExports: ReExport[];
    try {
      let parsed = parsedReExports.get(barrel);
      if (!parsed) {
        // Most referencers are plain importers: skip the parse unless the text can hold a re-export.
        parsed = this.fileReader.readFile(barrel).then((content) => (mayReExport(content) ? parseReExports(barrel, content) : []));
        parsedReExports.set(barrel, parsed);
      }
      reExports = await parsed; // NOSONAR S9382 sequential: parsed once per file, then memoised
    } catch {
      return [];
    }
    const found: ReExportTarget[] = [];
    for (const { specifier, names } of reExports) {
      const resolved = await this.resolveModuleSpecifier(barrel, specifier); // NOSONAR S9382 sequential: resolver results are cached
      if (!resolved || normalizePath(resolved) !== target.filePath) continue;
      if (names === 'all') {
        // `export *` never re-exports `default`.
        if (target.name !== 'default') found.push({ filePath: barrel, name: target.name });
        continue;
      }
      for (const { imported, exported } of names) {
        if (imported === target.name) found.push({ filePath: barrel, name: exported });
      }
    }
    return found;
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

        // Type-only references do not execute; repeated call sites add no new edge.
        const seenTargets = new Set<string>();
        const symbolDeps = dependencies.filter((d) => {
          if (d.sourceSymbolId !== currentSymbol.id || d.isTypeOnly || seenTargets.has(d.targetSymbolId)) {
            return false;
          }
          seenTargets.add(d.targetSymbolId);
          return true;
        });

        for (const dep of symbolDeps) {
          let resolvedFilePath: string | null = null;
          if (path.isAbsolute(dep.targetFilePath)) {
            // getSymbolGraph already resolved it; re-resolving treats absolute paths as node_modules.
            resolvedFilePath = dep.targetFilePath;
          } else {
            try {
              resolvedFilePath = await this.resolver.resolve(currentFilePath, dep.targetFilePath);
            } catch {
              // keep null
            }
          }

          const targetSymbolName = this.symbolDependencyHelper.extractSymbolName(dep.targetSymbolId);

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
      const current = queue.pop();
      if (current === undefined) continue;
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
    sourcePaths: string[],
    targetFilePath: string,
    symbolName: string
  ): Promise<SymbolDependency[]> {
    // Keyed by source symbol so each dependent is listed once, whatever the edge source.
    const dependents = new Map<string, SymbolDependency>();
    const normalizedTarget = normalizePath(targetFilePath);
    const targetSymbolId = this.symbolDependencyHelper.buildUsedSymbolId(normalizedTarget, symbolName);

    for (const sourcePath of sourcePaths) {
      const { dependencies } = await this.getSymbolGraph(sourcePath);

      for (const dep of dependencies) {
        const sourceSymbolId = normalizePath(dep.sourceSymbolId);
        // A recursive call does not make the symbol its own dependent.
        if (sourceSymbolId === targetSymbolId || dependents.has(sourceSymbolId)) continue;
        if (this.symbolDependencyHelper.extractSymbolName(dep.targetSymbolId) !== symbolName) continue;
        if (await this.symbolDependencyHelper.doesDependencyTargetFile(dep, sourcePath, normalizedTarget)) {
          dependents.set(sourceSymbolId, dep);
        }
      }
    }

    return [...dependents.values()];
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
      
      // GraphQL, C#, Go, and Java files don't support AST-based symbol analysis here, so skip verification
      // These languages may still use tree-sitter for file-level imports, but without AST-based symbol verification all imports are considered used
      if (this.isAstUnsupportedFile(normalizedSource)) {
        log.debug(`Skipping symbol analysis for unsupported file type: ${normalizedSource}`);
        return true; // Without AST-based symbol verification, conservatively treat all imports as used
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
    try {
      const normalizedSource = normalizePath(sourceFile);
      
      // GraphQL, C#, Go, and Java files don't support AST symbol analysis - all imports are considered used
      if (this.isAstUnsupportedFile(normalizedSource)) {
        log.debug(`Skipping symbol analysis for unsupported file type: ${normalizedSource}`);
        return this.markAllAsUsed(targetFiles);
      }
      
      // Get symbol graph once for all targets
      const { dependencies } = await this.getSymbolGraph(normalizedSource);
      
      if (dependencies.length === 0) {
        return this.markAllAsUnused(targetFiles);
      }

      // Build resolved target paths set
      const resolvedTargets = await this.buildResolvedTargetsSet(dependencies, normalizedSource);

      // Check each target against the resolved set
      return this.checkTargetsAgainstResolved(targetFiles, resolvedTargets);
    } catch (error) {
      // On error, assume all used to be safe
      const spiderError = SpiderError.fromError(error, sourceFile);
      log.warn('Batch usage verification failed, assuming all used:', spiderError.message);
      return this.markAllAsUsed(targetFiles);
    }
  }

  private markAllAsUsed(targetFiles: string[]): Map<string, boolean> {
    const results = new Map<string, boolean>();
    for (const target of targetFiles) {
      results.set(normalizePath(target), true);
    }
    return results;
  }

  private markAllAsUnused(targetFiles: string[]): Map<string, boolean> {
    const results = new Map<string, boolean>();
    for (const target of targetFiles) {
      results.set(normalizePath(target), false);
    }
    return results;
  }

  private async buildResolvedTargetsSet(
    dependencies: SymbolDependency[],
    normalizedSource: string
  ): Promise<Set<string>> {
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
    return resolvedTargets;
  }

  private checkTargetsAgainstResolved(
    targetFiles: string[],
    resolvedTargets: Set<string>
  ): Map<string, boolean> {
    const results = new Map<string, boolean>();
    for (const target of targetFiles) {
      const normalizedTarget = normalizePath(target);
      
      // Early exit: if target is in ignored directory, assume used
      if (isInIgnoredDirectory(normalizedTarget)) {
        results.set(normalizedTarget, true);
        continue;
      }

      results.set(normalizedTarget, resolvedTargets.has(normalizedTarget));
    }
    return results;
  }

  /**
   * Check if a file is NOT supported by the AST worker for symbol analysis.
   * The AST worker only handles TypeScript/JavaScript, Python, and Rust.
   * Other languages (C#, Go, Java, GraphQL...) use file-level parsers only —
   * symbol-level verification would always return empty dependencies, causing
   * all of their imports to be incorrectly marked as unused.
   */
  private isAstUnsupportedFile(filePath: string): boolean {
    return !SYMBOL_ANALYSIS_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Workspace-wide dead code scan
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Scan all files under `scopePath` for unused exported symbols.
   *
   * @param scopePath - Absolute path to a directory (or file) to scope the
   *   scan.  Must be inside the workspace root (caller is responsible for
   *   validating this).
   * @param options.maxFiles - Hard cap on files analysed (default: 500).
   * @param options.hasReverseIndex - Whether the reverse index is available.
   *   If false, throws INDEX_NOT_READY — we never fall back to O(n²) lookups.
   * @param options.signal - Aborts the scan between files.
   * @returns Array of { filePath, unusedSymbols } entries (only files that
   *   have at least one unused export are included).
   */
  async scanDeadCode(
    scopePath: string,
    options: { maxFiles?: number; hasReverseIndex: boolean; signal?: AbortSignal }
  ): Promise<{ entries: Array<{ filePath: string; unusedSymbols: SymbolInfo[] }>; scannedFiles: number; skippedFiles: number; filesBeyondLimit: number }> {
    const { maxFiles = 500, hasReverseIndex, signal } = options;

    if (!hasReverseIndex) {
      throw new SpiderError(
        'Dead code scan requires the reverse index. Wait for indexing to complete or call rebuild_index first.',
        SpiderErrorCode.INDEX_NOT_READY,
      );
    }

    const config = this.getConfig();
    const collector = new SourceFileCollector({
      excludeNodeModules: config.excludeNodeModules ?? true,
    });

    // Collect all source files under scopePath
    const allFiles = await collector.collectAllSourceFiles(scopePath);

    // Filter to files supported by the symbol analyser
    const analysableFiles = allFiles.filter((f) => !this.isAstUnsupportedFile(f));

    // Apply hard cap
    const filesToScan = analysableFiles.slice(0, maxFiles);

    const entries: Array<{ filePath: string; unusedSymbols: SymbolInfo[] }> = [];
    let skippedFiles = 0;

    for (const filePath of filesToScan) {
      if (signal) {
        // Yield to the event loop so a pending cancel message can abort the signal.
        await setImmediate(); // NOSONAR S9382: one yield per file is the cancellation point
        signal.throwIfAborted();
      }
      try {
        const unusedSymbols = await this.findUnusedSymbols(filePath);
        if (unusedSymbols.length > 0) {
          entries.push({ filePath, unusedSymbols });
        }
      } catch (error) {
        // Per-file errors are silently skipped so the batch continues.
        const spiderError = SpiderError.fromError(error, filePath);
        log.warn('scanDeadCode: skipping file due to error:', filePath, spiderError.message);
        skippedFiles++;
      }
    }

    return {
      entries,
      scannedFiles: filesToScan.length,
      skippedFiles,
      filesBeyondLimit: analysableFiles.length - filesToScan.length,
    };
  }
}
