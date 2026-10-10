import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { SUPPORTED_SOURCE_FILE_REGEX } from "../shared/constants";
import { normalizePath } from "../shared/path";
import { detectCycles } from "./callgraph/cycleUtils";
import { SignatureAnalyzer, type BreakingChange, type SignatureInfo } from "./SignatureAnalyzer";
import type { SymbolDependency, SymbolInfo } from "./types";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_DEPTH = 3;
const MAX_MAX_FILES = 1_000;
const MAX_MAX_DEPTH = 10;
/** Bound on the reverse-index walk used to decide whether a consumer is under test. */
const MAX_COVERAGE_LOOKUP_FILES = 200;
const SIGNATURE_ANALYSIS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);

export type ReviewRiskLevel = "low" | "medium" | "high" | "critical";

export interface ReviewGateOptions {
  baseRef: string;
  headRef?: string;
  maxFiles?: number;
  maxDepth?: number;
}

export interface ReviewEvidence {
  kind: "breaking-change" | "impact" | "consumers" | "cycle" | "unused-export" | "test-candidate" | "partial";
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

export interface ReviewGateResult {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  symbols: ReviewSymbol[];
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
}

interface FileEvidence {
  cycleSymbols: Set<string>;
  unusedSymbols: Set<string>;
  testCandidates: string[];
  /** Top-level functions of the changed file, read from its new content. */
  functions: SignatureInfo[];
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

