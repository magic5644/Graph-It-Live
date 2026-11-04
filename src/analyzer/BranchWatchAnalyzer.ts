import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { mapWithConcurrency } from '@/shared/concurrency';
import { normalizePath, normalizePathForComparison } from '@/shared/path';
import { resolveReviewCallGraphPath } from '@/shared/reviewTarget';
import { LanguageService } from './LanguageService';
import type { SignatureComparisonResult } from './SignatureAnalyzer';
import { hasSignatureAnalysis, REVIEW_GATE_MAX_FILES_LIMIT, ReviewGateAnalyzer, type FileCycleAnalysis, type ReviewGateResult, type SymbolDependentsProvider } from './ReviewGateAnalyzer';
import { detectCycleEdges } from '../shared/cycleUtils';
import type { GraphEdge } from '../shared/graph-types';
import { readTreeImports, treeAnalyzer } from './architecture/architectureReview';
import type { AnalyzeFile } from './architecture/ArchitectureGraphBuilder';
import { checkText, MAX_TEXT_FILE_BYTES, readWorkspaceText, resolveRegularFile } from './utils/workspaceText';

const execFileAsync = promisify(execFile);
export const BRANCH_WATCH_MAX_FILES = 200;
export const BRANCH_WATCH_MAX_FILES_LIMIT = 2000;
const CONFIG_FILES = /(?:^|\/)(?:tsconfig[^/]*\.json|package\.json|go\.mod|Cargo\.toml)$/;
/** Root ignore files and architecture rules: with the source and config files, what a tree copy must hold. */
const ROOT_FILES = /^(?:\.gitignore|\.graphitignore|graphit\.architecture(?:\.baseline)?\.json)$/;

interface TreeEntry {
  mode: string;
  sha: string;
  size: number;
  file: string;
}

/** Blob bytes read by one `git cat-file --batch` process. */
const BLOB_BATCH_BYTES = 32 * 1024 * 1024;

/** `entries` in order, split so that each batch reads at most BLOB_BATCH_BYTES (or one larger blob). */
function blobBatches(entries: readonly TreeEntry[]): TreeEntry[][] {
  const batches: TreeEntry[][] = [];
  let bytes = Infinity;
  for (const entry of entries) {
    if (bytes + entry.size > BLOB_BATCH_BYTES) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1)!.push(entry);
    bytes += entry.size;
  }
  return batches;
}

/** The blobs of `git cat-file --batch` output: `<sha> blob <size>\n<content>\n` each, in request order. */
export function parseCatFileBatch(output: Buffer): Buffer[] {
  const blobs: Buffer[] = [];
  let at = 0;
  while (at < output.length) {
    const end = output.indexOf(10, at);
    const [sha, type, size] = output.toString('utf8', at, end === -1 ? output.length : end).split(' ');
    const bytes = Number(size);
    if (end === -1 || type !== 'blob' || !Number.isInteger(bytes) || end + 1 + bytes > output.length) {
      throw new BranchWatchError('git-error', `Git returned no readable blob for ${sha}.`);
    }
    blobs.push(output.subarray(end + 1, end + 1 + bytes));
    at = end + 2 + bytes;
  }
  return blobs;
}

export type BranchWatchErrorCode = 'not-a-repository' | 'git-unavailable' | 'unborn-head' | 'ambiguous-root'
  | 'unsupported-vcs' | 'detached-head' | 'conflicts' | 'invalid-reference' | 'ambiguous-base' | 'git-error';

export class BranchWatchError extends Error {
  constructor(readonly code: BranchWatchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BranchWatchError';
  }
}

export interface BranchWatchChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'untracked' | 'type-changed';
}

export interface BranchWatchSnapshot {
  reference: string;
  referenceSha: string;
  /** Explicit head ref when comparing two committed refs; empty means worktree. */
  headReference?: string;
  branch: string;
  headSha: string;
  mergeBaseSha: string;
  fingerprint: string;
  changes: BranchWatchChange[];
  limitations: string[];
  /** Only regular, bounded text files may enter the analysis. */
  readablePaths: string[];
}

export interface BranchWatchFileImpact {
  path: string;
  dependents: Array<{ path: string; depth: number; changed: boolean }>;
  availability: 'available' | 'partial' | 'unavailable';
  limitations: string[];
}
export interface BranchWatchCycleFinding {
  classification: 'introduced' | 'aggravated' | 'existing-touched';
  nodePaths: string[];
  edgeKeys: string[];
  changedPaths: string[];
  relation: 'file-dependency';
  recommendation: 'review-design';
  limitations: string[];
}
export interface BranchWatchResult {
  snapshot: BranchWatchSnapshot;
  fileImpacts: BranchWatchFileImpact[];
  cycles: BranchWatchCycleFinding[];
  /** Number of cycles through the changed files, and whether the head and base import graphs were read completely. */
  cycleSummary?: { detected: number; scopeComplete: boolean };
  review: ReviewGateResult;
  limitations: string[];
  analyzedAt: number;
}
interface FileGraph {
  edges: GraphEdge[];
  limitations: string[];
}

