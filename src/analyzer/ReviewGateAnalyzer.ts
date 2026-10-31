import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { mapWithConcurrency } from "../shared/concurrency";
import { SUPPORTED_SOURCE_FILE_REGEX } from "../shared/constants";
import { normalizePath } from "../shared/path";
import { detectCycles } from "../shared/cycleUtils";
import { SignatureAnalyzer, type BreakingChange, type ReexportedModule, type SignatureInfo } from "./SignatureAnalyzer";
import type { SymbolDependency, SymbolInfo } from "./types";
import { PathResolver } from "./utils/PathResolver";
import { findRemovedNameImporters } from "./utils/removedNameImporters";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_DEPTH = 3;
const MAX_MAX_FILES = 1_000;
const MAX_MAX_DEPTH = 10;
/** Bound on the reverse-index walk used to decide whether a consumer is under test. */
const MAX_COVERAGE_LOOKUP_FILES = 200;
const SIGNATURE_ANALYSIS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py"]);

export type ReviewRiskLevel = "low" | "medium" | "high" | "critical";

export interface ReviewGateOptions {
  baseRef: string;
  headRef?: string;
  maxFiles?: number;
  maxDepth?: number;
  /** Set to false when the caller reports import cycles itself; default true. */
  fileCycles?: boolean;
}

export interface ReviewEvidence {
  kind: "breaking-change" | "moved" | "impact" | "consumers" | "cycle" | "unused-export" | "test-candidate" | "partial";
  detail: string;
}

export interface ReviewScoreFactors {
  breakingChanges: number;
  /**
   * Weight of consumers left for the author: for a change that breaks call sites,
   * every consumer this diff does not touch, tested or not.
   */
  unverifiedConsumers: number;
  cycles: number;
  unusedExport: number;
  missingTestCandidate: number;
  partialImpact: number;
}

/**
 * Where a changed contract's consumers stand. A consumer that the diff already
 * updates is accounted for. A consumer a test exercises is accounted for only
 * when the change leaves its call sites valid: otherwise it is still broken, and
 * the test merely makes that breakage fail loudly.
 */
export interface ConsumerStanding {
  /**
   * Consumer files the diff already touches. File-level only: the file changed,
   * which does not prove its call to the changed symbol was fixed.
   */
  updated: string[];
  /** Consumer files the diff does not touch but a test reaches, so a real incompatibility fails loudly. */
  covered: string[];
  /** Neither — the risk this gate exists to report. */
  unverified: string[];
}

export interface ReviewSymbol {
  name: string;
  filePath: string;
  score: number;
  risk: ReviewRiskLevel;
  breakingChanges: BreakingChange[];
  impactedSymbolCount: number;
  consumers: ConsumerStanding;
  cycleEvidence: string[];
  unusedExportEvidence: boolean;
  testCandidates: string[];
  scoreFactors: ReviewScoreFactors;
  evidence: ReviewEvidence[];
}

/** An import cycle the diff creates or enlarges, between workspace-relative files. */
export interface ReviewCycle {
  classification: "introduced" | "aggravated";
  files: string[];
  changedFiles: string[];
}

/** File-level cycles the diff adds, or why they could not be determined. */
export interface FileCycleAnalysis {
  cycles: ReviewCycle[];
  limitations: string[];
}

export interface ReviewGateResult {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  symbols: ReviewSymbol[];
  /** Import cycles the diff introduces or aggravates; a cycle that already existed untouched is not listed. */
  cycles: ReviewCycle[];
  score: number;
  risk: ReviewRiskLevel;
  isPartial: boolean;
  limitations: string[];
}

export interface SymbolDependentsProvider {
  getSymbolDependents(filePath: string, symbolName: string): Promise<Array<{ sourceSymbolId: string }>>;
  /**
   * File-level reverse index: which files reference `filePath`.
   *
   * Used to answer "is this consumer under test", which the symbol traversal
   * cannot answer on its own — it only records what its depth-limited walk from
   * the changed symbol happened to visit.
   */
  findReferencingFiles?(filePath: string): Promise<Array<{ path: string }>>;
  findReferencingFilesWithFallback?(filePath: string): Promise<Array<{ path: string }>>;
  getSymbolGraph?(filePath: string): Promise<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }>;
  findUnusedSymbols?(filePath: string): Promise<SymbolInfo[]>;
  /** Import cycles among `changedFiles` that the diff against `baseRef` adds; absent when the host cannot read the base. */
  findFileCycles?(changedFiles: string[], baseRef: string): Promise<FileCycleAnalysis>;
}

interface FileEvidence {
  cycleSymbols: Set<string>;
  unusedSymbols: Set<string>;
  testCandidates: string[];
  /** The file is in an import cycle the diff adds: every changed symbol of it is then in a cycle. */
  inFileCycle: boolean;
  /** Top-level functions of the changed file, read from its new content. */
  functions: SignatureInfo[];
}

/** A signature comparison, plus where a removed symbol moved to within the same diff. */
interface ReviewComparison {
  symbolName: string;
  breakingChanges: BreakingChange[];
  /** Workspace-relative file now declaring the symbol; its dependents are walked there. */
  movedTo?: string;
  /** Files that still import the moved or removed symbol from its old module, so they break. */
  staleImporters?: string[];
}

/** Base and head content of one changed source file. */
interface ChangedSource {
  relativePath: string;
  absolutePath: string;
  oldContent: string | null;
  newContent: string | null;
}

/** Cross-file state of one review, used to tell a moved symbol from a removed one. */
interface MoveIndex {
  sources: Map<string, ChangedSource>;
  /** Exported name → changed files that export it at the head ref but not at the base ref. */
  targets: Map<string, Array<{ relativePath: string; absolutePath: string; content: string }>>;
  /** Memoized stale importers per old module and exported name; null when they could not be checked. */
  stale: Map<string, Promise<string[] | null>>;
  /** Memoized text search for the importers of a deleted module, per module. */
  grep: Map<string, Promise<string[] | string>>;
  /** Memoized head content of the candidate importers, shared by every exported name. */
  contents: Map<string, Promise<string | null>>;
  /** Workspace-relative files that sit in an import cycle the diff adds. */
  cycleFiles: ReadonlySet<string>;
}

/** The changed file whose removals are being matched against the other changed files. */
interface MoveScope {
  relativePath: string;
  absolutePath: string;
  oldContent: string;
  headRef: string;
  changedFiles: ReadonlySet<string>;
  moves: MoveIndex;
  limitations: string[];
  /** The file no longer exists at the head ref: the resolver cannot find it, so importers are matched by specifier. */
  deleted?: boolean;
}

interface DependentWalkState {
  seen: Set<string>;
  testDependents: Set<string>;
  consumerFiles: Set<string>;
  edges: Map<string, Set<string>>;
  next: Array<{ filePath: string; symbolName: string }>;
}

/** Deterministic, local Git-diff review analysis. */
export class ReviewGateAnalyzer {
  private readonly normalizedRoot: string;
  private readonly signatures = new SignatureAnalyzer();
  private readonly resolver: PathResolver;

  constructor(
    private readonly workspaceRoot: string,
    private readonly dependents?: SymbolDependentsProvider,
  ) {
    this.normalizedRoot = normalizePath(path.resolve(workspaceRoot));
    this.resolver = new PathResolver(undefined, true, workspaceRoot);
  }

