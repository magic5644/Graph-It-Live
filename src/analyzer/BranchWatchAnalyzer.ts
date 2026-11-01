import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { mapWithConcurrency } from '@/shared/concurrency';
import { normalizePath, normalizePathForComparison } from '@/shared/path';
import { resolveReviewCallGraphPath } from '@/shared/reviewTarget';
import { LanguageService } from './LanguageService';
import { hasSignatureAnalysis, REVIEW_GATE_MAX_FILES_LIMIT, ReviewGateAnalyzer, type FileCycleAnalysis, type ReviewGateResult, type SymbolDependentsProvider } from './ReviewGateAnalyzer';
import { detectCycleEdges } from '../shared/cycleUtils';
import { checkText, MAX_TEXT_FILE_BYTES, readWorkspaceText, resolveRegularFile } from './utils/workspaceText';

const execFileAsync = promisify(execFile);
export const BRANCH_WATCH_MAX_FILES = 200;
export const BRANCH_WATCH_MAX_FILES_LIMIT = 2000;
const CONFIG_FILES = /(?:^|\/)(?:tsconfig[^/]*\.json|package\.json|go\.mod|Cargo\.toml)$/;

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
  /** Number of cycle components found in the dependency scope reachable from changed files. */
  cycleSummary?: { detected: number; scopeComplete: boolean };
  review: ReviewGateResult;
  limitations: string[];
  analyzedAt: number;
}
interface FileGraph {
  edges: Array<{ source: string; target: string }>;
  limitations: string[];
}
/** What the cycle analysis reads of a snapshot: the changed files and the base to compare with. */
export type CycleScope = Pick<BranchWatchSnapshot, 'changes' | 'mergeBaseSha'>;
export interface CycleAnalysis {
  findings: BranchWatchCycleFinding[];
  summary: { detected: number; scopeComplete: boolean };
}

export function normalizeBranchWatchMaxFiles(value: number): number {
  if (!Number.isFinite(value)) return BRANCH_WATCH_MAX_FILES;
  return Math.min(BRANCH_WATCH_MAX_FILES_LIMIT, Math.max(1, Math.trunc(value)));
}