  constructor(
    private readonly workspaceRoot: string,
    private readonly dependents?: SymbolDependentsProvider,
  ) {
    this.normalizedRoot = normalizePath(path.resolve(workspaceRoot));
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

    for (const relativePath of changedFiles) {
      symbols.push(...await this.analyzeChangedFile(relativePath, options.baseRef, headRef, maxDepth, limitations, analysisAvailability, changedFileSet));
    }

    symbols.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
    const score = symbols.reduce((highest, symbol) => Math.max(highest, symbol.score), 0);
    return {
      baseRef: options.baseRef,
      headRef,
      changedFiles,
      symbols,
      score,
      risk: riskForScore(score),
      isPartial: limitations.length > 0,
      limitations,
    };
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

  private async analyzeChangedFile(
    relativePath: string,
    baseRef: string,
    headRef: string,
    maxDepth: number,
    limitations: string[],
    availability: { cycle: boolean; unused: boolean },
    changedFiles: ReadonlySet<string>,
  ): Promise<ReviewSymbol[]> {
    if (!SIGNATURE_ANALYSIS_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      // Only source code can carry a contract the gate fails to check. Reporting a
      // README or a workflow file as a gap made almost every review "partial".
      if (SUPPORTED_SOURCE_FILE_REGEX.test(relativePath)) {
        limitations.push(`Signature and symbol evidence unavailable for unsupported file type: ${relativePath}.`);
      }
      return [];
    }
    const absolutePath = this.resolveWorkspacePath(relativePath);
    const [oldContent, newContent] = await Promise.all([
      this.gitShow(baseRef, relativePath),
      this.readHeadContent(headRef, absolutePath, relativePath),
    ]);
    if (newContent === null) {
      limitations.push(`Could not compare ${relativePath}; file was deleted or unreadable.`);
      return [];
    }
    // A file the diff adds has no prior signature, so nothing downstream can have
    // depended on it and no breaking change is possible. Reporting it as an
    // unanalyzable gap marked every added file — a new test above all — as a
    // limitation, inflating the review instead of crediting the addition.
    if (oldContent === null) return [];
    const fileEvidence = {
      ...await this.collectFileEvidence(absolutePath, relativePath, limitations, availability),
      functions: this.extractTopLevelFunctions(absolutePath, newContent),
    };
    const comparisons = this.analyzeSignatures(absolutePath, relativePath, oldContent, newContent, limitations);
    return Promise.all(comparisons.map((comparison) => this.createReviewSymbol(comparison, absolutePath, relativePath, maxDepth, fileEvidence, changedFiles, headRef)));
  }

  private analyzeSignatures(absolutePath: string, relativePath: string, oldContent: string, newContent: string, limitations: string[]): Array<{ symbolName: string; breakingChanges: BreakingChange[] }> {
    try {
      return this.signatures.analyzeBreakingChanges(absolutePath, oldContent, newContent);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown parser error";
      limitations.push(`Signature evidence unavailable for ${relativePath}: ${detail}.`);
      return [];
    }
  }

  private async createReviewSymbol(
    comparison: { symbolName: string; breakingChanges: BreakingChange[] },
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
    // Member-level changes (a single interface/class member removed or retyped) only
    // implicate direct consumers of that member. Hop 2+ chases callers of the *type's*
    // consumers (e.g. everyone who calls a class that merely returns the type) — noise
    // unrelated to the specific member being changed.
    const isMemberLevelChange = errorBreakingChanges.length > 0
      && errorBreakingChanges.every((change) => change.type === "member-removed" || change.type === "member-renamed" || change.type === "member-type-changed" || change.type === "member-optional-to-required");
    const effectiveMaxDepth = isMemberLevelChange ? 1 : maxDepth;
    const contractImpact: SymbolImpact = errorBreakingChanges.length > 0
      ? this.isVuePropsSymbol(comparison.symbolName)
        ? await this.getVuePropsImpact(absolutePath)
        : await this.getTypeImpact(absolutePath, comparison.symbolName, effectiveMaxDepth, fileEvidence.functions, headRef)
      : EMPTY_IMPACT;
    const impact = await this.keepCallsThatBreak(contractImpact, comparison.symbolName, errorBreakingChanges, headRef);
    const cycles = fileEvidence.cycleSymbols.has(this.toSymbolId(absolutePath, comparison.symbolName));
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
    const consumers = await this.getConsumerStanding(impact, changedFiles);
    const consumersMustAct = this.requiresConsumerUpdate(errorBreakingChanges);
    const scoreFactors = this.getScoreFactors({
      breakingChangeCount: errorBreakingChanges.length, impact, consumers, consumersMustAct, cycles, unusedExport,
      testCandidateCount: allTestCandidates.length, hasConfirmedZeroImpact, hasTestCoverage,
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
   * the author as unhandled work.
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
    for (const file of [...impact.consumerFiles].sort((a, b) => a.localeCompare(b))) {
      if (changedFiles.has(file)) standing.updated.push(file);
      else if (covered.has(file) || await this.hasTestDependent(file)) standing.covered.push(file);
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
      return { breakingChanges: 0, unverifiedConsumers: 0, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 0 };
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
    const evidence: ReviewEvidence[] = input.breakingChanges.map((change) => ({ kind: "breaking-change", detail: change.description }));
    if (input.impact.count > 0) evidence.push({ kind: "impact", detail: `${input.impact.count} known dependent symbol(s).` });
    const consumerTotal = input.consumers.updated.length + input.consumers.covered.length + input.consumers.unverified.length;
    if (consumerTotal > 0) {
      const { updated, covered, unverified } = input.consumers;
      const unverifiedDetail = unverified.length > 0 ? `: ${unverified.join(", ")}` : "";
      const standing = input.consumersMustAct
        ? `${covered.length + unverified.length} must be updated (${covered.length} with tests that will fail, ${unverified.length} unverified${unverifiedDetail})`
        : `${covered.length} covered by tests, ${unverified.length} neither, but this change requires no call-site update`;
      evidence.push({
        kind: "consumers",
        detail: `${consumerTotal} consumer file(s): ${updated.length} updated in this diff, ${standing}.`,
      });
    }
    if (input.cycles) evidence.push({ kind: "cycle", detail: "Changed symbol participates in a detected symbol dependency cycle." });
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
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--diff-filter=ACMR", comparison, "--"], {
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
    // Identifier match, so `Promise<X>`, `X[]` and `X | undefined` all count as returning X.
    const factories = functions.filter((signature) => signature.name !== symbolName
      && signature.returnType.split(/[^\w$]+/).includes(symbolName));
    let impact = await this.getImpact(filePath, symbolName, maxDepth, headRef);
    for (const factory of factories) {
      impact = mergeImpacts(impact, await this.walkDependents(filePath, factory.name, maxDepth));
    }
    return impact;
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
    let frontier = [{ filePath, symbolName }];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      state.next = [];
      for (const current of frontier) {
        const parent = this.toWorkspaceRelative(current.filePath);
        for (const dependent of await this.dependents!.getSymbolDependents(current.filePath, current.symbolName)) {
          this.collectDependent(parent, dependent, state);
        }
      }
      frontier = state.next;
    }

    return {
      count: state.seen.size,
      partial: frontier.length > 0,
      testDependents: [...state.testDependents],
      consumerFiles: [...state.consumerFiles],
      coveredFiles: [...state.consumerFiles].filter((file) => this.reachesTestFile(file, state.edges)),
    };
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
    return /(^|\/)tests\//.test(filePath) || /\.(test|spec)\.[^/]+$/.test(filePath);
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
    ].map(normalizePath);
    const found: string[] = [];
    for (const candidate of [...new Set(candidates)].sort((left, right) => left.localeCompare(right))) {
      try {
        await fs.access(this.resolveWorkspacePath(candidate));
        found.push(candidate);
      } catch { /* Candidate is a hint only; absent files are not errors. */ }
    }
    return found;
  }

  private toSymbolId(filePath: string, symbolName: string): string {
    return `${normalizePath(filePath)}:${symbolName}`;
  }

  private normalizeSymbolId(symbolId: string): string {
    const separator = symbolId.lastIndexOf(":");
    return separator > 0 ? this.toSymbolId(symbolId.slice(0, separator), symbolId.slice(separator + 1)) : symbolId;
  }
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

  // A non-zero consumer weight means the change breaks call sites, so every
  // untouched consumer is to check — a tested one included.
  const unverified = result.symbols
    .filter((symbol) => symbol.scoreFactors.unverifiedConsumers > 0)
    .slice(0, 10)
    .map((symbol) => `- ${safe(symbol.name)}: ${[...symbol.consumers.covered, ...symbol.consumers.unverified].map(safe).join(", ")}`);

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
    ...(result.limitations.length > 0 ? ["", "### Limitations", ...result.limitations.map((item) => `- ${safe(item)}`)] : []),
  ].join("\n");
}