  async analyze(options: ReviewGateOptions): Promise<ReviewGateResult> {
    const maxFiles = this.validateLimit(options.maxFiles, DEFAULT_MAX_FILES, MAX_MAX_FILES, "maxFiles");
    const maxDepth = this.validateLimit(options.maxDepth, DEFAULT_MAX_DEPTH, MAX_MAX_DEPTH, "maxDepth");
    const headRef = options.headRef ?? "HEAD";
    this.validateRef(options.baseRef, "baseRef");
    this.validateRef(headRef, "headRef");
    const changedFiles = await this.getChangedFiles(options.baseRef, headRef, maxFiles);
    const changedFileSet = new Set(changedFiles);
    const symbols: ReviewSymbol[] = [];
    const limitations: string[] = [];
    const analysisAvailability = { cycle: false, unused: false };

    if (changedFiles.length === maxFiles) {
      limitations.push(`Analysis limited to ${maxFiles} changed files.`);
    }

    const sources = await this.loadChangedSources(changedFiles, options.baseRef, headRef);
    const fileCycles = options.fileCycles === false ? { cycles: [], limitations: [] } : await this.collectFileCycles(changedFiles, options.baseRef, headRef);
    limitations.push(...fileCycles.limitations);
    const cycleFiles = new Set(fileCycles.cycles.flatMap((cycle) => cycle.changedFiles.map(normalizePath)));
    const moves: MoveIndex = { sources, targets: this.collectMoveTargets(sources), stale: new Map(), grep: new Map(), contents: new Map(), cycleFiles };
    // Each file gets its own limitations, merged in file order, so the report matches a sequential run.
    // The shared caches memoize promises, so files analyzed at the same time share one lookup.
    // 1: per-file analysis reads symbol dependents, and the AST worker symbol results depend on which files it has loaded (`export *`), so symbol lookups stay one at a time, in order. Git reads above stay parallel.
    const analyses = await mapWithConcurrency(changedFiles, 1, async (relativePath) => {
      const fileLimitations: string[] = [];
      const fileSymbols = await this.analyzeChangedFile(relativePath, headRef, maxDepth, fileLimitations, analysisAvailability, changedFileSet, moves);
      return { fileSymbols, fileLimitations };
    });
    for (const { fileSymbols, fileLimitations } of analyses) {
      symbols.push(...fileSymbols);
      limitations.push(...fileLimitations);
    }

    symbols.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
    const score = symbols.reduce((highest, symbol) => Math.max(highest, symbol.score), 0);
    return {
      baseRef: options.baseRef,
      headRef,
      changedFiles,
      symbols,
      cycles: fileCycles.cycles,
      score,
      risk: riskForScore(score),
      isPartial: limitations.length > 0,
      limitations,
    };
  }

  private async collectFileCycles(changedFiles: string[], baseRef: string, headRef: string): Promise<FileCycleAnalysis> {
    if (!this.dependents?.findFileCycles) {
      return { cycles: [], limitations: ["Import-cycle evidence unavailable: file-cycle provider is not configured."] };
    }
    try {
      const analysis = await this.dependents.findFileCycles(changedFiles, baseRef);
      // Cycles are read from the checked-out tree, which is the head only when no other ref is asked for.
      const limitations = headRef === "HEAD" ? analysis.limitations : [...analysis.limitations, `Import cycles are read from the checked-out tree, not from ${headRef}.`];
      return { cycles: analysis.cycles, limitations };
    } catch {
      return { cycles: [], limitations: ["Import-cycle evidence unavailable: the dependency graph could not be compared with the base ref."] };
    }
  }

  /** A ref starting with "-" would reach git as an option (for example --output=<file>). */
  private validateRef(ref: string, name: string): void {
    if (ref.length === 0 || ref.startsWith("-")) {
      throw new Error(`${name} must be a Git ref that does not start with "-"`);
    }
  }