/** Local, read-only Git capture; independent of VS Code settings and runtime. */
export class BranchWatchAnalyzer {
  private baseline?: { sha: string; seedKey: string; scopeKey: string; graph: FileGraph };
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
    this.baseline = undefined;
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
    for (const change of snapshot.changes.slice(0, this.maxFiles)) {
      // eslint-disable-next-line no-await-in-loop -- the reference cache and its file budget are shared: file order decides which impacts fit
      fileImpacts.push(await this.fileImpact(change, snapshot, references));
    }
    return fileImpacts;
  }

  /** Import cycles a diff against `baseRef` adds among `changedFiles`, for the review gate; a file gone from disk counts as deleted. */
  async findFileCycles(changedFiles: string[], baseRef: string): Promise<FileCycleAnalysis> {
    const changes = await Promise.all(changedFiles.map(async (file): Promise<BranchWatchChange> => ({
      path: normalizePath(file),
      kind: await fs.access(resolveReviewCallGraphPath(this.root, file)).then(() => 'modified' as const, () => 'deleted' as const),
    })));
    const limitations: string[] = [];
    const { findings } = await this.buildCycles({ changes, mergeBaseSha: baseRef }, limitations);
    const cycles = findings.flatMap(({ classification, nodePaths, changedPaths }) =>
      classification === 'existing-touched' ? [] : [{ classification, files: nodePaths, changedFiles: changedPaths }]);
    return { cycles, limitations };
  }

  private async buildReview(snapshot: BranchWatchSnapshot, limitations: string[]): Promise<ReviewGateResult> {
    const emptyReview: ReviewGateResult = { baseRef: snapshot.mergeBaseSha, headRef: snapshot.headReference ?? 'HEAD', changedFiles: [],
      symbols: [], cycles: [], score: 0, risk: 'low', isPartial: false, limitations: [] };
    // The review reads the diff itself and decides per file, as review-pr does (#546): untracked
    // files are not in `git diff`, so a diff of untracked files only has nothing to review.
    if (snapshot.changes.every(c => c.kind === 'untracked')) return emptyReview;
    const review = await new ReviewGateAnalyzer(this.root, this.dependents).analyze({
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

  async buildCycles(snapshot: CycleScope, limitations: string[]): Promise<CycleAnalysis> {
    const empty: CycleAnalysis = { findings: [], summary: { detected: 0, scopeComplete: true } };
    const seeds = snapshot.changes.filter(change => change.kind !== 'deleted' && LanguageService.isSupported(change.path)).map(change => change.path);
    if (!seeds.length) return empty;
    const current = await this.readGraphFromSeeds(this.root, seeds);
    // A baseline is only needed to classify an existing cycle. When the current
    // affected graph has no cycle, loading every historical blob cannot change
    // the result and needlessly turns a bounded analysis into a repository scan.
    const currentCycleEdges = detectCycleEdges(current.edges.map(e => ({
      source: encodeURIComponent(e.source), target: encodeURIComponent(e.target),
    })));
    limitations.push(...current.limitations);
    if (current.limitations.length || !currentCycleEdges.size) {
      return {
        findings: [],
        summary: { detected: 0, scopeComplete: current.limitations.length === 0 },
      };
    }
    const cycleNodes = [...currentCycleEdges].flatMap(edge => edge.split('->').map(decodeURIComponent));
    const baseline = await this.baselineGraph(snapshot.mergeBaseSha, seeds, cycleNodes);
    limitations.push(...baseline.limitations);
    if (baseline.limitations.length) {
      limitations.push('Cycle cannot be determined completely: the current or baseline dependency graph is incomplete.');
      return { findings: [], summary: { detected: 0, scopeComplete: false } };
    }
    const findings = this.classifyCycles(current, baseline, snapshot);
    return { findings, summary: { detected: this.countCycleComponents(current), scopeComplete: true } };
  }

  private async readGraphFromSeeds(root: string, seeds: string[]): Promise<FileGraph> {
    const graph: FileGraph = { edges: [], limitations: [] };
    const language = new LanguageService(root, undefined, this.extensionPath);
    const reader = root === this.root ? this : new BranchWatchAnalyzer(root, undefined, this.extensionPath, this.gitPath, this.maxFiles);
    const queue = await this.readGraphLevel([...new Set(seeds.map(seed => normalizePath(seed)))], new Set<string>(), graph,
      file => this.readFileDependencies(root, file, language, reader));
    if (queue.length) graph.limitations.push(`Cycle analysis reached the ${this.maxFiles}-file affected-scope limit.`);
    return graph;
  }

  /**
   * One breadth-first level: picks the files a sequential walk would dequeue next (same order and
   * file budget), reads them together, then merges their edges in that order. Returns the queue
   * left when the walk stops, as the sequential walk would leave it.
   */
  private async readGraphLevel(queue: string[], seen: Set<string>, graph: FileGraph,
    read: (file: string) => Promise<FileGraph>): Promise<string[]> {
    const level: string[] = [];
    let index = 0;
    while (index < queue.length && seen.size < this.maxFiles) {
      const file = queue[index++];
      if (seen.has(file) || !LanguageService.isSupported(file)) continue;
      seen.add(file);
      level.push(file);
    }
    const rest = queue.slice(index);
    if (!level.length) return rest;
    const fileGraphs = await mapWithConcurrency(level, 8, read);
    // Sequentially, only the level files read so far were seen: a later file of the level was still queued.
    const position = new Map(level.map((file, at) => [file, at]));
    for (const [at, fileGraph] of fileGraphs.entries()) {
      graph.edges.push(...fileGraph.edges);
      graph.limitations.push(...fileGraph.limitations);
      for (const { target } of fileGraph.edges) {
        if (!seen.has(target) || (position.get(target) ?? -1) > at) rest.push(target);
      }
    }
    return this.readGraphLevel(rest, seen, graph, read);
  }

  /** Edges and limitations of one file; on failure, the edges found before it plus a limitation. */
  private async readFileDependencies(root: string, file: string, language: LanguageService,
    reader: BranchWatchAnalyzer): Promise<FileGraph> {
    const graph: FileGraph = { edges: [], limitations: [] };
    const failed = `${file}: dependency graph could not be analyzed.`;
    try {
      const absolute = await reader.resolveFile(file);
      const parser = language.getAnalyzer(absolute);
      const dependencies = await parser.parseImports(absolute);
      const resolutions = await Promise.allSettled(dependencies.map(dependency => parser.resolvePath(absolute, dependency.module)));
      for (const [index, dependency] of dependencies.entries()) {
        const resolution = resolutions[index];
        if (resolution.status === 'rejected') {
          graph.limitations.push(failed);
          return graph;
        }
        if (resolution.value) {
          graph.edges.push({ source: file, target: normalizePath(path.relative(root, resolution.value)) });
        } else if (this.isLocalModuleSpecifier(dependency.module)) {
          graph.limitations.push(`${file}: dependency '${dependency.module}' is not resolved locally; cycles may be incomplete.`);
        }
      }
    } catch {
      graph.limitations.push(failed);
    }
    return graph;
  }

  private isLocalModuleSpecifier(module: string): boolean {
    return module.startsWith('.') || module.startsWith('/') || module.startsWith('@/') || module.startsWith('~/')
      || /^[A-Za-z]:[\\/]/.test(module);
  }

  private countCycleComponents(graph: FileGraph): number {
    const edges = detectCycleEdges(graph.edges.map(e => ({ source: encodeURIComponent(e.source), target: encodeURIComponent(e.target) })));
    const groups: Array<Set<string>> = [];
    for (const edge of edges) {
      const [source, target] = edge.split('->');
      const matching = groups.filter(nodes => nodes.has(source) || nodes.has(target));
      const group = matching[0] ?? new Set<string>();
      group.add(source); group.add(target);
      if (!matching.length) groups.push(group);
      for (const other of matching.slice(1)) {
        for (const node of other) group.add(node);
        groups.splice(groups.indexOf(other), 1);
      }
    }
    return groups.length;
  }

  private async fileImpact(change: BranchWatchChange, snapshot: BranchWatchSnapshot,
    references: Map<string, Array<{ path: string }>>): Promise<BranchWatchFileImpact> {
    const result: BranchWatchFileImpact = { path: change.path, dependents: [], availability: 'available', limitations: [] };
    if (!this.dependents?.findReferencingFiles || !LanguageService.isSupported(change.path) || !snapshot.readablePaths.includes(change.path)) {
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
      if (!references.has(rootKey)) references.set(rootKey, await findRootReferencingFiles(changedAbsolutePath));
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

  private async baselineGraph(sha: string, seeds: string[], scope?: readonly string[]): Promise<FileGraph> {
    const seedKey = [...new Set(seeds)].sort((left, right) => left.localeCompare(right)).join('\0');
    const scopeKey = scope ? [...new Set(scope)].sort((left, right) => left.localeCompare(right)).join('\0') : '';
    if (this.baseline?.sha === sha && this.baseline.seedKey === seedKey && this.baseline.scopeKey === scopeKey) {
      return this.baseline.graph;
    }
    const entries = (await this.git(['ls-tree', '-r', '-z', sha])).split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      return { meta: entry.slice(0, tab).split(' '), file: this.relativePath(entry.slice(tab + 1)) };
    }).filter(entry => LanguageService.isSupported(entry.file) || CONFIG_FILES.test(entry.file));
    const scopedFiles = scope ? new Set([...scope, ...seeds].map(file => normalizePath(file))) : undefined;
    const candidates = scopedFiles
      ? entries.filter(entry => scopedFiles.has(entry.file) || CONFIG_FILES.test(entry.file))
      : entries;
    const selectedEntries = candidates.toSorted((left, right) => {
      const leftPriority = scopedFiles?.has(left.file) ? 0 : 1;
      const rightPriority = scopedFiles?.has(right.file) ? 0 : 1;
      return leftPriority - rightPriority || left.file.localeCompare(right.file);
    }).slice(0, this.maxFiles);
    let graph: FileGraph = { edges: [], limitations: [] };
    if (selectedEntries.length < candidates.length) {
      graph.limitations.push(`Cycle analysis reached the ${this.maxFiles}-file baseline limit.`);
    }
    // A bounded private copy of Git blobs allows existing resolvers to see historical config and paths.
    // No checkout, hooks, index changes or commands from the inspected project are executed.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-baseline-'));
    try {
        // Git blob reads are independent; a small bounded pool avoids spawning
        // thousands of sequential processes on large repositories.
        const blobLimitations = await mapWithConcurrency(selectedEntries, 8, async ({ meta, file }) => {
          if (!['100644', '100755'].includes(meta[0])) return `${file}: unsupported baseline file mode.`;
          const size = Number.parseInt((await this.git(['cat-file', '-s', meta[2]])).trim(), 10);
          if (size > MAX_TEXT_FILE_BYTES) return `${file}: baseline file exceeds text analysis limits.`;
          const content = await this.git(['cat-file', 'blob', meta[2]]);
          if (content.includes('\0')) return `${file}: baseline file is binary.`;
          const target = resolveReviewCallGraphPath(directory, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
          return undefined;
        });
        graph.limitations.push(...blobLimitations.filter((limitation): limitation is string => Boolean(limitation)));
        const baselineSeeds = seeds.filter(seed => selectedEntries.some(entry => entry.file === seed));
        const parsed = await new BranchWatchAnalyzer(directory, undefined, this.extensionPath, this.gitPath, this.maxFiles)
          .readGraphFromSeeds(directory, baselineSeeds);
        graph = { edges: parsed.edges, limitations: [...graph.limitations, ...parsed.limitations] };
    } finally {
      LanguageService.releaseWorkspace(directory);
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.baseline = { sha, seedKey, scopeKey, graph };
    return graph;
  }

  private classifyCycles(current: FileGraph, baseline: FileGraph, snapshot: CycleScope): BranchWatchCycleFinding[] {
    // Encode paths before using the legacy arrow-delimited edge keys (Git filenames may contain arrows).
    const encode = (graph: FileGraph) => graph.edges.map(e => ({ source: encodeURIComponent(e.source), target: encodeURIComponent(e.target) }));
    const currentEdges = detectCycleEdges(encode(current));
    const oldEdges = detectCycleEdges(encode(baseline));
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
      const changedPaths = snapshot.changes.filter(c => ['modified', 'added', 'untracked', 'type-changed'].includes(c.kind) && nodePaths.includes(c.path)).map(c => c.path);
      if (!changedPaths.length) continue;
      let classification: BranchWatchCycleFinding['classification'] = 'introduced';
      if (edges.every(e => oldEdges.has(e))) classification = 'existing-touched';
      else if ([...nodes].some(n => oldNodes.has(n))) classification = 'aggravated';
      const edgeKeys = edges.toSorted((left, right) => left.localeCompare(right));
      findings.push({ classification, nodePaths, edgeKeys, changedPaths, relation: 'file-dependency', recommendation: 'review-design', limitations: [] });
    }
    return findings;
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