/** Encodes paths before the arrow-delimited cycle edge keys (Git filenames may contain arrows); keeps containment marks. */
function encodeEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return edges.map(e => ({ ...e, source: encodeURIComponent(e.source), target: encodeURIComponent(e.target) }));
}
/** What the cycle analysis reads of a snapshot: the changed files, the base to compare with, and an explicit head ref. */
export type CycleScope = Pick<BranchWatchSnapshot, 'changes' | 'mergeBaseSha'> & Partial<Pick<BranchWatchSnapshot, 'headReference' | 'headSha'>>;
export interface CycleAnalysis {
  findings: BranchWatchCycleFinding[];
  summary: { detected: number; scopeComplete: boolean };
}

function classifyCycles(current: GraphEdge[], baseline: GraphEdge[], changes: readonly BranchWatchChange[]): BranchWatchCycleFinding[] {
  const currentEdges = detectCycleEdges(encodeEdges(current));
  const oldEdges = detectCycleEdges(encodeEdges(baseline));
  const oldNodes = new Set([...oldEdges].flatMap(e => e.split('->')));
  const remaining = new Set(currentEdges);
  const findings: BranchWatchCycleFinding[] = [];
  while (remaining.size) {
    const edges = [remaining.values().next().value!];
    remaining.delete(edges[0]);
    const nodes = new Set(edges[0].split('->'));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const edge of remaining) {
        const [source, target] = edge.split('->');
        if (nodes.has(source) || nodes.has(target)) {
          nodes.add(source); nodes.add(target); edges.push(edge); remaining.delete(edge); expanded = true;
        }
      }
    }
    const nodePaths = [...nodes].map(decodeURIComponent).sort((left, right) => left.localeCompare(right));
    const changedPaths = changes.filter(c => ['modified', 'added', 'untracked', 'type-changed'].includes(c.kind) && nodePaths.includes(c.path)).map(c => c.path);
    if (!changedPaths.length) continue;
    let classification: BranchWatchCycleFinding['classification'] = 'introduced';
    if (edges.every(e => oldEdges.has(e))) classification = 'existing-touched';
    else if ([...nodes].some(n => oldNodes.has(n))) classification = 'aggravated';
    const edgeKeys = edges.toSorted((left, right) => left.localeCompare(right));
    findings.push({ classification, nodePaths, edgeKeys, changedPaths, relation: 'file-dependency', recommendation: 'review-design', limitations: [] });
  }
  return findings;
}

/**
 * Import cycles the diff adds among `changedFiles` (introduced or aggravated), read from the whole
 * head and base import graphs of a review: no file budget (#603), as Branch Watch reads them (#605).
 */
export function addedFileCycles(head: GraphEdge[], base: GraphEdge[], changedFiles: readonly string[]): FileCycleAnalysis['cycles'] {
  // A deleted file is in no head edge, so it can never be a changed file of a head cycle.
  const changes = changedFiles.map((file): BranchWatchChange => ({ path: normalizePath(file), kind: 'modified' }));
  return classifyCycles(head, base, changes).flatMap(({ classification, nodePaths, changedPaths }) =>
    classification === 'existing-touched' ? [] : [{ classification, files: nodePaths, changedFiles: changedPaths }]);
}

export function normalizeBranchWatchMaxFiles(value: number): number {
  if (!Number.isFinite(value)) return BRANCH_WATCH_MAX_FILES;
  return Math.min(BRANCH_WATCH_MAX_FILES_LIMIT, Math.max(1, Math.trunc(value)));
}

/** Local, read-only Git capture; independent of VS Code settings and runtime. */
export class BranchWatchAnalyzer {
  /** Whole import graphs of committed trees by SHA: the merge base, and an explicit head ref. */
  private readonly refGraphs = new Map<string, Promise<FileGraph>>();
  /** Signature comparisons by path and contents, kept between refreshes: an edit compares only the edited file again. */
  private readonly signatureCache = new Map<string, SignatureComparisonResult[]>();
  private readonly abortController = new AbortController();
  private maxFiles: number;
  constructor(readonly root: string, private readonly dependents?: SymbolDependentsProvider,
    private readonly extensionPath?: string, private readonly gitPath = 'git', maxFiles = BRANCH_WATCH_MAX_FILES) {
    this.maxFiles = normalizeBranchWatchMaxFiles(maxFiles);
  }