  private validateLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    }
    return resolved;
  }

  /** Base and head content of every changed file the signature analysis supports, read once per review. */
  private async loadChangedSources(changedFiles: string[], baseRef: string, headRef: string): Promise<Map<string, ChangedSource>> {
    const supported = changedFiles.filter((relativePath) => SIGNATURE_ANALYSIS_EXTENSIONS.has(path.extname(relativePath).toLowerCase()));
    // Up to two git processes per file: 4 files at a time keeps at most 8 running, for up to 1 000 changed files.
    const loaded = await mapWithConcurrency(supported, 4, async (relativePath): Promise<ChangedSource> => {
      const absolutePath = this.resolveWorkspacePath(relativePath);
      const [oldContent, newContent] = await Promise.all([
        this.gitShow(baseRef, relativePath),
        this.readHeadContent(headRef, absolutePath, relativePath),
      ]);
      return { relativePath, absolutePath, oldContent, newContent };
    });
    return new Map(loaded.map((source) => [source.relativePath, source]));
  }

  /** Names each changed file exports at the head ref but did not export at the base ref: where a removed symbol may have moved. */
  private collectMoveTargets(sources: Map<string, ChangedSource>): MoveIndex["targets"] {
    const targets: MoveIndex["targets"] = new Map();
    for (const { relativePath, absolutePath, oldContent, newContent } of sources.values()) {
      if (newContent === null) continue;
      let added: string[];
      try {
        const before = oldContent === null ? new Set<string>() : this.signatures.exportedDeclarationNames(absolutePath, oldContent);
        added = [...this.signatures.exportedDeclarationNames(absolutePath, newContent)].filter((name) => !before.has(name));
      } catch {
        continue; // An unparsable file is no move target; its own analysis reports the parse error.
      }
      for (const name of added) {
        targets.set(name, [...targets.get(name) ?? [], { relativePath, absolutePath, content: newContent }]);
      }
    }
    return targets;
  }

  private async analyzeChangedFile(
    relativePath: string,
    headRef: string,
    maxDepth: number,
    limitations: string[],
    availability: { cycle: boolean; unused: boolean },
    changedFiles: ReadonlySet<string>,
    moves: MoveIndex,
  ): Promise<ReviewSymbol[]> {
    const source = moves.sources.get(relativePath);
    if (!source) {
      // Only source code can carry a contract the gate fails to check. Reporting a
      // README or a workflow file as a gap made almost every review "partial".
      if (SUPPORTED_SOURCE_FILE_REGEX.test(relativePath)) {
        limitations.push(`Signature and symbol evidence unavailable for unsupported file type: ${relativePath}.`);
      }
      return [];
    }
    const { absolutePath, oldContent, newContent } = source;
    if (newContent === null) {
      if (oldContent === null) {
        limitations.push(`Could not compare ${relativePath}; file is unreadable at both refs.`);
        return [];
      }
      // `--no-renames` reports a moved file as its deletion plus the new path, so both land here.
      const scope: MoveScope = { relativePath, absolutePath, oldContent, headRef, changedFiles, moves, limitations, deleted: true };
      const removed = await this.analyzeSignatures(scope, "", limitations);
      return Promise.all(removed.map((comparison) => this.createReviewSymbol(comparison, absolutePath, relativePath, maxDepth, DELETED_FILE_EVIDENCE, changedFiles, headRef)));
    }
    // A file the diff adds has no prior signature, so nothing downstream can have
    // depended on it and no breaking change is possible. Reporting it as an
    // unanalyzable gap marked every added file — a new test above all — as a
    // limitation, inflating the review instead of crediting the addition.
    if (oldContent === null) return [];
    const fileEvidence = {
      ...await this.collectFileEvidence(absolutePath, relativePath, limitations, availability),
      inFileCycle: moves.cycleFiles.has(relativePath),
      functions: this.extractTopLevelFunctions(absolutePath, newContent),
    };
    const scope: MoveScope = { relativePath, absolutePath, oldContent, headRef, changedFiles, moves, limitations };
    const comparisons = await this.analyzeSignatures(scope, newContent, limitations);
    return Promise.all(comparisons.map((comparison) => this.createReviewSymbol(comparison, absolutePath, relativePath, maxDepth, fileEvidence, changedFiles, headRef)));
  }

  private async analyzeSignatures(scope: MoveScope, newContent: string, limitations: string[]): Promise<ReviewComparison[]> {
    const { absolutePath, relativePath, oldContent, headRef } = scope;
    try {
      const comparisons = this.signatures.analyzeBreakingChanges(absolutePath, oldContent, newContent);
      // Every removed symbol walks its re-export chain: load each module once, not once per symbol.
      const loaded = new Map<string, Promise<ReexportedModule | null>>();
      const reexports = await this.signatures.resolveReexportedRemovals(
        absolutePath, oldContent, newContent, comparisons,
        (fromFile, specifier) => {
          const key = `${normalizePath(fromFile)}\0${specifier}`;
          let module = loaded.get(key);
          if (!module) {
            module = this.loadHeadModule(fromFile, specifier, headRef);
            loaded.set(key, module);
          }
          return module;
        },
      );
      limitations.push(...reexports.limitations.map((limitation) => `${relativePath}: ${limitation}`));
      // A removal still reported as such — not resolved through a re-export — may have moved to another changed file.
      const removals = new Set(comparisons.filter((comparison) => comparison.breakingChanges.length === 1));
      const headExports = this.signatures.exportedDeclarationNames(absolutePath, newContent);
      const resolved = await Promise.all(reexports.results.map(async (result) =>
        removals.has(result) && !headExports.has(exportedNameOf(result.symbolName)) ? this.resolveMove(result, scope) : result));
      return scope.deleted ? await this.withDeletedImporters(resolved, scope) : resolved;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown parser error";
      limitations.push(`Signature evidence unavailable for ${relativePath}: ${detail}.`);
      return [];
    }
  }

  /**
   * A removal whose name exactly one other changed file now exports is a move: compared
   * with its new declaration, and still breaking only for files importing the old path.
   * Fails closed: an ambiguous target or unchecked importers keep the removal.
   */
  private async resolveMove(removal: ReviewComparison, scope: MoveScope): Promise<ReviewComparison> {
    const exportedName = exportedNameOf(removal.symbolName);
    const matches = (scope.moves.targets.get(exportedName) ?? [])
      .filter((target) => target.relativePath !== scope.relativePath)
      .flatMap((target) => {
        const moved = this.signatures.compareMovedRemoval(scope.absolutePath, scope.oldContent, removal.symbolName, {
          filePath: target.absolutePath, content: target.content,
        });
        return moved ? [{ target, moved }] : [];
      });
    if (matches.length === 0) return scope.deleted ? removal : this.withRemovalImporters(removal, scope);
    if (matches.length > 1) {
      addLimitation(scope.limitations, `${scope.relativePath}: '${exportedName}' is newly exported by ${matches.map((match) => match.target.relativePath).join(", ")}; its removal is kept because the move target is ambiguous.`);
      return removal;
    }
    const importers = await this.staleImporters(scope, exportedName);
    if (importers === null) return removal;
    const [{ target, moved }] = matches;
    return movedComparison(removal, moved.breakingChanges, target.relativePath, importers);
  }

  /**
   * A removal that moved nowhere breaks every file still importing the name, whether or not it calls it:
   * the dependent index links a file to a symbol through calls and references only, so an import-only
   * consumer was missing (#524). Without a reference index the consumers are unknown anyway, so nothing is added.
   */
  private async withRemovalImporters(removal: ReviewComparison, scope: MoveScope): Promise<ReviewComparison> {
    if (!this.dependents?.findReferencingFiles) return removal;
    const name = exportedNameOf(removal.symbolName);
    const importers = await findRemovedNameImporters(scope.relativePath, name, [...scope.changedFiles], {
      referencingFiles: (file) => this.referencingFiles(this.toAbsolute(file)),
      read: (file) => this.cachedConsumerContent(file, scope),
      resolve: async (fromFile, specifier) => {
        const target = await this.resolver.resolve(this.toAbsolute(fromFile), specifier);
        return target ? this.toWorkspaceRelative(target) : null;
      },
    });
    if (typeof importers === "string") {
      addLimitation(scope.limitations, `${scope.relativePath}: files importing '${name}' could not all be listed (${importers}); its consumers may be incomplete.`);
      return removal;
    }
    return importers.length > 0 ? { ...removal, staleImporters: importers } : removal;
  }

  /**
   * A deleted module's removals that moved nowhere break every file still importing it. The
   * index no longer knows the module, so those importers come from the head ref's text.
   * A module declaring nothing (a barrel, a side-effect file) is reported once, when it has importers.
   */
  private async withDeletedImporters(results: ReviewComparison[], scope: MoveScope): Promise<ReviewComparison[]> {
    if (results.length === 0) {
      const importers = await this.staleImporters(scope, undefined);
      if (!importers?.length) return [];
      const change: BreakingChange = {
        type: "member-removed", symbolName: MODULE_SYMBOL, severity: "error",
        description: `Module ${scope.relativePath} was deleted, but ${importers.length} file(s) still import it: ${importers.join(", ")}`,
      };
      return [{ symbolName: MODULE_SYMBOL, breakingChanges: [change], staleImporters: importers }];
    }
    return Promise.all(results.map(async (result) => {
      if (result.movedTo !== undefined || result.staleImporters !== undefined) return result;
      const importers = await this.staleImporters(scope, exportedNameOf(result.symbolName));
      return importers?.length ? { ...result, staleImporters: importers } : result;
    }));
  }

  /** Every member of a moved class shares its importers: look them up once per exported name. */
  private staleImporters(scope: MoveScope, exportedName: string | undefined): Promise<string[] | null> {
    const key = `${scope.relativePath}\0${exportedName ?? "*"}`;
    let importers = scope.moves.stale.get(key);
    if (!importers) {
      importers = this.findStaleImporters(scope, exportedName);
      scope.moves.stale.set(key, importers);
    }
    return importers;
  }

  /**
   * Changed files and indexed referrers of the old module that may still reach `exportedName`
   * through it at the head ref. Null, with a limitation, when the referrers cannot be listed.
   */
  private async findStaleImporters(scope: MoveScope, exportedName: string | undefined): Promise<string[] | null> {
    const referrers = scope.deleted ? await this.grepImporters(scope) : await this.referencingFiles(scope.absolutePath);
    if (typeof referrers === "string") {
      scope.limitations.push(scope.deleted
        ? `${scope.relativePath}: module deleted, but files still importing it could not be listed (${referrers}).`
        : `${scope.relativePath}: '${exportedName}' looks moved, but its removal is kept because files importing the old module could not be listed (${referrers}).`);
      return null;
    }
    const candidates = new Set([...scope.changedFiles, ...referrers]);
    candidates.delete(scope.relativePath);
    const sorted = [...candidates].sort((left, right) => left.localeCompare(right));
    // Candidates can be every importer in the index: read a bounded number at a time.
    const imports = await mapWithConcurrency(sorted, 8, (file) => this.mayImportFromModule(file, exportedName, scope));
    return sorted.filter((_file, index) => imports[index]);
  }

  /** Workspace-relative files referencing `absolutePath`, or why they could not be listed. */
  private async referencingFiles(absolutePath: string): Promise<string[] | string> {
    if (!this.dependents?.findReferencingFiles) return "no reference index is configured";
    try {
      const references = await this.dependents.findReferencingFiles(absolutePath);
      return references.map((reference) => this.toWorkspaceRelative(normalizePath(reference.path)));
    } catch (error) {
      return `reference index failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Memoized per deleted module: every exported name shares the one search. */
  private grepImporters(scope: MoveScope): Promise<string[] | string> {
    let hits = scope.moves.grep.get(scope.relativePath);
    if (!hits) {
      hits = this.searchImporters(scope);
      scope.moves.grep.set(scope.relativePath, hits);
    }
    return hits;
  }

  /**
   * Files whose text mentions the deleted module's name, or why they could not be searched.
   * At "HEAD" the head content is the working tree (see readHeadContent), so that is searched.
   */
  private async searchImporters(scope: MoveScope): Promise<string[] | string> {
    const atHead = scope.headRef === "HEAD";
    const args = ["grep", "-l", "-z", "-F", "--full-name", ...(atHead ? ["--untracked"] : []), "-e", moduleNameOf(scope.absolutePath), ...(atHead ? [] : [scope.headRef]), "--"];
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: this.workspaceRoot, maxBuffer: 4 * 1024 * 1024 });
      const prefix = atHead ? "" : `${scope.headRef}:`;
      return stdout.split("\0").filter(Boolean).map((hit) => normalizePath(hit.startsWith(prefix) ? hit.slice(prefix.length) : hit));
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if ((error as { code?: unknown }).code === 1) return [];
      return `git grep failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Head content of a candidate importer, read once per review; null when unreadable or not a language the review parses. */
  private cachedConsumerContent(file: string, scope: MoveScope): Promise<string | null> {
    if (!SIGNATURE_ANALYSIS_EXTENSIONS.has(path.extname(file).toLowerCase())) return Promise.resolve(null);
    let pending = scope.moves.contents.get(file);
    if (!pending) {
      pending = this.readConsumerContent(file, scope.headRef);
      scope.moves.contents.set(file, pending);
    }
    return pending;
  }

  /** Whether `file` imports `exportedName` (any name when omitted) from the old module, or references that module in a form not followed. */
  private async mayImportFromModule(file: string, exportedName: string | undefined, scope: MoveScope): Promise<boolean> {
    const content = await this.cachedConsumerContent(file, scope);
    if (content === null) return false;
    const absolute = this.toAbsolute(file);
    const specifiers = this.signatures.specifiersThatMayImport(absolute, content, exportedName);
    const resolved = await Promise.all(specifiers.map((specifier) => this.resolver.resolve(absolute, specifier).catch(() => null)));
    return specifiers.some((specifier, index) => {
      const target = resolved[index];
      return target ? normalizePath(target) === scope.absolutePath : scope.deleted === true && namesDeletedModule(absolute, specifier, scope.absolutePath);
    });
  }

  private async createReviewSymbol(
    comparison: ReviewComparison,
    absolutePath: string,
    relativePath: string,
    maxDepth: number,
    fileEvidence: FileEvidence,
    changedFiles: ReadonlySet<string>,
    headRef: string,
  ): Promise<ReviewSymbol> {
    const errorBreakingChanges = comparison.breakingChanges.filter(
      (change) => change.severity === "error",
    );
    const staleImporters = comparison.staleImporters ?? [];
    const impact = await this.getContractImpact(comparison, errorBreakingChanges, absolutePath, maxDepth, fileEvidence, headRef);
    const cycles = fileEvidence.inFileCycle || fileEvidence.cycleSymbols.has(this.toSymbolId(absolutePath, comparison.symbolName));
    const unusedExport = fileEvidence.unusedSymbols.has(comparison.symbolName);
    // A dependents provider that actually ran and found zero live consumers (not just
    // "no provider configured", which also reports count: 0 but means unknown impact)
    // means this breaking change already has no real callers to break.
    const hasConfirmedZeroImpact = Boolean(this.dependents) && errorBreakingChanges.length > 0 && impact.count === 0 && !impact.partial;
    // A test that directly depends on the changed symbol fails loudly on a real
    // incompatibility (compile error or assertion failure) — that's live regression
    // coverage, distinct from "no provider configured" (unknown) or "confirmed zero" (untested by definition).
    const hasTestCoverage = impact.testDependents.length > 0;
    const allTestCandidates = [...new Set([...fileEvidence.testCandidates, ...impact.testDependents])];
    const consumers = markStale(await this.getConsumerStanding(impact, changedFiles), staleImporters);
    const consumersMustAct = this.requiresConsumerUpdate(errorBreakingChanges);
    const scoreFactors = this.getScoreFactors({
      breakingChangeCount: errorBreakingChanges.length, impact, consumers, consumersMustAct, cycles, unusedExport,
      testCandidateCount: allTestCandidates.length, hasConfirmedZeroImpact, hasTestCoverage,
      moved: comparison.movedTo !== undefined,
    });
    const score = Math.min(100, Object.values(scoreFactors).reduce((total, value) => total + value, 0));
    return {
      name: comparison.symbolName, filePath: relativePath, score, risk: riskForScore(score),
      breakingChanges: comparison.breakingChanges, impactedSymbolCount: impact.count, consumers,
      cycleEvidence: cycles ? [comparison.symbolName] : [], unusedExportEvidence: unusedExport,
      testCandidates: allTestCandidates, scoreFactors,
      evidence: this.getEvidence({
        breakingChanges: comparison.breakingChanges, impact, consumers, consumersMustAct, cycles, unusedExport,
        testCandidates: allTestCandidates, hasTestCoverage,
      }),
    };
  }

  /** Dependents of a changed contract that its error-level changes can break; a moved symbol's are walked at its new file. */
  private async getContractImpact(
    comparison: ReviewComparison,
    errorBreakingChanges: BreakingChange[],
    absolutePath: string,
    maxDepth: number,
    fileEvidence: FileEvidence,
    headRef: string,
  ): Promise<SymbolImpact> {
    if (errorBreakingChanges.length === 0) return EMPTY_IMPACT;
    // Member-level changes (a single interface/class member removed or retyped) only
    // implicate direct consumers of that member. Hop 2+ chases callers of the *type's*
    // consumers (e.g. everyone who calls a class that merely returns the type) — noise
    // unrelated to the specific member being changed.
    const isMemberLevelChange = errorBreakingChanges.every((change) => change.type === "member-removed" || change.type === "member-renamed" || change.type === "member-type-changed" || change.type === "member-optional-to-required");
    const effectiveMaxDepth = isMemberLevelChange ? 1 : maxDepth;
    const declaringPath = comparison.movedTo ? this.toAbsolute(comparison.movedTo) : absolutePath;
    const contractImpact = this.isVuePropsSymbol(comparison.symbolName)
      ? await this.getVuePropsImpact(absolutePath)
      : await this.getTypeImpact(declaringPath, comparison.symbolName, effectiveMaxDepth, fileEvidence.functions, headRef);
    const impact = await this.keepCallsThatBreak(contractImpact, comparison.symbolName, errorBreakingChanges, headRef);
    const stale = comparison.staleImporters ?? [];
    // A file still importing a moved symbol from its old path is a verified consumer, indexed or not.
    return stale.length > 0 ? mergeImpacts(impact, { ...EMPTY_IMPACT, count: stale.length, consumerFiles: stale }) : impact;
  }

  /**
   * Whether consumers have to be edited for this change, or merely re-checked.
   *
   * A call site breaks when what it *passes in* no longer fits — changed
   * parameters, or a changed member of a type it constructs. A changed return
   * type leaves every call valid: the consumer only receives a different shape,
   * which breaks it only if it reads a part that went away.
   *
   * Deciding that last case needs the direction of the change (members added vs
   * removed), which a textual signature comparison cannot see — so a return-type
   * change is reported and weighted, but its consumers are not counted against
   * the author as unhandled work — nor reported as safe: the evidence says their
   * compatibility is unchecked.
   */
  private requiresConsumerUpdate(errorBreakingChanges: BreakingChange[]): boolean {
    return errorBreakingChanges.some((change) => change.type !== "return-type-changed");
  }

  /**
   * Split the consumers of a changed contract into the ones this diff already
   * updates, the ones a test exercises, and the ones nobody checked. How much the
   * last two groups weigh depends on whether the change breaks call sites; see
   * `getScoreFactors`.
   */
  private async getConsumerStanding(
    impact: SymbolImpact,
    changedFiles: ReadonlySet<string>,
  ): Promise<ConsumerStanding> {
    const covered = new Set(impact.coveredFiles);
    const standing: ConsumerStanding = { updated: [], covered: [], unverified: [] };
    const files = [...impact.consumerFiles].sort((a, b) => a.localeCompare(b));
    // Only consumers neither changed nor already covered ask the reverse index; the lookups are independent.
    const tested = await mapWithConcurrency(files, 8, async (file) =>
      !changedFiles.has(file) && (covered.has(file) || await this.hasTestDependent(file)));
    for (const [index, file] of files.entries()) {
      if (changedFiles.has(file)) standing.updated.push(file);
      else if (tested[index]) standing.covered.push(file);
      else standing.unverified.push(file);
    }
    return standing;
  }

  /**
   * Whether a test file references `file`, directly or through intermediates.
   *
   * The symbol traversal records coverage only for consumers it reached before
   * its depth limit, so a consumer with a test of its own — sitting one hop past
   * that limit — was reported as unverified while the same report stated that a
   * test depends on the changed symbol. This asks the reverse index instead, so
   * the answer no longer depends on where the walk stopped.
   */
  private async hasTestDependent(file: string): Promise<boolean> {
    if (!this.dependents?.findReferencingFiles) return false;
    const findReferencingFiles = this.dependents.findReferencingFiles.bind(this.dependents);

    const visited = new Set([file]);
    const queue = [file];
    while (queue.length > 0 && visited.size <= MAX_COVERAGE_LOOKUP_FILES) {
      let referencing: Array<{ path: string }>;
      try {
        // eslint-disable-next-line no-await-in-loop -- depth-first walk under a visited-file budget: the order decides which files fit it
        referencing = await findReferencingFiles(this.toAbsolute(queue.pop()!));
      } catch {
        continue; // An unreadable entry must not decide the whole question.
      }
      for (const reference of referencing) {
        const referencePath = this.toWorkspaceRelative(normalizePath(reference.path));
        if (this.isTestFilePath(referencePath)) return true;
        if (visited.has(referencePath)) continue;
        visited.add(referencePath);
        queue.push(referencePath);
      }
    }
    return false;
  }

  /** Consumer content at the reviewed ref, or null when it is unreadable or outside the workspace. */
  private async readConsumerContent(relativePath: string, headRef: string): Promise<string | null> {
    try {
      return await this.readHeadContent(headRef, this.resolveWorkspacePath(relativePath), relativePath);
    } catch {
      return null;
    }
  }

  private toAbsolute(relativePath: string): string {
    return normalizePath(path.resolve(this.workspaceRoot, relativePath));
  }

  private getScoreFactors(input: {
    breakingChangeCount: number;
    impact: SymbolImpact;
    consumers: ConsumerStanding;
    consumersMustAct: boolean;
    cycles: boolean;
    unusedExport: boolean;
    testCandidateCount: number;
    hasConfirmedZeroImpact: boolean;
    hasTestCoverage: boolean;
    /** The symbol moved to another changed file: residual work even when nothing else changed. */
    moved: boolean;
  }): ReviewScoreFactors {
    // Residual weight: the change is real and worth a look, but nothing downstream
    // has to be edited for it, so it must not drown the findings that do need work.
    // Kept non-zero on purpose — at zero the symbol would vanish from the report.
    const RESIDUAL_WEIGHT = 5;
    // When call sites must change, a consumer this diff does not touch is broken
    // whether or not a test reaches it — the test only makes the breakage fail
    // later, in CI. So only a diff that updates every consumer is residual work.
    const untouchedConsumers = input.consumers.covered.length + input.consumers.unverified.length;
    const consumersAccountedFor = input.consumers.updated.length > 0 && untouchedConsumers === 0;
    // Cycles, an unused export or a missing test make a broken contract riskier;
    // on their own they are the state of the code, not a risk this diff creates.
    // A compatible change to a symbol in an existing cycle used to score "medium".
    if (input.breakingChangeCount === 0) {
      // A pure move keeps the residual weight so it stays visible in the report.
      return { breakingChanges: Number(input.moved) * RESIDUAL_WEIGHT, unverifiedConsumers: 0, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 0 };
    }
    let breakingChangeWeight = 50;
    if (input.hasConfirmedZeroImpact || !input.consumersMustAct || consumersAccountedFor) {
      breakingChangeWeight = RESIDUAL_WEIGHT;
    } else if (input.hasTestCoverage) {
      breakingChangeWeight = 25;
    }
    return {
      // Once per symbol, not per change: removing four members from one interface is
      // one contract change for its consumers, and who must act on it is already
      // scored by the consumer factors below.
      breakingChanges: breakingChangeWeight,
      // Scored on what the diff leaves broken, not on how widely the contract is
      // used: a heavily used contract whose consumers are all updated is exactly
      // the well-handled change this gate should wave through.
      unverifiedConsumers: input.consumersMustAct ? untouchedConsumers * 5 : 0, cycles: input.cycles ? 20 : 0,
      unusedExport: input.unusedExport ? 10 : 0, missingTestCandidate: input.testCandidateCount === 0 ? 10 : 0,
      // An incomplete impact walk means "there may be consumers I did not see" —
      // a risk only when consumers actually have to be updated. Charging it
      // otherwise bills the author for the analyzer's own precision limits.
      partialImpact: input.impact.partial && input.consumersMustAct ? 10 : 0,
    };
  }

  private getEvidence(input: {
    breakingChanges: BreakingChange[];
    impact: SymbolImpact;
    consumers: ConsumerStanding;
    consumersMustAct: boolean;
    cycles: boolean;
    unusedExport: boolean;
    testCandidates: string[];
    hasTestCoverage: boolean;
  }): ReviewEvidence[] {
    const evidence: ReviewEvidence[] = input.breakingChanges.map((change) => ({ kind: evidenceKindOf(change), detail: change.description }));
    if (input.impact.count > 0) evidence.push({ kind: "impact", detail: `${input.impact.count} known dependent symbol(s).` });
    const consumerTotal = input.consumers.updated.length + input.consumers.covered.length + input.consumers.unverified.length;
    if (consumerTotal > 0) {
      const { updated, covered, unverified } = input.consumers;
      const unverifiedDetail = unverified.length > 0 ? `: ${unverified.join(", ")}` : "";
      const standing = input.consumersMustAct
        ? `${covered.length + unverified.length} must be updated (${covered.length} with tests that will fail, ${unverified.length} unverified${unverifiedDetail})`
        : `${covered.length} covered by tests, ${unverified.length} neither; return-type compatibility is not checked, so these are potentially, not provably, broken: review how each uses the returned value`;
      evidence.push({
        kind: "consumers",
        detail: `${consumerTotal} consumer file(s): ${updated.length} updated in this diff, ${standing}.`,
      });
    }
    if (input.cycles) evidence.push({ kind: "cycle", detail: "Changed symbol participates in a detected symbol dependency cycle, or its file in an import cycle this diff adds." });
    if (input.unusedExport) evidence.push({ kind: "unused-export", detail: "Changed exported symbol is currently reported as unused." });
    if (input.testCandidates.length > 0) {
      evidence.push({ kind: "test-candidate", detail: `Conventional test candidate(s): ${input.testCandidates.join(", ")}.` });
    } else {
      evidence.push({ kind: "test-candidate", detail: "No conventional test candidate found; manual test selection is required." });
    }
    if (input.hasTestCoverage) evidence.push({ kind: "test-candidate", detail: "Symbol is directly depended on by an existing test — a real incompatibility would fail that test." });
    if (input.impact.fileScoped) {
      evidence.push({
        kind: "partial",
        detail: "Vue prop consumers are tracked at the component file boundary; template-level prop usage still requires review.",
      });
    } else if (input.impact.containerScoped) {
      evidence.push({
        kind: "partial",
        detail: "Dependents are tracked per exported symbol, not per member: the count covers consumers of the containing symbol, only some of which touch this member.",
      });
    } else if (input.impact.partial) {
      evidence.push({ kind: "partial", detail: "Impact traversal reached its configured depth limit." });
    }
    return evidence;
  }

  private async getChangedFiles(baseRef: string, headRef: string, maxFiles: number): Promise<string[]> {
    const comparison = headRef === "HEAD" ? baseRef : `${baseRef}...${headRef}`;
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", "--diff-filter=ACMD", comparison, "--"], {
      cwd: this.workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split("\0")
      .filter(Boolean)
      .slice(0, maxFiles)
      .map((filePath) => normalizePath(filePath))
      .sort((left, right) => left.localeCompare(right));
  }

  /** Render an absolute path the way the rest of the report does: workspace-relative. */
  private toWorkspaceRelative(absolutePath: string): string {
    const normalized = normalizePath(absolutePath);
    return normalized.startsWith(`${this.normalizedRoot}/`)
      ? normalized.slice(this.normalizedRoot.length + 1)
      : normalized;
  }

  private resolveWorkspacePath(relativePath: string): string {
    const resolved = normalizePath(path.resolve(this.workspaceRoot, relativePath));
    if (resolved !== this.normalizedRoot && !resolved.startsWith(`${this.normalizedRoot}/`)) {
      throw new Error(`Changed path resolves outside workspace: ${relativePath}`);
    }
    return resolved;
  }

  private async gitShow(ref: string, relativePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["show", `${ref}:${relativePath}`], {
        cwd: this.workspaceRoot,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  /** Head content of a module a changed file re-exports from; null when unresolved or outside the workspace. */
  private async loadHeadModule(fromFile: string, specifier: string, headRef: string): Promise<ReexportedModule | null> {
    const resolved = await this.resolver.resolve(fromFile, specifier);
    if (!resolved) return null;
    let absolutePath: string;
    try {
      absolutePath = this.resolveWorkspacePath(resolved);
    } catch {
      return null;
    }
    const content = await this.readHeadContent(headRef, absolutePath, normalizePath(path.relative(this.normalizedRoot, absolutePath)));
    return content === null ? null : { filePath: absolutePath, content };
  }

  private async readHeadContent(headRef: string, absolutePath: string, relativePath: string): Promise<string | null> {
    if (headRef === "HEAD") {
      try {
        return await fs.readFile(absolutePath, "utf8");
      } catch {
        return null;
      }
    }
    return this.gitShow(headRef, relativePath);
  }

  /** Top-level functions only: a class method is not a factory consumers call by name. */
  private extractTopLevelFunctions(absolutePath: string, content: string): SignatureInfo[] {
    try {
      return this.signatures.extractSignatures(absolutePath, content)
        .filter((signature) => signature.kind === "function" || signature.kind === "arrow");
    } catch {
      return [];
    }
  }

  /**
   * Impact of a changed symbol, plus the consumers of same-file functions that return it.
   *
   * A consumer that types its value as `ReturnType<typeof createX>` (or just uses
   * what `createX()` returns) depends on the factory, never on the type by name, so
   * the dependent index links it to the factory only. Without this, such a consumer
   * is invisible: the gate reported no consumer at all, even one updated in the diff.
   */
  private async getTypeImpact(
    filePath: string,
    symbolName: string,
    maxDepth: number,
    functions: SignatureInfo[],
    headRef: string,
  ): Promise<SymbolImpact> {
    if (!this.dependents) return EMPTY_IMPACT;
    // Identifier match, so `Promise<X>`, `X[]` and `X | undefined` all count as returning X.
    const factories = functions.filter((signature) => signature.name !== symbolName
      && signature.returnType.split(/[^\w$]+/).includes(symbolName));
    const [impact, ...factoryImpacts] = await Promise.all([
      this.getImpact(filePath, symbolName, maxDepth, headRef),
      ...factories.map((factory) => this.walkDependents(filePath, factory.name, maxDepth)),
    ]);
    return factoryImpacts.reduce((merged, next) => mergeImpacts(merged, next), impact);
  }

  private async getImpact(filePath: string, symbolName: string, maxDepth: number, headRef: string): Promise<SymbolImpact> {
    if (!this.dependents) return EMPTY_IMPACT;

    const direct = await this.walkDependents(filePath, symbolName, maxDepth);
    if (direct.count > 0) return direct;

    // The dependent index is keyed on exported symbols, not on class members, so
    // a member lookup yields 0 whether the member truly has no callers or is
    // simply not tracked. Falling back to the container gives a real consumer
    // count, reported as partial: those consumers touch the class, and only some
    // of them touch this member. Without this, every method signature change
    // reads as "confirmed zero impact" and is scored ten times too low.
    const separator = symbolName.indexOf(".");
    if (separator <= 0) return direct;

    const viaContainer = await this.walkDependents(filePath, symbolName.slice(0, separator), maxDepth);
    if (viaContainer.count === 0) return direct;
    const member = await this.keepFilesNamingMember(viaContainer, symbolName, headRef);
    // No consumer of the class even names the member, so none of them can call it.
    if (member.consumerFiles.length === 0 && member.testDependents.length === 0) return direct;
    return { ...member, partial: true, containerScoped: true };
  }

  /**
   * Narrow a container's consumers to the files that name the member.
   *
   * Every file that uses a class is a consumer of the class, but only a file that
   * writes the member's name can call it. Without this, changing one method of a
   * widely used class charged the author for every file that touches the class.
   * A constructor is named by `new Class(` or `super(`, never by "constructor".
   */
  private async keepFilesNamingMember(impact: SymbolImpact, symbolName: string, headRef: string): Promise<SymbolImpact> {
    const mentions = isConstructor(symbolName)
      ? new RegExp(callPattern(symbolName))
      : new RegExp(String.raw`(^|[^\w$])${escapeRegExp(memberName(symbolName))}($|[^\w$])`);
    return this.keepConsumerFiles(impact, headRef, (content) => mentions.test(content));
  }

  /**
   * Narrow consumers to the files that call the symbol with an argument it no longer takes.
   *
   * Removing an optional, defaulted or rest parameter leaves every call that omits
   * it valid: only a call passing at least `breaksCallsWithArgs` arguments breaks.
   * Without this, dropping an optional parameter no caller passed charged the
   * author for every consumer of the symbol.
   */
  private async keepCallsThatBreak(
    impact: SymbolImpact,
    symbolName: string,
    changes: BreakingChange[],
    headRef: string,
  ): Promise<SymbolImpact> {
    const minArgs = argumentsThatBreak(changes);
    if (minArgs === undefined || impact.count === 0) return impact;
    const calls = new RegExp(callPattern(symbolName), "g");
    const narrowed = await this.keepConsumerFiles(impact, headRef, (content) =>
      [...content.matchAll(calls)].some((call) => countArguments(content, call.index + call[0].length) >= minArgs));
    // No call passes the removed argument, so nothing breaks.
    return narrowed.consumerFiles.length === 0 && narrowed.testDependents.length === 0 ? EMPTY_IMPACT : narrowed;
  }

  /** Keep the consumers whose content passes `matches`. A file that cannot be read is kept: unknown is not unaffected. */
  private async keepConsumerFiles(
    impact: SymbolImpact,
    headRef: string,
    matches: (content: string) => boolean,
  ): Promise<SymbolImpact> {
    const files = [...new Set([...impact.consumerFiles, ...impact.testDependents])];
    const contents = await Promise.all(files.map((file) => this.readConsumerContent(file, headRef)));
    const kept = new Set(files.filter((_file, index) => {
      const content = contents[index];
      return content === null || matches(content);
    }));
    const keep = (list: string[]): string[] => list.filter((file) => kept.has(file));
    return {
      ...impact,
      consumerFiles: keep(impact.consumerFiles),
      testDependents: keep(impact.testDependents),
      coveredFiles: keep(impact.coveredFiles),
    };
  }

  private isVuePropsSymbol(symbolName: string): boolean {
    return symbolName.endsWith('.props');
  }

  private async getVuePropsImpact(filePath: string): Promise<SymbolImpact> {
    const findReferences = this.dependents?.findReferencingFilesWithFallback ?? this.dependents?.findReferencingFiles;
    if (!findReferences) return EMPTY_IMPACT;
    const lookupReferences = findReferences.bind(this.dependents);

    try {
      const consumerFiles = new Set<string>();
      const testDependents = new Set<string>();
      for (const reference of await lookupReferences(filePath)) {
        const relative = this.toWorkspaceRelative(normalizePath(reference.path));
        if (relative === this.toWorkspaceRelative(filePath)) continue;
        consumerFiles.add(relative);
        if (this.isTestFilePath(relative)) testDependents.add(relative);
      }
      return {
        count: consumerFiles.size,
        partial: false,
        fileScoped: true,
        testDependents: [...testDependents],
        consumerFiles: [...consumerFiles],
        coveredFiles: [],
      };
    } catch {
      return { ...EMPTY_IMPACT, partial: true, fileScoped: true };
    }
  }

  private async walkDependents(filePath: string, symbolName: string, maxDepth: number): Promise<SymbolImpact> {
    const state: DependentWalkState = {
      seen: new Set<string>(), testDependents: new Set<string>(), consumerFiles: new Set<string>(),
      edges: new Map<string, Set<string>>(), next: [],
    };
    const frontier = await this.walkDependentLevel([{ filePath, symbolName }], maxDepth, state);

    return {
      count: state.seen.size,
      partial: frontier.length > 0,
      testDependents: [...state.testDependents],
      consumerFiles: [...state.consumerFiles],
      coveredFiles: [...state.consumerFiles].filter((file) => this.reachesTestFile(file, state.edges)),
    };
  }

  /**
   * One breadth-first level: the frontier's lookups, then their dependents are
   * collected in frontier order, as a sequential walk would. Returns the unexplored frontier.
   */
  private async walkDependentLevel(
    frontier: Array<{ filePath: string; symbolName: string }>,
    remainingDepth: number,
    state: DependentWalkState,
  ): Promise<Array<{ filePath: string; symbolName: string }>> {
    if (remainingDepth <= 0 || frontier.length === 0) return frontier;
    // 1: the AST worker symbol results depend on which files it has loaded (`export *`), so symbol lookups stay one at a time, in order.
    const dependents = await mapWithConcurrency(frontier, 1, (current) =>
      this.dependents!.getSymbolDependents(current.filePath, current.symbolName));
    state.next = [];
    for (const [index, current] of frontier.entries()) {
      const parent = this.toWorkspaceRelative(current.filePath);
      for (const dependent of dependents[index]) this.collectDependent(parent, dependent, state);
    }
    return this.walkDependentLevel(state.next, remainingDepth - 1, state);
  }

  private collectDependent(
    parent: string,
    dependent: { sourceSymbolId: string },
    state: DependentWalkState,
  ): void {
    const separator = dependent.sourceSymbolId.lastIndexOf(":");
    if (separator <= 0) return;
    const dependentPath = normalizePath(dependent.sourceSymbolId.slice(0, separator));
    const child = this.toWorkspaceRelative(dependentPath);
    if (child !== parent) {
      const children = state.edges.get(parent) ?? new Set<string>();
      children.add(child);
      state.edges.set(parent, children);
    }
    if (this.isTestFilePath(dependentPath)) state.testDependents.add(child);
    else state.consumerFiles.add(child);
    const target = this.parseDependent(dependent.sourceSymbolId, state.seen);
    if (target) state.next.push(target);
  }

  /** Whether any test file is reachable from `file` through the recorded dependent edges. */
  private reachesTestFile(file: string, edges: Map<string, Set<string>>): boolean {
    const visited = new Set([file]);
    const queue = [file];
    while (queue.length > 0) {
      for (const child of edges.get(queue.pop()!) ?? []) {
        if (visited.has(child)) continue;
        if (this.isTestFilePath(child)) return true;
        visited.add(child);
        queue.push(child);
      }
    }
    return false;
  }

  // A test file that directly depends on the changed symbol will fail to compile/run
  // on a real incompatibility — that's live regression coverage, not just a naming hint.
  private isTestFilePath(filePath: string): boolean {
    return /(^|\/)tests\//.test(filePath) || /\.(test|spec)\.[^/]+$/.test(filePath) || isPytestFile(filePath);
  }


  private parseDependent(symbolId: string, seen: Set<string>): { filePath: string; symbolName: string } | null {
    const separator = symbolId.lastIndexOf(":");
    if (separator <= 0) return null;
    const filePath = normalizePath(symbolId.slice(0, separator));
    const symbolName = symbolId.slice(separator + 1);
    const normalizedSymbolId = `${filePath}:${symbolName}`;
    if (seen.has(normalizedSymbolId)) return null;
    seen.add(normalizedSymbolId);
    return { filePath, symbolName };
  }

  private async collectFileEvidence(
    absolutePath: string,
    relativePath: string,
    limitations: string[],
    availability: { cycle: boolean; unused: boolean },
  ): Promise<{ cycleSymbols: Set<string>; unusedSymbols: Set<string>; testCandidates: string[] }> {
    const testCandidates = await this.findTestCandidates(relativePath);
    const cycleSymbols = await this.collectCycleEvidence(absolutePath, relativePath, limitations, availability);
    const unusedSymbols = await this.collectUnusedEvidence(absolutePath, relativePath, limitations, availability);
    return { cycleSymbols, unusedSymbols, testCandidates };
  }

  private async collectCycleEvidence(absolutePath: string, relativePath: string, limitations: string[], availability: { cycle: boolean }): Promise<Set<string>> {
    const cycleSymbols = new Set<string>();
    if (!this.dependents?.getSymbolGraph) {
      if (!availability.cycle) limitations.push("Cycle evidence unavailable: symbol graph provider is not configured.");
      return cycleSymbols;
    }
    try {
      const graph = await this.dependents.getSymbolGraph(absolutePath);
      const cycleIds = detectCycles(graph.dependencies.map((dependency) => ({ source: dependency.sourceSymbolId, target: dependency.targetSymbolId })));
      for (const symbolId of cycleIds) cycleSymbols.add(this.normalizeSymbolId(symbolId));
      availability.cycle = true;
    } catch { limitations.push(`Cycle evidence unavailable for ${relativePath}.`); }
    return cycleSymbols;
  }

  private async collectUnusedEvidence(absolutePath: string, relativePath: string, limitations: string[], availability: { unused: boolean }): Promise<Set<string>> {
    const unusedSymbols = new Set<string>();
    if (!this.dependents?.findUnusedSymbols) {
      if (!availability.unused) limitations.push("Unused-export evidence unavailable: unused-symbol provider is not configured.");
      return unusedSymbols;
    }
    try {
      for (const symbol of await this.dependents.findUnusedSymbols(absolutePath)) unusedSymbols.add(symbol.name);
      availability.unused = true;
    } catch { limitations.push(`Unused-export evidence unavailable for ${relativePath}.`); }
    return unusedSymbols;
  }

  private async findTestCandidates(relativePath: string): Promise<string[]> {
    const extension = path.extname(relativePath);
    const stem = relativePath.slice(0, -extension.length);
    const baseName = path.basename(stem);
    const sourceDir = path.dirname(relativePath);
    // Most repos mirror src/<area>/x.ts as tests/<area>/x.test.ts. Keeping the
    // "src/" segment would look under tests/src/<area>/, which such a layout
    // never has — so the lookup could never succeed and every symbol was scored
    // as untested.
    const segments = sourceDir.split("/");
    const mirroredDir = segments[0] === "src" ? segments.slice(1).join("/") : sourceDir;
    const candidates = [
      `${stem}.test${extension}`,
      `${stem}.spec${extension}`,
      path.join("tests", `${stem}.test${extension}`),
      path.join("tests", sourceDir, `${baseName}.test${extension}`),
      path.join("tests", sourceDir, `${baseName}.spec${extension}`),
      path.join("tests", mirroredDir, `${baseName}.test${extension}`),
      path.join("tests", mirroredDir, `${baseName}.spec${extension}`),
      ...(extension === ".py" ? [
        path.join(sourceDir, `test_${baseName}.py`),
        `${stem}_test.py`,
        path.join("tests", `test_${baseName}.py`),
        path.join("tests", mirroredDir, `test_${baseName}.py`),
      ] : []),
    ].map(normalizePath);
    const sorted = [...new Set(candidates)].sort((left, right) => left.localeCompare(right));
    const exists = await Promise.all(sorted.map(async (candidate) => {
      try {
        await fs.access(this.resolveWorkspacePath(candidate));
        return true;
      } catch { return false; /* Candidate is a hint only; absent files are not errors. */ }
    }));
    return sorted.filter((_candidate, index) => exists[index]);
  }

  private toSymbolId(filePath: string, symbolName: string): string {
    return `${normalizePath(filePath)}:${symbolName}`;
  }

  private normalizeSymbolId(symbolId: string): string {
    const separator = symbolId.lastIndexOf(":");
    return separator > 0 ? this.toSymbolId(symbolId.slice(0, separator), symbolId.slice(separator + 1)) : symbolId;
  }
}

/** `test_x.py` or `x_test.py`: the files pytest collects. */
function isPytestFile(filePath: string): boolean {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  return name.endsWith(".py") && (name.startsWith("test_") || name.endsWith("_test.py"));
}

/** Every member of a moved class meets the same ambiguity: report it once. */
function addLimitation(limitations: string[], limitation: string): void {
  if (!limitations.includes(limitation)) limitations.push(limitation);
}

/** Exported name a result is about: `Class` for `Class.method`. */
function exportedNameOf(symbolName: string): string {
  return symbolName.split(".")[0];
}

function evidenceKindOf(change: BreakingChange): ReviewEvidence["kind"] {
  return change.type === "symbol-moved" ? "moved" : "breaking-change";
}

/**
 * A removal matched with the declaration it moved to. With no file left importing the
 * old path, only the differences from the new declaration remain; otherwise the removal
 * stays, since those importers break.
 */
function movedComparison(
  removal: ReviewComparison,
  differences: BreakingChange[],
  movedTo: string,
  staleImporters: string[],
): ReviewComparison {
  const { symbolName } = removal;
  const move: BreakingChange = {
    type: "symbol-moved", symbolName, severity: "warning", newValue: movedTo,
    description: staleImporters.length > 0
      ? `'${symbolName}' moved to ${movedTo}, but ${staleImporters.length} file(s) may still reach it through the old module: ${staleImporters.join(", ")}`
      : `'${symbolName}' moved to ${movedTo}`,
  };
  return staleImporters.length > 0
    ? { symbolName, breakingChanges: [...removal.breakingChanges, ...differences, move], staleImporters }
    : { symbolName, breakingChanges: [...differences, move], movedTo };
}

/** Stale importers still break even when the diff touches them: they import a name their module no longer exports. */
function markStale(standing: ConsumerStanding, staleImporters: string[]): ConsumerStanding {
  if (staleImporters.length === 0) return standing;
  const stale = new Set(staleImporters);
  return {
    updated: standing.updated.filter((file) => !stale.has(file)),
    covered: standing.covered.filter((file) => !stale.has(file)),
    unverified: [...new Set([...standing.unverified, ...staleImporters])].sort((left, right) => left.localeCompare(right)),
  };
}

/** Stands in for a deleted module that declares no export of its own. */
const MODULE_SYMBOL = "(module)";

/** A deleted file has no head content to collect cycle, unused-export or test evidence from. */
const DELETED_FILE_EVIDENCE: FileEvidence = { cycleSymbols: new Set(), unusedSymbols: new Set(), testCandidates: [], inFileCycle: false, functions: [] };

// `.d.ts` first: a declaration file is imported as `./types`, not `./types.d`.
const MODULE_EXTENSION_REGEX = /(?:\.d)?\.(?:[cm]?[jt]sx?|vue|py)$/i;

/** A folder's entry module, imported by the folder name: `index` in JS/TS, `__init__` in Python. */
const isPackageEntry = (stem: string): boolean => ["index", "__init__"].includes(path.posix.basename(stem));

/** Name a specifier uses for the module: its file name, or its folder's for an `index` or `__init__` file. */
function moduleNameOf(absolutePath: string): string {
  const stem = absolutePath.replace(MODULE_EXTENSION_REGEX, "");
  return path.posix.basename(isPackageEntry(stem) ? path.posix.dirname(stem) : stem);
}

/**
 * Whether `specifier`, written in `fromFile`, names the deleted module. The file is gone, so
 * the resolver cannot say: a relative specifier is resolved by hand; a non-relative one (an alias)
 * matches when it is the tail of the module's path, so unknown is kept rather than dropped.
 */
function namesDeletedModule(fromFile: string, specifier: string, deleted: string): boolean {
  const stem = deleted.replace(MODULE_EXTENSION_REGEX, "");
  const targets = new Set([stem, isPackageEntry(stem) ? path.posix.dirname(stem) : stem]);
  if (path.extname(fromFile).toLowerCase() === ".py") return namesDeletedPythonModule(fromFile, specifier, targets);
  const target = specifier.replace(MODULE_EXTENSION_REGEX, "");
  if (specifier.startsWith(".")) return targets.has(normalizePath(path.resolve(path.dirname(fromFile), target)));
  // shortcut: a bare package named like the module (`react` vs src/react.ts) is kept as an importer; narrow to the tsconfig aliases when that noise shows up.
  const tail = `/${target.replace(/^[@~#]\//, "")}`;
  return [...targets].some((candidate) => candidate.endsWith(tail));
}

/**
 * Python form of `namesDeletedModule`: `..pkg.mod` climbs one folder per dot after the first, then follows the
 * dotted path; an absolute `pkg.mod` matches when it is the tail of the module's path.
 */
function namesDeletedPythonModule(fromFile: string, specifier: string, targets: ReadonlySet<string>): boolean {
  const dots = specifier.length - specifier.replace(/^\.+/, "").length;
  const dotted = specifier.slice(dots).split(".").filter(Boolean);
  if (dots === 0) return [...targets].some((candidate) => candidate.endsWith(`/${dotted.join("/")}`));
  const base = path.resolve(path.dirname(fromFile), ...Array<string>(dots - 1).fill(".."));
  return targets.has(normalizePath(path.resolve(base, ...dotted)));
}

const EMPTY_IMPACT: SymbolImpact = {
  count: 0, partial: false, testDependents: [], consumerFiles: [], coveredFiles: [],
};

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function memberName(symbolName: string): string {
  return symbolName.slice(symbolName.lastIndexOf(".") + 1);
}

function isConstructor(symbolName: string): boolean {
  return symbolName.endsWith(".constructor");
}

/**
 * Source of a regex matching a call to the symbol up to its opening `(`: `new Class(`
 * or `super(` for a constructor, `name(` otherwise. Type arguments are allowed.
 * ponytail: textual, so an aliased import or a call through a variable is missed;
 * use the call graph's call sites if that ever matters.
 */
function callPattern(symbolName: string): string {
  const callee = isConstructor(symbolName)
    ? String.raw`(?:\bnew\s+${escapeRegExp(symbolName.slice(0, symbolName.lastIndexOf(".")))}|\bsuper)`
    : String.raw`(?:^|[^\w$])${escapeRegExp(memberName(symbolName))}`;
  return String.raw`${callee}\s*(?:<[^()]*>)?\s*\(`;
}

/** Fewest arguments a breaking call passes, or undefined when some change breaks every call. */
function argumentsThatBreak(changes: BreakingChange[]): number | undefined {
  let fewest: number | undefined;
  for (const change of changes) {
    if (change.breaksCallsWithArgs === undefined) return undefined;
    fewest = Math.min(fewest ?? Infinity, change.breaksCallsWithArgs);
  }
  return fewest;
}

/** Index just past the string or comment starting at `index`, or `index` when none starts there. */
function skipLiteral(text: string, index: number): number {
  const quote = text[index];
  if (quote === '"' || quote === "'" || quote === "`") {
    let end = index + 1;
    while (end < text.length && text[end] !== quote) end += text[end] === "\\" ? 2 : 1;
    return end + 1;
  }
  let close: string;
  if (text.startsWith("//", index)) close = "\n";
  else if (text.startsWith("/*", index)) close = "*/";
  else return index;
  const end = text.indexOf(close, index + 2);
  return end === -1 ? text.length : end + close.length;
}

/**
 * Number of arguments of the call whose `(` ends just before `start`. A spread or
 * an unclosed call counts as Infinity: when unsure, the call is kept.
 */
function countArguments(text: string, start: number): number {
  let depth = 0;
  let commas = 0;
  let empty = true;
  let index = start;
  while (index < text.length) {
    const skipped = skipLiteral(text, index);
    if (skipped !== index) {
      empty = false;
      index = skipped;
      continue;
    }
    const char = text[index];
    if (depth === 0) {
      if (")]}".includes(char)) return commas + Number(!empty);
      if (text.startsWith("...", index)) return Infinity;
      if (char === ",") commas++;
    }
    depth += Number("([{".includes(char)) - Number(")]}".includes(char));
    empty &&= /\s/.test(char);
    index++;
  }
  return Infinity;
}

/** Union of two walks; the count is a sum, so a dependent reached through both counts twice. */
function mergeImpacts(left: SymbolImpact, right: SymbolImpact): SymbolImpact {
  const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];
  return {
    ...left,
    count: left.count + right.count,
    partial: left.partial || right.partial,
    testDependents: union(left.testDependents, right.testDependents),
    consumerFiles: union(left.consumerFiles, right.consumerFiles),
    coveredFiles: union(left.coveredFiles, right.coveredFiles),
  };
}

/** Result of walking the dependent graph for one changed symbol. */
interface SymbolImpact {
  count: number;
  /** The count is an over- or under-estimate; see containerScoped. */
  partial: boolean;
  /** Counted against the containing symbol because members are not tracked. */
  containerScoped?: boolean;
  /** Consumer files were found through a Vue component's file-level imports. */
  fileScoped?: boolean;
  testDependents: string[];
  /** Production consumer files found in the walk, workspace-relative. */
  consumerFiles: string[];
  /** Consumer files from which a test file is reachable in the walk. */
  coveredFiles: string[];
}

export function riskForScore(score: number): ReviewRiskLevel {
  if (score >= 80) return "critical";
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function renderReviewMarkdown(result: ReviewGateResult): string {
  const safe = (value: string): string => value.replaceAll(/[\r\n|<>]/g, " ").replaceAll("`", "'").trim();
  // The consumer columns are the point of the report: a reviewer needs to see what
  // the change still leaves unchecked, not how widely the contract is used.
  const rows = result.symbols.slice(0, 20).map((symbol) =>
    `| ${safe(symbol.risk)} | ${symbol.score} | ${safe(symbol.filePath)} | ${safe(symbol.name)} | ${symbol.consumers.updated.length} | ${symbol.consumers.covered.length} | ${symbol.consumers.unverified.length} |`,
  );

  const untouchedConsumers = (symbol: ReviewSymbol): string =>
    `- ${safe(symbol.name)}: ${[...symbol.consumers.covered, ...symbol.consumers.unverified].map(safe).join(", ")}`;

  // A non-zero consumer weight means the change breaks call sites, so every
  // untouched consumer is to check — a tested one included.
  const unverified = result.symbols
    .filter((symbol) => symbol.scoreFactors.unverifiedConsumers > 0)
    .slice(0, 10)
    .map(untouchedConsumers);

  // A return-type-only change charges no consumer, yet any of them may use the
  // returned value in a way the new type no longer supports (#530).
  const returnTypeConsumers = result.symbols
    .filter((symbol) => symbol.scoreFactors.unverifiedConsumers === 0
      && symbol.consumers.covered.length + symbol.consumers.unverified.length > 0
      && symbol.breakingChanges.some((change) => change.type === "return-type-changed"))
    .slice(0, 10)
    .map(untouchedConsumers);

  const moved = result.symbols
    .flatMap((symbol) => symbol.evidence.filter((item) => item.kind === "moved").map((item) => `- ${safe(item.detail)}`))
    .slice(0, 20);

  const cycles = result.cycles.slice(0, 10).map((cycle) => `- ${cycle.classification}: ${cycle.files.map(safe).join(" <-> ")}`);

  return [
    "<!-- graph-it-review-gate -->",
    `## Graph-It Review Gate: ${result.risk.toUpperCase()} (${result.score}/100)`,
    "",
    `Changed files: ${result.changedFiles.length}. ${result.isPartial ? "Partial analysis; see limitations." : "Complete within configured limits."}`,
    "",
    "| Risk | Score | File | Symbol | Updated | Covered | Unverified |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: |",
    ...(rows.length > 0 ? rows : ["| low | 0 | — | No breaking signatures detected | 0 | 0 | 0 |"]),
    ...(unverified.length > 0 ? ["", "### Consumers to check", ...unverified] : []),
    ...(returnTypeConsumers.length > 0
      ? ["", "### Return type changed: consumers to re-check", "Compatibility of each use of the returned value is not checked; these consumers are potentially, not provably, broken.", ...returnTypeConsumers]
      : []),
    ...(moved.length > 0 ? ["", "### Moved symbols", ...moved] : []),
    ...(cycles.length > 0 ? ["", "### Import cycles", ...cycles] : []),
    ...(result.limitations.length > 0 ? ["", "### Limitations", ...result.limitations.map((item) => `- ${safe(item)}`)] : []),
  ].join("\n");
}
