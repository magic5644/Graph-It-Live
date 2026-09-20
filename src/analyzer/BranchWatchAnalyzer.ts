import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { normalizePath, normalizePathForComparison } from '@/shared/path';
import { resolveReviewCallGraphPath } from '@/shared/reviewTarget';
import { LanguageService } from './LanguageService';
import { ReviewGateAnalyzer, type ReviewGateResult, type SymbolDependentsProvider } from './ReviewGateAnalyzer';
import { detectCycleEdges } from './callgraph/cycleUtils';

const execFileAsync = promisify(execFile);
export const BRANCH_WATCH_MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SIGNATURE_FILES = /\.(ts|tsx|js|jsx|cjs|mjs)$/i;
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
interface CycleAnalysis {
  findings: BranchWatchCycleFinding[];
  summary: { detected: number; scopeComplete: boolean };
}

/** Local, read-only Git capture; independent of VS Code settings and runtime. */
export class BranchWatchAnalyzer {
  private baseline?: { sha: string; seedKey: string; graph: FileGraph };
  constructor(readonly root: string, private readonly dependents?: SymbolDependentsProvider,
    private readonly extensionPath?: string, private readonly gitPath = 'git') {}

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
    for (const change of snapshot.changes.slice(0, BRANCH_WATCH_MAX_FILES)) {
      fileImpacts.push(await this.fileImpact(change, snapshot, references));
    }
    return fileImpacts;
  }

  private async buildReview(snapshot: BranchWatchSnapshot, limitations: string[]): Promise<ReviewGateResult> {
    const emptyReview: ReviewGateResult = { baseRef: snapshot.mergeBaseSha, headRef: snapshot.headReference ?? 'HEAD', changedFiles: [],
      symbols: [], score: 0, risk: 'low', isPartial: false, limitations: [] };
    const signatureChanges = snapshot.changes.filter(c => SIGNATURE_FILES.test(c.path) && c.kind !== 'deleted' && c.kind !== 'untracked');
    if (!signatureChanges.length) return emptyReview;
    if (!signatureChanges.every(c => snapshot.readablePaths.includes(c.path))) {
      limitations.push('Signature comparison unavailable: some changed files are unsafe, unreadable or outside the analysis limit.');
      return emptyReview;
    }
    const review = await new ReviewGateAnalyzer(this.root, this.dependents).analyze({
      baseRef: snapshot.mergeBaseSha, maxFiles: BRANCH_WATCH_MAX_FILES, maxDepth: 3,
      headRef: snapshot.headReference,
    });
    limitations.push(...review.limitations);
    return review;
  }

  private addBehaviorLimitations(snapshot: BranchWatchSnapshot, review: ReviewGateResult, limitations: string[]): void {
    for (const change of snapshot.changes) {
      if (change.kind === 'deleted' || review.symbols.some(s => s.filePath === change.path)) continue;
      const detail = SIGNATURE_FILES.test(change.path) ? '.' : '; signature comparison unavailable for this file type.';
      limitations.push(`${change.path}: behavior unverified${detail}`);
    }
  }

  private async buildCycles(snapshot: BranchWatchSnapshot, limitations: string[]): Promise<CycleAnalysis> {
    const empty: CycleAnalysis = { findings: [], summary: { detected: 0, scopeComplete: true } };
    const seeds = snapshot.changes.filter(change => change.kind !== 'deleted' && LanguageService.isSupported(change.path)).map(change => change.path);
    if (!seeds.length) return empty;
    const current = await this.readGraphFromSeeds(this.root, seeds);
    const baseline = await this.baselineGraph(snapshot.mergeBaseSha, seeds);
    limitations.push(...current.limitations, ...baseline.limitations);
    if (current.limitations.length || baseline.limitations.length) {
      limitations.push('Cycle cannot be determined completely: the current or baseline dependency graph is incomplete.');
      return { findings: [], summary: { detected: 0, scopeComplete: false } };
    }
    const findings = this.classifyCycles(current, baseline, snapshot);
    return { findings, summary: { detected: this.countCycleComponents(current), scopeComplete: true } };
  }

  private async readGraphFromSeeds(root: string, seeds: string[]): Promise<FileGraph> {
    const graph: FileGraph = { edges: [], limitations: [] };
    const queue = [...new Set(seeds.map(normalizePath))];
    const seen = new Set<string>();
    const language = new LanguageService(root, undefined, this.extensionPath);
    const reader = root === this.root ? this : new BranchWatchAnalyzer(root);
    while (queue.length && seen.size < BRANCH_WATCH_MAX_FILES) {
      const file = queue.shift()!;
      if (seen.has(file) || !LanguageService.isSupported(file)) continue;
      seen.add(file);
      try {
        const absolute = await reader.resolveFile(file);
        const parser = language.getAnalyzer(absolute);
        for (const dependency of await parser.parseImports(absolute)) {
          const resolved = await parser.resolvePath(absolute, dependency.module);
          if (!resolved) {
            if (this.isLocalModuleSpecifier(dependency.module)) {
              graph.limitations.push(`${file}: dependency '${dependency.module}' is not resolved locally; cycles may be incomplete.`);
            }
            continue;
          }
          const relative = normalizePath(path.relative(root, resolved));
          graph.edges.push({ source: file, target: relative });
          if (!seen.has(relative)) queue.push(relative);
        }
      } catch {
        graph.limitations.push(`${file}: dependency graph could not be analyzed.`);
      }
    }
    if (queue.length) graph.limitations.push(`Cycle analysis reached the ${BRANCH_WATCH_MAX_FILES}-file affected-scope limit.`);
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
    seen: Set<string>, queue: Array<{ path: string; depth: number }>,
    findReferencingFiles: (file: string) => Promise<Array<{ path: string }>>): Promise<void> {
    for (const current of queue) {
      const key = normalizePath(current.path);
      await this.loadReferences(current.path, key, references, result, findReferencingFiles);
      if (!references.has(key)) continue;
      for (const ref of references.get(key)!) {
        this.addDependent(snapshot, current, ref.path, result, seen, queue);
      }
    }
  }

  private async loadReferences(currentPath: string, key: string,
    references: Map<string, Array<{ path: string }>>, result: BranchWatchFileImpact,
    findReferencingFiles: (file: string) => Promise<Array<{ path: string }>>): Promise<void> {
    if (references.has(key)) return;
    if (references.size >= BRANCH_WATCH_MAX_FILES) {
      result.limitations.push('Impact traversal reached the 200-file limit.');
      return;
    }
    const refs = await findReferencingFiles(resolveReviewCallGraphPath(this.root, currentPath));
    references.set(key, refs);
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
    if (seen.size >= BRANCH_WATCH_MAX_FILES) {
      result.limitations.push('Impact traversal reached the 200-file limit.');
      return;
    }
    seen.add(relative);
    const next = { path: relative, depth: current.depth + 1 };
    queue.push(next);
    result.dependents.push({ ...next, changed: snapshot.changes.some(c => c.path === relative) });
  }

  private async baselineGraph(sha: string, seeds: string[]): Promise<FileGraph> {
    const seedKey = [...new Set(seeds)].sort().join('\0');
    if (this.baseline?.sha === sha && this.baseline.seedKey === seedKey) return this.baseline.graph;
    const entries = (await this.git(['ls-tree', '-r', '-z', sha])).split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      return { meta: entry.slice(0, tab).split(' '), file: this.relativePath(entry.slice(tab + 1)) };
    }).filter(entry => LanguageService.isSupported(entry.file) || CONFIG_FILES.test(entry.file));
    let graph: FileGraph = { edges: [], limitations: [] };
    // A bounded private copy of Git blobs allows existing resolvers to see historical config and paths.
    // No checkout, hooks, index changes or commands from the inspected project are executed.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-baseline-'));
    try {
        // Git blob reads are independent; a small bounded batch avoids spawning
        // thousands of sequential processes on large repositories.
        const batchSize = 8;
        for (let start = 0; start < entries.length; start += batchSize) {
          const batch = entries.slice(start, start + batchSize);
          const batchLimitations = await Promise.all(batch.map(async ({ meta, file }) => {
            if (!['100644', '100755'].includes(meta[0])) return `${file}: unsupported baseline file mode.`;
            const size = Number.parseInt((await this.git(['cat-file', '-s', meta[2]])).trim(), 10);
            if (size > MAX_FILE_BYTES) return `${file}: baseline file exceeds text analysis limits.`;
            const content = await this.git(['cat-file', 'blob', meta[2]]);
            if (content.includes('\0')) return `${file}: baseline file is binary.`;
            const target = resolveReviewCallGraphPath(directory, file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, content);
            return undefined;
          }));
          graph.limitations.push(...batchLimitations.filter((limitation): limitation is string => Boolean(limitation)));
        }
        const baselineSeeds = seeds.filter(seed => entries.some(entry => entry.file === seed));
        const parsed = await new BranchWatchAnalyzer(directory, undefined, this.extensionPath).readGraphFromSeeds(directory, baselineSeeds);
        graph = { edges: parsed.edges, limitations: [...graph.limitations, ...parsed.limitations] };
    } finally {
      LanguageService.releaseWorkspace(directory);
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.baseline = { sha, seedKey, graph };
    return graph;
  }

  private classifyCycles(current: FileGraph, baseline: FileGraph, snapshot: BranchWatchSnapshot): BranchWatchCycleFinding[] {
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
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      return stdout;
    } catch (error) {
      const typed = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const code = typed.code;
      const detail = (typed.stderr ?? typed.message ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
      const operation = `git ${args.join(' ')}`;
      throw new BranchWatchError(code === 'ENOENT' ? 'git-unavailable' : 'git-error',
        code === 'ENOENT' ? 'Git is unavailable or the workspace is inaccessible.'
          : `Git could not read this repository while running ${operation}.${detail ? ` ${detail}` : ' Check permissions, references and repository state.'}`, { cause: error });
    }
  }

  async detectRepository(): Promise<{ branch: string; headSha: string }> {
    let top: string;
    try {
      top = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    } catch (error) {
      if (error instanceof BranchWatchError && error.code === 'git-unavailable') throw error;
      for (const marker of ['.hg', '.svn']) {
        if (await fs.stat(path.join(this.root, marker)).catch(() => undefined)) {
          throw new BranchWatchError('unsupported-vcs', 'This workspace uses an unsupported version control system. Branch watch requires Git.');
        }
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
    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(error => {
      throw new BranchWatchError('detached-head', 'HEAD is detached. Select a branch before enabling branch watch.', { cause: error });
    });
    if (await this.git(['ls-files', '--unmerged', '-z'])) {
      throw new BranchWatchError('conflicts', 'Resolve conflicts before refreshing branch watch.');
    }
    return { branch: branch.trim(), headSha: headSha.trim() };
  }

  async listReferences(): Promise<string[]> {
    const refs = (await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']))
      .split('\n').filter(ref => ref && !ref.endsWith('/HEAD'));
    const defaultRef = (await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    return [...new Set([defaultRef, 'main', 'master', ...refs].filter(ref => refs.includes(ref)))];
  }

  async capture(reference: string, headReference?: string): Promise<BranchWatchSnapshot> {
    if (!reference.trim() || reference.startsWith('-') || reference.includes('\0')) {
      throw new BranchWatchError('invalid-reference', 'Select a valid Git branch reference.');
    }
    const { branch, headSha: currentHeadSha } = await this.detectRepository();
    const explicitHead = Boolean(headReference?.trim());
    const selectedHead = headReference?.trim() || branch;
    const headSha = explicitHead
      ? (await this.git(['rev-parse', '--verify', '--end-of-options', `${selectedHead}^{commit}`]).catch(error => {
        throw new BranchWatchError('invalid-reference', 'The selected head branch is unavailable.', { cause: error });
      })).trim()
      : currentHeadSha;
    const referenceSha = (await this.git(['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`]).catch(error => {
      throw new BranchWatchError('invalid-reference', 'The selected base branch reference is unavailable.', { cause: error });
    })).trim();
    const bases = (await this.git(['merge-base', '--all', referenceSha, headSha]).catch(() => '')).trim().split('\n').filter(Boolean);
    if (bases.length !== 1) throw new BranchWatchError('ambiguous-base', 'A unique merge-base is unavailable. Check local history; branch watch does not fetch.');
    const mergeBaseSha = bases[0];
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
    const limitations: string[] = [];
    const readablePaths: string[] = [];
    const hash = createHash('sha256').update(JSON.stringify({ referenceSha, headSha, mergeBaseSha, branch, changes }));
    if (changes.length > BRANCH_WATCH_MAX_FILES) limitations.push(`Analysis limited to ${BRANCH_WATCH_MAX_FILES} changed files; remaining files are inventoried only.`);
    for (const [index, change] of changes.entries()) {
      if (change.kind === 'deleted') {
        limitations.push(`${change.path}: deletion impact not analyzed; renames are represented as deletion and addition.`);
        hash.update(JSON.stringify([change.path, 'deleted']));
      } else if (index < BRANCH_WATCH_MAX_FILES) {
        const content = await this.readText(change.path, limitations, explicitHead ? headSha : undefined);
        hash.update(JSON.stringify([change.path, content ?? 'unreadable']));
        if (content !== undefined) readablePaths.push(change.path);
      } else {
        hash.update(JSON.stringify([change.path, 'outside-analysis-limit']));
      }
    }
    if (explicitHead) limitations.push(`Head ${selectedHead} is a committed reference; the active workspace index is used only for dependency context.`);
    return { reference, referenceSha, headReference: explicitHead ? selectedHead : undefined, branch: explicitHead ? selectedHead : branch, headSha, mergeBaseSha, fingerprint: hash.digest('hex'), changes, limitations, readablePaths };
  }

  private relativePath(file: string): string {
    const absolute = resolveReviewCallGraphPath(this.root, file);
    // POSIX backslashes are legal Git names but cannot be represented by the shared normalized index.
    if (path.sep === '/' && file.includes('\\')) throw new BranchWatchError('git-error', 'A Git path contains a backslash and cannot be represented by the dependency index.');
    return normalizePath(path.relative(this.root, absolute));
  }

  async resolveFile(file: string): Promise<string> {
    const absolute = resolveReviewCallGraphPath(this.root, file);
    const [rootReal, fileReal, stat] = await Promise.all([fs.realpath(this.root), fs.realpath(absolute), fs.lstat(absolute)]);
    const relative = path.relative(rootReal, fileReal);
    if (stat.isSymbolicLink() || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('File is a symbolic link or resolves outside the workspace.');
    }
    if (!stat.isFile()) throw new Error('File is not a regular file.');
    if (stat.size > MAX_FILE_BYTES) throw new Error('File exceeds the 2 MiB size limit.');
    return absolute;
  }

  private async readText(file: string, limitations: string[], headSha?: string): Promise<string | undefined> {
    try {
      if (headSha) {
        const content = await this.git(['cat-file', 'blob', `${headSha}:${file}`]);
        if (content.includes('\0')) throw new Error('File is binary.');
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('File exceeds the 2 MiB size limit.');
        return content;
      }
      const absolute = await this.resolveFile(file);
      const content = await fs.readFile(absolute);
      if (content.length > MAX_FILE_BYTES) throw new Error('File exceeds the 2 MiB size limit.');
      if (content.includes(0)) throw new Error('File is binary.');
      return content.toString('utf8');
    } catch (error) {
      limitations.push(`${file}: ${error instanceof Error ? error.message : 'File is unreadable.'}`);
      return undefined;
    }
  }
}