  setMaxFiles(maxFiles: number): void {
    const normalized = normalizeBranchWatchMaxFiles(maxFiles);
    if (normalized === this.maxFiles) return;
    this.maxFiles = normalized;
  }

  dispose(): void {
    this.abortController.abort();
  }

  async analyze(snapshot: BranchWatchSnapshot): Promise<BranchWatchResult> {
    const limitations = [...snapshot.limitations];
    const fileImpacts = await this.collectFileImpacts(snapshot);
    limitations.push(...fileImpacts.flatMap(impact => impact.limitations));
    const review = await this.buildReview(snapshot, limitations);
    this.addBehaviorLimitations(snapshot, review, limitations);
    const cycleAnalysis = await this.buildCycles(snapshot, limitations);
    return { snapshot, fileImpacts, review, cycles: cycleAnalysis.findings, cycleSummary: cycleAnalysis.summary,
      limitations: [...new Set(limitations)], analyzedAt: Date.now() };
  }

  private async collectFileImpacts(snapshot: BranchWatchSnapshot): Promise<BranchWatchFileImpact[]> {
    const fileImpacts: BranchWatchFileImpact[] = [];
    const references = new Map<string, Array<{ path: string }>>();
    const changes = snapshot.changes.slice(0, this.maxFiles);
    const roots = await this.rootReferences(changes.filter(change => this.hasImpact(change, snapshot)));
    for (const change of changes) {
      // eslint-disable-next-line no-await-in-loop -- the reference cache and its file budget are shared: file order decides which impacts fit
      fileImpacts.push(await this.fileImpact(change, snapshot, references, roots));
    }
    return fileImpacts;
  }

  private hasImpact(change: BranchWatchChange, snapshot: BranchWatchSnapshot): boolean {
    return Boolean(this.dependents?.findReferencingFiles) && LanguageService.isSupported(change.path) && snapshot.readablePaths.includes(change.path);
  }

  /**
   * The importers of each changed file, by normalized path, read before the walks: the files the
   * index reports no importer for share one fallback scan instead of one workspace scan each (#605).
   * Empty when the provider cannot batch or a lookup fails: each file then looks its root up itself.
   */
  private async rootReferences(changes: readonly BranchWatchChange[]): Promise<Map<string, Array<{ path: string }>>> {
    const find = this.dependents?.findReferencingFiles?.bind(this.dependents);
    const findMany = this.dependents?.findManyReferencingFilesWithFallback?.bind(this.dependents);
    if (!find || !findMany || !changes.length) return new Map();
    try {
      const targets = changes.map(change => resolveReviewCallGraphPath(this.root, change.path));
      const indexed = await Promise.all(targets.map(target => find(target)));
      const repaired = await findMany(targets.filter((_target, index) => !indexed[index].length));
      return new Map(changes.map((change, index) => [normalizePath(change.path),
        indexed[index].length ? indexed[index] : repaired.get(normalizePath(targets[index])) ?? []]));
    } catch {
      return new Map();
    }
  }

  private async buildReview(snapshot: BranchWatchSnapshot, limitations: string[]): Promise<ReviewGateResult> {
    const emptyReview: ReviewGateResult = { baseRef: snapshot.mergeBaseSha, headRef: snapshot.headReference ?? 'HEAD', changedFiles: [],
      symbols: [], cycles: [], score: 0, risk: 'low', isPartial: false, limitations: [] };
    // The review reads the diff itself and decides per file, as review-pr does (#546): untracked
    // files are not in `git diff`, so a diff of untracked files only has nothing to review.
    if (snapshot.changes.every(c => c.kind === 'untracked')) return emptyReview;
    const review = await new ReviewGateAnalyzer(this.root, this.dependents, this.signatureCache).analyze({
      baseRef: snapshot.mergeBaseSha, maxFiles: Math.min(this.maxFiles, REVIEW_GATE_MAX_FILES_LIMIT), maxDepth: 3,
      headRef: snapshot.headReference, fileCycles: false,
    });
    limitations.push(...review.limitations);
    return review;
  }

  private addBehaviorLimitations(snapshot: BranchWatchSnapshot, review: ReviewGateResult, limitations: string[]): void {
    for (const change of snapshot.changes) {
      if (change.kind === 'deleted' || review.symbols.some(s => s.filePath === change.path)) continue;
      const detail = hasSignatureAnalysis(change.path) ? '.' : '; signature comparison unavailable for this file type.';
      limitations.push(`${change.path}: behavior unverified${detail}`);
    }
  }

