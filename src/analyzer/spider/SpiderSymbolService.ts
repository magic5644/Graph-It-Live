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
import type { Dependency, ReferencingFile, SpiderConfig, SymbolDependency, SymbolInfo } from '../types';
import { SpiderError, SpiderErrorCode, normalizePath } from '../types';
import { isInIgnoredDirectory } from '../utils/PathPredicates';
import { PathResolver } from '../utils/PathResolver';
import { importBindings, namespaceUse, type ImportBinding, type NamespaceUse } from '../utils/namespaceUsage';
import { extractFilePath } from '../utils/PathExtractor';
import { isPythonOrRust, namesModule, pythonStarExports, readImportBindings } from '../utils/pyRsImports';
import { readModuleReExports, type ModuleReExports, type ReExportTarget } from '../utils/reExports';

const log = getLogger('SpiderSymbolService');

type SymbolGraph = { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };

const SYMBOL_ANALYSIS_EXTENSIONS: ReadonlySet<string> = new Set(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS);

export type ReferencingFilesProvider = (targetPath: string) => Promise<Dependency[]>;

/** Per-file re-exports read once; shared by every target of a scan. */
type ReExportMemo = Map<string, Promise<ModuleReExports>>;

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

  /** `reExportMemo` lets a workspace scan read each file's re-exports once across all its targets. */
  async findUnusedSymbols(filePath: string, reExportMemo: ReExportMemo = new Map()): Promise<SymbolInfo[]> {
    try {
      const normalizedTarget = normalizePath(filePath);
      const { symbols } = await this.getSymbolGraph(normalizedTarget);
      const exportedSymbols = symbols.filter((s) => s.isExported);
      if (exportedSymbols.length === 0) {
        return [];
      }

      const referencingFiles = await this.findReferencingFiles(normalizedTarget);
      const usedSymbolIds = await this.collectUsedSymbolIds(referencingFiles, normalizedTarget);
      await this.addSymbolsUsedThroughBarrels(normalizedTarget, exportedSymbols, referencingFiles, usedSymbolIds, reExportMemo);

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
    usedSymbolIds: Set<string>,
    reExportMemo: ReExportMemo
  ): Promise<void> {
    // Most files are only imported by plain consumers: nothing to follow unless a referencer re-exports.
    const modules = await Promise.all(referencingFiles.map((ref) => this.moduleReExports(ref.path, reExportMemo)));
    if (modules.every((m) => m.reExports.length === 0 && m.namespaces.length === 0)) return;

    const namespaceAliases = await this.collectNamespaceAliases(modules, target, reExportMemo);
    const namespaceUses = await Promise.all(namespaceAliases.map((alias) => this.collectNamespaceUse(alias)));
    const usageByFile = new Map<string, Promise<Set<string>>>();
    const isImported = async (alias: ReExportTarget): Promise<boolean> => {
      let usage = usageByFile.get(alias.filePath);
      if (!usage) {
        usage = this.findReferencingFiles(alias.filePath).then((refs) => this.collectUsedSymbolIds(refs, alias.filePath));
        usageByFile.set(alias.filePath, usage);
      }
      return (await usage).has(this.symbolDependencyHelper.buildUsedSymbolId(alias.filePath, alias.name));
    };

    const unusedSymbols = exportedSymbols.filter((symbol) => !usedSymbolIds.has(symbol.id));
    const throughBarrel = await Promise.all(
      unusedSymbols.map(async (symbol) => {
        const chain = await this.collectReexportAliases(target, symbol.name, reExportMemo, true);
        const used = await Promise.all(chain.filter((alias) => alias.filePath !== target).map(isImported));
        return used.some(Boolean) || namespaceUses.some((use) => use.escapes || use.members.has(symbol.name));
      })
    );
    unusedSymbols.forEach((symbol, i) => {
      if (throughBarrel[i]) usedSymbolIds.add(symbol.id);
    });
  }

  /** Merged use of the namespace object `alias` across every file that imports it. */
  private async collectNamespaceUse(alias: ReExportTarget): Promise<NamespaceUse> {
    const refs = await this.findReferencingFiles(alias.filePath);
    const perFile = await Promise.all(refs.map((ref) => this.namespaceUseInFile(ref.path, alias)));
    const merged: NamespaceUse = { members: new Set(), escapes: false };
    for (const use of perFile.flat()) {
      for (const member of use.members) merged.members.add(member);
      merged.escapes ||= use.escapes;
    }
    return merged;
  }

  /** Uses of `alias` through each import binding of one file; an unreadable file has none. */
  private async namespaceUseInFile(filePath: string, alias: ReExportTarget): Promise<NamespaceUse[]> {
    let content: string;
    try {
      content = await this.fileReader.readFile(filePath);
    } catch {
      return [];
    }
    const uses = await Promise.all(
      importBindings(filePath, content).map((binding) => this.namespaceUseOfBinding(binding, filePath, content, alias))
    );
    return uses.filter((use): use is NamespaceUse => use !== null);
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
  private async collectNamespaceAliases(
    modules: Array<ModuleReExports & { path: string }>,
    target: string,
    reExportMemo: ReExportMemo
  ): Promise<ReExportTarget[]> {
    const declared = modules.flatMap(({ path: barrelPath, namespaces }) =>
      namespaces.map(({ specifier, alias }) => ({ barrelPath, specifier, alias }))
    );
    const chains = await Promise.all(
      declared.map(async ({ barrelPath, specifier, alias }) => {
        const resolved = await this.resolveModuleSpecifier(barrelPath, specifier);
        if (!resolved || normalizePath(resolved) !== target || !namesModule(specifier, target)) return [];
        return this.collectReexportAliases(barrelPath, alias, reExportMemo, true);
      })
    );
    return [...new Map(chains.flat().map((onward) => [`${onward.filePath}:${onward.name}`, onward])).values()];
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
   * Direct referencers of `filePath`, then the files that import one of its exports through re-export
   * barrels (named, renamed, `export *`, `export * as ns`, import-then-export, chained or cyclic), each with
   * the barrel it imports as `via`. A barrel consumer counts only if it binds a name the barrel takes from
   * the target, or the barrel's namespace (`import * as`).
   * Each call reads every referencer of the target once, to see whether one re-exports it.
   * shortcut: `require()`/`import()` of a barrel and re-exports of a target that is itself a barrel
   * (`export *` in the target) are not followed; parse them here if barrel users need them.
   */
  async findReferencingFilesThroughBarrels(filePath: string): Promise<ReferencingFile[]> {
    const target = normalizePath(filePath);
    const referencing = await this.findReferencingFiles(target);
    const reExportMemo: ReExportMemo = new Map();
    const modules = await Promise.all(referencing.map((ref) => this.moduleReExports(ref.path, reExportMemo)));
    // Most files are re-exported by no referencer: skip the symbol graph (and the AST worker) for them.
    const specifiers = modules.flatMap((m) => [...m.reExports, ...m.namespaces].map(({ specifier }) => ({ from: m.path, specifier })));
    const resolved = await Promise.all(specifiers.map(({ from, specifier }) => this.resolveModuleSpecifier(from, specifier)));
    if (!resolved.some((from) => !!from && normalizePath(from) === target)) return referencing;

    const { symbols } = await this.getSymbolGraph(target);
    const chains = await Promise.all(
      symbols.filter((s) => s.isExported).map((s) => this.collectReexportAliases(target, s.name, reExportMemo, true))
    );
    const namespaces = await this.collectNamespaceAliases(modules, target, reExportMemo);
    const namesByBarrel = new Map<string, Set<string>>();
    for (const alias of [...chains.flat(), ...namespaces]) {
      if (alias.filePath === target) continue;
      const names = namesByBarrel.get(alias.filePath) ?? new Set<string>();
      namesByBarrel.set(alias.filePath, names.add(alias.name));
    }

    const consumers = await Promise.all(
      [...namesByBarrel].map(([barrel, names]) => this.barrelConsumers(barrel, names, namesByBarrel, reExportMemo))
    );
    const seen = new Set([target, ...referencing.map((ref) => normalizePath(ref.path))]);
    const result: ReferencingFile[] = [...referencing];
    for (const consumer of consumers.flat()) {
      const key = normalizePath(consumer.path);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(consumer);
    }
    return result;
  }

  /** Referencers of `barrel` that bind one of `names` from it, or re-export one of them onwards (a barrel of the chain). */
  private async barrelConsumers(
    barrel: string,
    names: Set<string>,
    barrels: Map<string, Set<string>>,
    reExportMemo: ReExportMemo
  ): Promise<ReferencingFile[]> {
    const refs = await this.findReferencingFiles(barrel);
    const matches = await Promise.all(
      refs.map(async (ref) =>
        (barrels.has(normalizePath(ref.path)) && (await this.reexportsNameFrom(ref.path, barrel, names, reExportMemo)))
        || this.importsNameFrom(ref.path, barrel, names, reExportMemo)
      )
    );
    return refs.filter((_, i) => matches[i]).map((ref) => ({ ...ref, via: barrel }));
  }

  /** Whether `fromPath` re-exports one of `names` from `barrel` itself, not from another barrel of the chain. */
  private async reexportsNameFrom(fromPath: string, barrel: string, names: Set<string>, reExportMemo: ReExportMemo): Promise<boolean> {
    const found = await Promise.all([...names].map((name) => this.reexportedAs(fromPath, { filePath: barrel, name }, reExportMemo)));
    return found.some((aliases) => aliases.length > 0);
  }

  /** Whether `fromPath` imports one of `names`, or the whole namespace, from `barrel`; an unreadable file does not. */
  private async importsNameFrom(
    fromPath: string,
    barrel: string,
    names: Set<string>,
    reExportMemo: ReExportMemo
  ): Promise<boolean> {
    let content: string;
    try {
      content = await this.fileReader.readFile(fromPath);
    } catch {
      return false;
    }
    // `from barrel import *` takes only the barrel's `__all__` (or public) names.
    const { starNames } = await this.moduleReExports(barrel, reExportMemo);
    const starTakesOne = [...names].some((name) => pythonStarExports(name, starNames));
    const candidates = readImportBindings(fromPath, content).filter((b) => {
      if (b.imported !== '*') return names.has(b.imported);
      return b.local !== '*' || path.extname(fromPath).toLowerCase() !== '.py' || starTakesOne;
    });
    const resolved = await Promise.all(candidates.map((b) => this.resolveModuleSpecifier(fromPath, b.specifier)));
    return resolved.some((from) => !!from && normalizePath(from) === barrel);
  }

  /**
   * The symbol itself plus every `(barrel, name)` that re-exports it, through any number of
   * barrels. A visited set stops barrel cycles; a barrel that cannot be read or resolved is skipped.
   */
  private async collectReexportAliases(
    filePath: string,
    symbolName: string,
    reExportMemo: ReExportMemo = new Map(),
    readPlainImporters = false
  ): Promise<ReExportTarget[]> {
    const root = { filePath: normalizePath(filePath), name: symbolName };
    const aliases = new Map<string, ReExportTarget>([[`${root.filePath}:${root.name}`, root]]);
    await this.expandReexportAliases([root], aliases, reExportMemo, readPlainImporters);
    return [...aliases.values()];
  }

  /** One breadth-first level: the frontier's re-exports run concurrently, then only unseen ones recurse. */
  private async expandReexportAliases(
    frontier: ReExportTarget[],
    aliases: Map<string, ReExportTarget>,
    reExportMemo: ReExportMemo,
    readPlainImporters: boolean
  ): Promise<void> {
    const found = (
      await Promise.all(frontier.map((current) => this.directReexports(current, reExportMemo, readPlainImporters)))
    ).flat();
    const next: ReExportTarget[] = [];
    for (const alias of found) {
      const key = `${alias.filePath}:${alias.name}`;
      if (aliases.has(key)) continue;
      aliases.set(key, alias);
      next.push(alias);
    }
    if (next.length > 0) await this.expandReexportAliases(next, aliases, reExportMemo, readPlainImporters);
  }

  /**
   * Re-exports of `current` in the files that reference it. Only `export ... from` referencers are read by
   * default; `readPlainImporters` also reads plain importers, which is what finds `import { x }; export { x }`
   * but costs one read per importer (paid once per scan by the dead-code walk, too much for per-symbol lookups).
   */
  private async directReexports(
    current: ReExportTarget,
    reExportMemo: ReExportMemo,
    readPlainImporters: boolean
  ): Promise<ReExportTarget[]> {
    const all = await this.findReferencingFiles(current.filePath);
    // A Python or Rust re-export is an import (`from .m import x`, `pub use m::x`): always read those importers.
    const referencing = readPlainImporters ? all : all.filter((ref) => ref.type === 'export' || isPythonOrRust(ref.path));
    const perImporter = await Promise.all(referencing.map((importer) => this.reexportedAs(importer.path, current, reExportMemo)));
    return perImporter.flat();
  }

  /** Re-exports of `filePath`, read and parsed once per memo; an unreadable file re-exports nothing. */
  private async moduleReExports(
    filePath: string,
    reExportMemo: ReExportMemo
  ): Promise<ModuleReExports & { path: string }> {
    const path = normalizePath(filePath);
    let parsed = reExportMemo.get(path);
    if (!parsed) {
      parsed = this.fileReader
        .readFile(path)
        .then((content) => readModuleReExports(path, content))
        .catch(() => ({ reExports: [], namespaces: [] }));
      reExportMemo.set(path, parsed);
    }
    return { ...(await parsed), path };
  }

  /** Names under which `barrelPath` re-exports `target`. */
  private async reexportedAs(
    barrelPath: string,
    target: ReExportTarget,
    reExportMemo: ReExportMemo
  ): Promise<ReExportTarget[]> {
    const { path: barrel, reExports } = await this.moduleReExports(barrelPath, reExportMemo);
    const resolved = await Promise.all(reExports.map(({ specifier }) => this.resolveModuleSpecifier(barrel, specifier)));
    const starTaken = await this.starTakes(target, reExportMemo);
    return reExports.flatMap(({ names }, i) => {
      const from = resolved[i];
      if (!from || normalizePath(from) !== target.filePath) return [];
      if (names === 'all') {
        return starTaken ? [{ filePath: barrel, name: target.name }] : [];
      }
      return names.filter(({ imported }) => imported === target.name).map(({ exported }) => ({ filePath: barrel, name: exported }));
    });
  }

  /** Whether a star re-export of `target`'s module takes `target.name`: never `default`; Python honours `__all__`. */
  private async starTakes(target: ReExportTarget, reExportMemo: ReExportMemo): Promise<boolean> {
    if (target.name === 'default') return false;
    if (path.extname(target.filePath).toLowerCase() !== '.py') return true;
    return pythonStarExports(target.name, (await this.moduleReExports(target.filePath, reExportMemo)).starNames);
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
      // Python and Rust paths (`.impl`, `self::imp`, `crate::m`) resolve the way the index resolved them.
      if (isPythonOrRust(extractFilePath(fromFilePath))) {
        return await this.languageService.getAnalyzer(fromFilePath).resolvePath(fromFilePath, moduleSpecifier);
      }
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
      
      // A bare `import './x'` binds no symbol, so the AST never sees it: it is always used.
      if ((await this.sideEffectTargets(normalizedSource)).has(normalizedTarget)) {
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
    try {
      const normalizedSource = normalizePath(sourceFile);
      
      // GraphQL, C#, Go, and Java files don't support AST symbol analysis - all imports are considered used
      if (this.isAstUnsupportedFile(normalizedSource)) {
        log.debug(`Skipping symbol analysis for unsupported file type: ${normalizedSource}`);
        return this.markAllAsUsed(targetFiles);
      }
      
      // Get symbol graph once for all targets
      const { dependencies } = await this.getSymbolGraph(normalizedSource);
      const sideEffects = await this.sideEffectTargets(normalizedSource);
      
      if (dependencies.length === 0 && sideEffects.size === 0) {
        return this.markAllAsUnused(targetFiles);
      }

      // Build resolved target paths set
      const resolvedTargets = await this.buildResolvedTargetsSet(dependencies, normalizedSource);
      for (const target of sideEffects) {
        resolvedTargets.add(target);
      }

      // Check each target against the resolved set
      return this.checkTargetsAgainstResolved(targetFiles, resolvedTargets);
    } catch (error) {
      // On error, assume all used to be safe
      const spiderError = SpiderError.fromError(error, sourceFile);
      log.warn('Batch usage verification failed, assuming all used:', spiderError.message);
      return this.markAllAsUsed(targetFiles);
    }
  }

  /** Files a source imports with a bare `import './x'`, which carries no symbol for the AST to find. */
  private async sideEffectTargets(normalizedSource: string): Promise<Set<string>> {
    const analyzer = this.languageService.getAnalyzer(normalizedSource);
    const imports = await analyzer.parseImports(normalizedSource);
    const resolved = await Promise.all(
      imports.filter((dep) => dep.type === 'side-effect').map((dep) => analyzer.resolvePath(normalizedSource, dep.module))
    );
    return new Set(resolved.filter((target): target is string => target !== null).map(normalizePath));
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
    const reExportMemo: ReExportMemo = new Map();
    let skippedFiles = 0;

    for (const filePath of filesToScan) {
      if (signal) {
        // Yield to the event loop so a pending cancel message can abort the signal.
        await setImmediate(); // NOSONAR S9382: one yield per file is the cancellation point
        signal.throwIfAborted();
      }
      try {
        const unusedSymbols = await this.findUnusedSymbols(filePath, reExportMemo); // NOSONAR S9382 sequential by design: one cancellation point per file, bounded by maxFiles
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
