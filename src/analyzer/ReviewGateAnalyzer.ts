import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { normalizePath } from "../shared/path";
import { detectCycles } from "./callgraph/cycleUtils";
import { SignatureAnalyzer, type BreakingChange } from "./SignatureAnalyzer";
import type { SymbolDependency, SymbolInfo } from "./types";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_DEPTH = 3;
const MAX_MAX_FILES = 1_000;
const MAX_MAX_DEPTH = 10;
const SIGNATURE_ANALYSIS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export type ReviewRiskLevel = "low" | "medium" | "high" | "critical";

export interface ReviewGateOptions {
  baseRef: string;
  headRef?: string;
  maxFiles?: number;
  maxDepth?: number;
}

export interface ReviewEvidence {
  kind: "breaking-change" | "impact" | "cycle" | "unused-export" | "test-candidate" | "partial";
  detail: string;
}

export interface ReviewScoreFactors {
  breakingChanges: number;
  dependents: number;
  cycles: number;
  unusedExport: number;
  missingTestCandidate: number;
  partialImpact: number;
}

export interface ReviewSymbol {
  name: string;
  filePath: string;
  score: number;
  risk: ReviewRiskLevel;
  breakingChanges: BreakingChange[];
  impactedSymbolCount: number;
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
  getSymbolGraph?(filePath: string): Promise<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }>;
  findUnusedSymbols?(filePath: string): Promise<SymbolInfo[]>;
}

interface FileEvidence {
  cycleSymbols: Set<string>;
  unusedSymbols: Set<string>;
  testCandidates: string[];
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
    const changedFiles = await this.getChangedFiles(options.baseRef, headRef, maxFiles);
    const symbols: ReviewSymbol[] = [];
    const limitations: string[] = [];
    const analysisAvailability = { cycle: false, unused: false };

    if (changedFiles.length === maxFiles) {
      limitations.push(`Analysis limited to ${maxFiles} changed files.`);
    }

    for (const relativePath of changedFiles) {
      symbols.push(...await this.analyzeChangedFile(relativePath, options.baseRef, headRef, maxDepth, limitations, analysisAvailability));
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
  ): Promise<ReviewSymbol[]> {
    if (!SIGNATURE_ANALYSIS_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      limitations.push(`Signature and symbol evidence unavailable for unsupported file type: ${relativePath}.`);
      return [];
    }
    const absolutePath = this.resolveWorkspacePath(relativePath);
    const [oldContent, newContent] = await Promise.all([
      this.gitShow(baseRef, relativePath),
      this.readHeadContent(headRef, absolutePath, relativePath),
    ]);
    if (oldContent === null || newContent === null) {
      limitations.push(`Could not compare ${relativePath}; file was added, deleted, or unreadable.`);
      return [];
    }
    const fileEvidence = await this.collectFileEvidence(absolutePath, relativePath, limitations, availability);
    const comparisons = this.analyzeSignatures(absolutePath, relativePath, oldContent, newContent, limitations);
    return Promise.all(comparisons.map((comparison) => this.createReviewSymbol(comparison, absolutePath, relativePath, maxDepth, fileEvidence)));
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
  ): Promise<ReviewSymbol> {
    const impact = comparison.breakingChanges.length > 0
      ? await this.getImpact(absolutePath, comparison.symbolName, maxDepth)
      : { count: 0, partial: false };
    const cycles = fileEvidence.cycleSymbols.has(this.toSymbolId(absolutePath, comparison.symbolName));
    const unusedExport = fileEvidence.unusedSymbols.has(comparison.symbolName);
    const scoreFactors = this.getScoreFactors(comparison.breakingChanges.length, impact, cycles, unusedExport, fileEvidence.testCandidates.length);
    const score = Math.min(100, Object.values(scoreFactors).reduce((total, value) => total + value, 0));
    return {
      name: comparison.symbolName, filePath: relativePath, score, risk: riskForScore(score),
      breakingChanges: comparison.breakingChanges, impactedSymbolCount: impact.count,
      cycleEvidence: cycles ? [comparison.symbolName] : [], unusedExportEvidence: unusedExport,
      testCandidates: fileEvidence.testCandidates, scoreFactors,
      evidence: this.getEvidence(comparison.breakingChanges, impact, cycles, unusedExport, fileEvidence.testCandidates),
    };
  }