  /**
   * Cycles through the changed files, from the whole head import graph (the warmed index, or a copy of
   * an explicit head ref) and the whole merge-base graph, as review-pr reads them (#603): no file budget.
   */
  async buildCycles(snapshot: CycleScope, limitations: string[]): Promise<CycleAnalysis> {
    const changes = snapshot.changes.map(change => ({ ...change, path: normalizePath(change.path) }));
    if (!changes.some(change => change.kind !== 'deleted' && LanguageService.isSupported(change.path))) {
      return { findings: [], summary: { detected: 0, scopeComplete: true } };
    }
    const explicitHead = snapshot.headReference ? snapshot.headSha : undefined;
    // Only the refs of this snapshot stay cached: the base moves only with a commit, fetch, rebase or switch.
    for (const sha of this.refGraphs.keys()) if (sha !== snapshot.mergeBaseSha && sha !== explicitHead) this.refGraphs.delete(sha);
    const unknown: CycleAnalysis = { findings: [], summary: { detected: 0, scopeComplete: false } };
    const head = await this.readGraph('head', () => explicitHead ? this.refGraph(explicitHead) : this.workspaceGraph(), limitations);
    if (!head) return unknown;
    // Without a head cycle through a changed file no base can change the result: skip copying and parsing it.
    const cycleFiles = new Set([...detectCycleEdges(encodeEdges(head.edges))].flatMap(edge => edge.split('->').map(decodeURIComponent)));
    if (!changes.some(change => cycleFiles.has(change.path))) {
      return { findings: [], summary: { detected: 0, scopeComplete: head.limitations.length === 0 } };
    }
    const base = await this.readGraph('merge-base', () => this.refGraph(snapshot.mergeBaseSha), limitations);
    if (!base) return unknown;
    const findings = classifyCycles(head.edges, base.edges, changes);
    return { findings, summary: { detected: findings.length, scopeComplete: !head.limitations.length && !base.limitations.length } };
  }

  /** The graph `read` returns, its limitations added; undefined when it fails: an unreadable graph is never an empty, acyclic one. */
  private async readGraph(side: string, read: () => Promise<FileGraph>, limitations: string[]): Promise<FileGraph | undefined> {
    try {
      const graph = await read();
      limitations.push(...graph.limitations);
      return graph;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      limitations.push(`Cycle cannot be determined: the ${side} import graph could not be read. ${detail}`);
      return undefined;
    }
  }

  /** The whole working-tree import graph, read from the dependents provider's warmed index when it has one. */
  private async workspaceGraph(): Promise<FileGraph> {
    // A Spider: analyzeFromIndex reads an unchanged file from the reverse index (no stat-and-reindex, no parse).
    const index = this.dependents as { analyzeFromIndex?: AnalyzeFile; analyze?: AnalyzeFile } | undefined;
    const analyze = index?.analyzeFromIndex ?? index?.analyze;
    const analyzeFile: AnalyzeFile = analyze ? file => analyze.call(index, file) : treeAnalyzer(this.root, this.extensionPath);
    const limitations: string[] = [];
    const { imports } = await readTreeImports(this.root, 'the working tree', analyzeFile, limitations);
    return { edges: imports, limitations };
  }

  /** The whole import graph of commit `sha`, parsed once from a copy of its tree and cached until the snapshot moves off it. */
  private refGraph(sha: string): Promise<FileGraph> {
    const cached = this.refGraphs.get(sha);
    if (cached !== undefined) return cached;
    const graph = this.withRefTree(sha, async (directory, copyLimitations) => {
      const limitations = [...copyLimitations];
      const { imports } = await readTreeImports(directory, sha, treeAnalyzer(directory, this.extensionPath), limitations);
      return { edges: imports, limitations };
    });
    this.refGraphs.set(sha, graph);
    // A failed read is retried on the next refresh, not cached.
    graph.catch(() => { if (this.refGraphs.get(sha) === graph) this.refGraphs.delete(sha); });
    return graph;
  }

  private async fileImpact(change: BranchWatchChange, snapshot: BranchWatchSnapshot,
    references: Map<string, Array<{ path: string }>>, roots: ReadonlyMap<string, Array<{ path: string }>>): Promise<BranchWatchFileImpact> {
    const result: BranchWatchFileImpact = { path: change.path, dependents: [], availability: 'available', limitations: [] };
    if (!this.dependents?.findReferencingFiles || !this.hasImpact(change, snapshot)) {
      result.availability = 'unavailable';
      result.limitations.push(`${change.path}: Dependency analysis unavailable for this file or index.`);
      return result;
    }
    const seen = new Set([normalizePath(change.path)]);
    const queue = [{ path: change.path, depth: 0 }];
    try {
      const findReferencingFiles = this.dependents.findReferencingFiles.bind(this.dependents);
      const findReferencingFilesWithFallback = this.dependents.findReferencingFilesWithFallback
        ?.bind(this.dependents);
      const changedAbsolutePath = resolveReviewCallGraphPath(this.root, change.path);
      const findRootReferencingFiles = async (file: string) => {
        const indexed = await findReferencingFiles(file);
        if (indexed.length || !findReferencingFilesWithFallback) return indexed;
        return findReferencingFilesWithFallback(file);
      };
      // The traversal cache is shared between changed files. Always resolve
      // this file's root before a previous large impact walk consumes the
      // shared budget, otherwise later changed files can be reported empty.
      const rootKey = normalizePath(change.path);
      if (!references.has(rootKey)) references.set(rootKey, roots.get(rootKey) ?? await findRootReferencingFiles(changedAbsolutePath));
      await this.traverseImpact(snapshot, references, result, seen, queue,
        async file => {
          const indexed = await findReferencingFiles(file);
          // Reconcile only the changed file itself. Falling back for every
          // traversed node would turn a bounded impact walk into repeated
          // whole-workspace scans on large repositories.
          if (indexed.length || !findReferencingFilesWithFallback
            || normalizePath(file) !== normalizePath(changedAbsolutePath)) return indexed;
          return findReferencingFilesWithFallback(file);
        });
    } catch {
      result.limitations.push(`${change.path}: dependency index lookup failed; impact is incomplete.`);
    }
    if (result.dependents.length === 0) {
      result.limitations.push(`${change.path}: no known importers; this does not prove absence of impact.`);
    }
    if (result.limitations.length) result.availability = 'partial';
    return result;
  }

  private async traverseImpact(snapshot: BranchWatchSnapshot,
    references: Map<string, Array<{ path: string }>>, result: BranchWatchFileImpact,
    seen: Set<string>, level: Array<{ path: string; depth: number }>,
    findReferencingFiles: (file: string) => Promise<Array<{ path: string }>>): Promise<void> {
    if (!level.length) return;
    const keys = level.map(current => normalizePath(current.path));
    const plan = this.planReferenceLoads(keys, references);
    const loadIndexes = [...plan.keys()].filter(index => plan[index] === 'load');
    // One breadth-first level: lookups run together, then results apply in queue order as a sequential walk would.
    const outcomes = await mapWithConcurrency(loadIndexes, 8, index =>
      findReferencingFiles(resolveReviewCallGraphPath(this.root, level[index].path))
        .then(refs => ({ refs }), (error: unknown) => ({ error })));
    const loaded = new Map(loadIndexes.map((index, at) => [index, outcomes[at]]));
    const next: Array<{ path: string; depth: number }> = [];
    for (const [index, current] of level.entries()) {
      const outcome = loaded.get(index);
      if (plan[index] === 'limit') result.limitations.push(`Impact traversal reached the ${this.maxFiles}-file limit.`);
      if (outcome && 'error' in outcome) throw outcome.error;
      if (outcome) references.set(keys[index], outcome.refs);
      for (const ref of references.get(keys[index]) ?? []) {
        this.addDependent(snapshot, current, ref.path, result, seen, next);
      }
    }
    return this.traverseImpact(snapshot, references, result, seen, next, findReferencingFiles);
  }

  /** Per queued file, in order: already known, to load, or past the shared reference budget. */
  private planReferenceLoads(keys: string[], references: Map<string, Array<{ path: string }>>): Array<'known' | 'load' | 'limit'> {
    const loading = new Set<string>();
    return keys.map(key => {
      if (references.has(key) || loading.has(key)) return 'known';
      if (references.size + loading.size >= this.maxFiles) return 'limit';
      loading.add(key);
      return 'load';
    });
  }

  private addDependent(snapshot: BranchWatchSnapshot,
    current: { path: string; depth: number }, referencedPath: string,
    result: BranchWatchFileImpact, seen: Set<string>, queue: Array<{ path: string; depth: number }>): void {
    const relative = this.relativePath(path.relative(this.root, referencedPath));
    if (seen.has(relative)) return;
    if (current.depth >= 3) {
      result.limitations.push('Impact traversal reached the depth limit of 3.');
      return;
    }
    if (seen.size >= this.maxFiles) {
      result.limitations.push(`Impact traversal reached the ${this.maxFiles}-file limit.`);
      return;
    }
    seen.add(relative);
    const next = { path: relative, depth: current.depth + 1 };
    queue.push(next);
    result.dependents.push({ ...next, changed: snapshot.changes.some(c => c.path === relative) });
  }