  private getScoreFactors(breakingChangeCount: number, impact: { count: number; partial: boolean }, cycles: boolean, unusedExport: boolean, testCandidateCount: number): ReviewScoreFactors {
    return {
      breakingChanges: breakingChangeCount * 50, dependents: impact.count * 5, cycles: cycles ? 20 : 0,
      unusedExport: unusedExport ? 10 : 0, missingTestCandidate: testCandidateCount === 0 ? 10 : 0, partialImpact: impact.partial ? 10 : 0,
    };
  }

  private getEvidence(breakingChanges: BreakingChange[], impact: { count: number; partial: boolean }, cycles: boolean, unusedExport: boolean, testCandidates: string[]): ReviewEvidence[] {
    const evidence: ReviewEvidence[] = breakingChanges.map((change) => ({ kind: "breaking-change", detail: change.description }));
    if (impact.count > 0) evidence.push({ kind: "impact", detail: `${impact.count} known dependent symbol(s).` });
    if (cycles) evidence.push({ kind: "cycle", detail: "Changed symbol participates in a detected symbol dependency cycle." });
    if (unusedExport) evidence.push({ kind: "unused-export", detail: "Changed exported symbol is currently reported as unused." });
    evidence.push(testCandidates.length > 0
      ? { kind: "test-candidate", detail: `Conventional test candidate(s): ${testCandidates.join(", ")}.` }
      : { kind: "test-candidate", detail: "No conventional test candidate found; manual test selection is required." });
    if (impact.partial) evidence.push({ kind: "partial", detail: "Impact traversal reached its configured depth limit." });
    return evidence;
  }

  private async getChangedFiles(baseRef: string, headRef: string, maxFiles: number): Promise<string[]> {
    const comparison = headRef === "HEAD" ? baseRef : `${baseRef}...${headRef}`;
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=ACMR", comparison], {
      cwd: this.workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split("\n")
      .filter(Boolean)
      .slice(0, maxFiles)
      .map((filePath) => normalizePath(filePath))
      .sort();
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

  private async getImpact(filePath: string, symbolName: string, maxDepth: number): Promise<{ count: number; partial: boolean }> {
    if (!this.dependents) return { count: 0, partial: false };
    const seen = new Set<string>();
    let frontier = [{ filePath, symbolName }];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      frontier = await this.collectDependentFrontier(frontier, seen);
    }
    return { count: seen.size, partial: frontier.length > 0 };
  }

  private async collectDependentFrontier(
    frontier: Array<{ filePath: string; symbolName: string }>,
    seen: Set<string>,
  ): Promise<Array<{ filePath: string; symbolName: string }>> {
    const next: Array<{ filePath: string; symbolName: string }> = [];
    for (const current of frontier) {
      const dependents = await this.dependents!.getSymbolDependents(current.filePath, current.symbolName);
      for (const dependent of dependents) {
        const target = this.parseDependent(dependent.sourceSymbolId, seen);
        if (target) next.push(target);
      }
    }
    return next;
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
    const candidates = [
      `${stem}.test${extension}`,
      `${stem}.spec${extension}`,
      path.join("tests", `${relativePath}.test${extension}`),
      path.join("tests", path.dirname(relativePath), `${baseName}.test${extension}`),
      path.join("tests", path.dirname(relativePath), `${baseName}.spec${extension}`),
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

export function riskForScore(score: number): ReviewRiskLevel {
  if (score >= 80) return "critical";
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function renderReviewMarkdown(result: ReviewGateResult): string {
  const safe = (value: string): string => value.replaceAll(/[\r\n|<>]/g, " ").replaceAll("`", "'").trim();
  const rows = result.symbols.slice(0, 20).map((symbol) =>
    `| ${safe(symbol.risk)} | ${symbol.score} | ${safe(symbol.filePath)} | ${safe(symbol.name)} | ${symbol.impactedSymbolCount} |`,
  );
  return [
    "<!-- graph-it-review-gate -->",
    `## Graph-It Review Gate: ${result.risk.toUpperCase()} (${result.score}/100)`,
    "",
    `Changed files: ${result.changedFiles.length}. ${result.isPartial ? "Partial analysis; see limitations." : "Complete within configured limits."}`,
    "",
    "| Risk | Score | File | Symbol | Dependents |",
    "| --- | ---: | --- | --- | ---: |",
    ...(rows.length > 0 ? rows : ["| low | 0 | — | No breaking signatures detected | 0 |"]),
    ...(result.limitations.length > 0 ? ["", "### Limitations", ...result.limitations.map((item) => `- ${safe(item)}`)] : []),
  ].join("\n");
}