  /** Runs `read` on a private copy of the tracked files of `ref`; the copy is removed afterwards. */
  async withRefTree<T>(ref: string, read: (directory: string, limitations: string[]) => Promise<T>): Promise<T> {
    // Every file: an import may resolve to any (a stylesheet, an .mts module) and unit roles read
    // manifests such as a Dockerfile; only a source or config file that cannot be copied is a limitation.
    return this.withBlobs(await this.treeEntries(ref, () => true), read,
      file => LanguageService.isSupported(file) || CONFIG_FILES.test(file) || ROOT_FILES.test(file));
  }

  /** The commit `git diff base...head` compares `head` with. */
  async mergeBase(base: string, head: string): Promise<string> {
    return (await this.git(['merge-base', base, head])).trim();
  }

  /** Entries of `ref`'s tree that `keep` selects, workspace-relative, with their blob size. */
  private async treeEntries(ref: string, keep: (file: string) => boolean): Promise<TreeEntry[]> {
    // shortcut: git() buffers 4 MiB of listing, about 40 000 files; stream ls-tree when larger repositories need it.
    return (await this.git(['ls-tree', '-r', '-z', '-l', ref])).split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      // `-l` right-aligns the size: fields are separated by one or more spaces.
      const [mode, , sha, size] = entry.slice(0, tab).split(/ +/);
      return { mode, sha, size: Number(size), file: this.relativePath(entry.slice(tab + 1)) };
    }).filter(entry => keep(entry.file));
  }

  /**
   * Runs `read` on a private copy of the blobs of `entries`, with why the `needed` ones could not
   * be copied; another binary or too large file is copied empty, so that it still exists (a symbolic
   * link or a submodule is not copied).
   * No checkout, hooks, index changes or commands from the inspected project are executed.
   */
  private async withBlobs<T>(entries: readonly TreeEntry[], read: (directory: string, limitations: string[]) => Promise<T>,
    needed: (file: string) => boolean = () => true): Promise<T> {
    // realpath: the macOS tmpdir is a symlink (/var → /private/var), which the workspace checks resolve.
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-baseline-')));
    try {
      const isRegular = (entry: TreeEntry) => ['100644', '100755'].includes(entry.mode);
      const regular = entries.filter(isRegular);
      const limitations = entries.filter(entry => !isRegular(entry) && needed(entry.file)).map(({ file }) => `${file}: unsupported baseline file mode.`);
      const write = async (file: string, content: Buffer | string) => {
        const target = resolveReviewCallGraphPath(directory, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      };
      const copy = async (file: string, content: Buffer | undefined) => {
        if (content !== undefined && !content.includes(0)) return write(file, content);
        if (needed(file)) limitations.push(`${file}: baseline file ${content === undefined ? 'exceeds text analysis limits' : 'is binary'}.`);
        else await write(file, '');
      };
      const large = regular.filter(entry => entry.size > MAX_TEXT_FILE_BYTES);
      await mapWithConcurrency(large, 16, entry => copy(entry.file, undefined));
      // Two batches in flight bound the memory to about 2 × BLOB_BATCH_BYTES.
      await mapWithConcurrency(blobBatches(regular.filter(entry => entry.size <= MAX_TEXT_FILE_BYTES)), 2, async batch => {
        const blobs = await this.readBlobs(batch.map(entry => entry.sha));
        await mapWithConcurrency(batch, 16, (entry, index) => copy(entry.file, blobs[index]));
      });
      return await read(directory, limitations.toSorted((left, right) => left.localeCompare(right)));
    } finally {
      LanguageService.releaseWorkspace(directory);
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  /** Contents of the blobs `shas`, in order, read by one `git cat-file --batch` process. */
  private readBlobs(shas: readonly string[]): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, ['-c', 'core.fsmonitor=false', 'cat-file', '--batch'], {
        cwd: this.root, signal: this.abortController.signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.on('error', error => reject(new BranchWatchError('git-unavailable', 'Git is unavailable or the workspace is inaccessible.', { cause: error })));
      // A Git failure surfaces as a non-zero exit code below; the broken pipe itself adds nothing.
      child.stdin.on('error', () => undefined);
      child.on('close', code => {
        if (code === 0) {
          try { resolve(parseCatFileBatch(Buffer.concat(output))); } catch (error) { reject(error); }
        } else {
          reject(new BranchWatchError('git-error', `Git could not read this repository while running git cat-file --batch (exit code ${code}).`));
        }
      });
      child.stdin.end(shas.map(sha => `${sha}\n`).join(''));
    });
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.gitPath, ['-c', 'core.fsmonitor=false', ...args], {
        cwd: this.root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10_000,
        signal: this.abortController.signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      return stdout;
    } catch (error) {
      const typed = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const code = typed.code;
      const detail = (typed.stderr ?? typed.message ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
      const operation = `git ${args.join(' ')}`;
      if (code === 'ENOENT') {
        throw new BranchWatchError('git-unavailable', 'Git is unavailable or the workspace is inaccessible.', { cause: error });
      }
      const suffix = detail ? ` ${detail}` : ' Check permissions, references and repository state.';
      throw new BranchWatchError('git-error', `Git could not read this repository while running ${operation}.${suffix}`, { cause: error });
    }
  }

  async detectRepository(): Promise<{ branch: string; headSha: string }> {
    let top: string;
    try {
      top = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    } catch (error) {
      if (error instanceof BranchWatchError && error.code === 'git-unavailable') throw error;
      const markers = await Promise.all(['.hg', '.svn'].map(marker => fs.stat(path.join(this.root, marker)).catch(() => undefined)));
      if (markers.some(Boolean)) {
        throw new BranchWatchError('unsupported-vcs', 'This workspace uses an unsupported version control system. Branch watch requires Git.');
      }
      // A present .git with a failing probe is an inaccessible/broken repository, not an empty folder.
      if (await fs.lstat(path.join(this.root, '.git')).catch(() => undefined)) throw error;
      throw new BranchWatchError('not-a-repository', 'This workspace is not a supported Git repository.', { cause: error });
    }
    const [rootReal, topReal] = await Promise.all([fs.realpath(this.root), fs.realpath(top)]);
    if (normalizePathForComparison(rootReal) !== normalizePathForComparison(topReal)
      || (await this.git(['rev-parse', '--show-superproject-working-tree'])).trim()) {
      throw new BranchWatchError('ambiguous-root', 'Select the Git repository root as the graph workspace and reload the window.');
    }
    const headSha = await this.git(['rev-parse', '--verify', 'HEAD^{commit}']).catch(error => {
      throw new BranchWatchError('unborn-head', 'This Git repository has no readable HEAD commit.', { cause: error });
    });
    // Full ref, not --short: --short prints "heads/x" when a tag or remote shares the branch name.
    const branch = await this.git(['symbolic-ref', '--quiet', 'HEAD']).catch(error => {
      throw new BranchWatchError('detached-head', 'HEAD is detached. Select a branch before enabling branch watch.', { cause: error });
    });
    if (await this.git(['ls-files', '--unmerged', '-z'])) {
      throw new BranchWatchError('conflicts', 'Resolve conflicts before refreshing branch watch.');
    }
    return { branch: branch.trim().replace(/^refs\/heads\//, ''), headSha: headSha.trim() };
  }

  async listReferences(): Promise<string[]> {
    const refs = (await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']))
      .split('\n').filter(ref => ref && !ref.endsWith('/HEAD'));
    const defaultRef = (await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    return [...new Set([defaultRef, 'main', 'master', ...refs].filter(ref => refs.includes(ref)))];
  }

  async capture(reference: string, headReference?: string): Promise<BranchWatchSnapshot> {
    this.validateReference(reference);
    const { branch, headSha: currentHeadSha } = await this.detectRepository();
    const selectedHead = headReference?.trim() || branch;
    const explicitHead = !await this.isCheckedOut(selectedHead, branch);
    const headSha = explicitHead ? await this.resolveCommit(selectedHead, 'The selected head branch is unavailable.') : currentHeadSha;
    const referenceSha = await this.resolveCommit(reference, 'The selected base branch reference is unavailable.');
    const bases = (await this.git(['merge-base', '--all', referenceSha, headSha]).catch(() => '')).trim().split('\n').filter(Boolean);
    if (bases.length !== 1) throw new BranchWatchError('ambiguous-base', 'A unique merge-base is unavailable. Check local history; branch watch does not fetch.');
    const mergeBaseSha = bases[0];
    const changes = await this.collectChanges(mergeBaseSha, headSha, explicitHead);
    const { fingerprint, limitations, readablePaths } = await this.captureContents(
      changes, { referenceSha, headSha, mergeBaseSha, branch }, explicitHead ? headSha : undefined);
    if (explicitHead) limitations.push(`Head ${selectedHead} is a committed reference; the active workspace index is used only for dependency context.`);
    return { reference, referenceSha, headReference: explicitHead ? selectedHead : undefined, branch: explicitHead ? selectedHead : branch, headSha, mergeBaseSha, fingerprint, changes, limitations, readablePaths };
  }

  private validateReference(reference: string): void {
    if (!reference.trim() || reference.startsWith('-') || reference.includes('\0')) {
      throw new BranchWatchError('invalid-reference', 'Select a valid Git branch reference.');
    }
  }

  /** The checked-out branch is the workspace itself: its head keeps uncommitted and untracked changes. */
  private async isCheckedOut(head: string, branch: string): Promise<boolean> {
    if (head === branch) return true;
    // Spellings such as HEAD, heads/x or refs/heads/x name the same branch; an unknown ref fails later in resolveCommit.
    const ref = await this.git(['rev-parse', '--verify', '--quiet', '--symbolic-full-name', '--end-of-options', head]).catch(() => '');
    return ref.trim() === `refs/heads/${branch}`;
  }

  private async resolveCommit(reference: string, message: string): Promise<string> {
    return (await this.git(['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`]).catch(error => {
      throw new BranchWatchError('invalid-reference', message, { cause: error });
    })).trim();
  }

  private async collectChanges(mergeBaseSha: string, headSha: string, explicitHead: boolean): Promise<BranchWatchChange[]> {
    const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', mergeBaseSha];
    if (explicitHead) diffArgs.push(headSha);
    diffArgs.push('--');
    const diff = (await this.git(diffArgs)).split('\0');
    const changes: BranchWatchChange[] = [];
    const kinds: Record<string, BranchWatchChange['kind']> = { A: 'added', M: 'modified', D: 'deleted', T: 'type-changed' };
    for (let i = 0; i + 1 < diff.length; i += 2) {
      if (!kinds[diff[i]]) throw new BranchWatchError('git-error', 'Git returned an unsupported change status.');
      changes.push({ path: this.relativePath(diff[i + 1]), kind: kinds[diff[i]] });
    }
    if (!explicitHead) {
      for (const file of (await this.git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
        changes.push({ path: this.relativePath(file), kind: 'untracked' });
      }
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
    return changes;
  }

  private async captureContents(changes: BranchWatchChange[], identity: object, headSha?: string): Promise<{
    fingerprint: string; limitations: string[]; readablePaths: string[];
  }> {
    const limitations: string[] = [];
    const readablePaths: string[] = [];
    const hash = createHash('sha256').update(JSON.stringify({ ...identity, changes }));
    if (changes.length > this.maxFiles) limitations.push(`Analysis limited to ${this.maxFiles} changed files; remaining files are inventoried only.`);
    // Reads run in a bounded pool; hashing and limitations then follow change order, as before.
    const reads = await mapWithConcurrency(changes, 8, async (change, index) => {
      if (change.kind === 'deleted' || index >= this.maxFiles) return undefined;
      const readLimitations: string[] = [];
      return { content: await this.readText(change.path, readLimitations, headSha), readLimitations };
    });
    for (const [index, change] of changes.entries()) {
      const read = reads[index];
      if (change.kind === 'deleted') {
        limitations.push(`${change.path}: deleted; a rename is represented as a deletion plus an addition.`);
        hash.update(JSON.stringify([change.path, 'deleted']));
      } else if (read) {
        limitations.push(...read.readLimitations);
        hash.update(JSON.stringify([change.path, read.content ?? 'unreadable']));
        if (read.content !== undefined) readablePaths.push(change.path);
      } else {
        hash.update(JSON.stringify([change.path, 'outside-analysis-limit']));
      }
    }
    return { fingerprint: hash.digest('hex'), limitations, readablePaths };
  }

  private relativePath(file: string): string {
    const absolute = resolveReviewCallGraphPath(this.root, file);
    // POSIX backslashes are legal Git names but cannot be represented by the shared normalized index.
    if (path.sep === '/' && file.includes('\\')) throw new BranchWatchError('git-error', 'A Git path contains a backslash and cannot be represented by the dependency index.');
    return normalizePath(path.relative(this.root, absolute));
  }

  async resolveFile(file: string): Promise<string> {
    // Awaited so an outside path rejects the promise rather than throwing before it exists.
    return await resolveRegularFile(this.root, resolveReviewCallGraphPath(this.root, file));
  }

  private async readText(file: string, limitations: string[], headSha?: string): Promise<string | undefined> {
    try {
      if (headSha) return checkText(await this.git(['cat-file', 'blob', `${headSha}:${file}`]));
      return await readWorkspaceText(this.root, resolveReviewCallGraphPath(this.root, file));
    } catch (error) {
      limitations.push(`${file}: ${error instanceof Error ? error.message : 'File is unreadable.'}`);
      return undefined;
    }
  }
}
