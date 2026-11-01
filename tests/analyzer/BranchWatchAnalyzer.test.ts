import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_WATCH_MAX_FILES, BRANCH_WATCH_MAX_FILES_LIMIT, BranchWatchAnalyzer, BranchWatchError,
  normalizeBranchWatchMaxFiles } from '@/analyzer/BranchWatchAnalyzer';
import { LanguageService } from '@/analyzer/LanguageService';
import { Spider } from '@/analyzer/Spider';

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function workspace(commit = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-watch-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number) { return n; }\n');
  await fs.writeFile(path.join(root, 'removed.ts'), 'export const old = 1;\n');
  if (commit) { git(root, 'add', '.'); git(root, 'commit', '-m', 'base'); }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

// Each test spawns many git processes; slow on Windows runners.
const GIT_TEST_TIMEOUT = 20_000;

describe('BranchWatchAnalyzer limits', () => {
  it('normalizes invalid and out-of-range file limits', () => {
    expect(normalizeBranchWatchMaxFiles(Number.NaN)).toBe(BRANCH_WATCH_MAX_FILES);
    expect(normalizeBranchWatchMaxFiles(0)).toBe(1);
    expect(normalizeBranchWatchMaxFiles(25.9)).toBe(25);
    expect(normalizeBranchWatchMaxFiles(BRANCH_WATCH_MAX_FILES_LIMIT + 1)).toBe(BRANCH_WATCH_MAX_FILES_LIMIT);
  });
});

describe('BranchWatchAnalyzer capture', { timeout: GIT_TEST_TIMEOUT }, () => {
  it('compares branch commits and final disk contents with the merge-base, not the advanced base tip', async () => {
    const root = await workspace();
    const common = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number, required: boolean) { return n; }\n');
    git(root, 'commit', '-am', 'feature');
    git(root, 'switch', 'main');
    await fs.writeFile(path.join(root, 'base-only.ts'), 'export {};');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'advance'); git(root, 'switch', 'feature');
    await fs.unlink(path.join(root, 'removed.ts'));
    await fs.writeFile(path.join(root, 'new space file.ts'), 'export {};');
    const analyzer = new BranchWatchAnalyzer(root);
    const before = await analyzer.capture('main');
    expect(before.mergeBaseSha).toBe(common);
    expect(before.changes).toEqual([
      { path: 'api.ts', kind: 'modified' }, { path: 'new space file.ts', kind: 'untracked' }, { path: 'removed.ts', kind: 'deleted' },
    ]);
    expect(before.limitations.join(' ')).toContain('removed.ts: deleted');
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number) { return n + 1; }\n');
    git(root, 'add', 'api.ts');
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number) { return n; }\n');
    const after = await analyzer.capture('main');
    expect(after.changes.some(c => c.path === 'api.ts')).toBe(false);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('compares two explicit branch refs without including working-tree files', async () => {
    const root = await workspace();
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number, required: boolean) { return n; }\n');
    git(root, 'commit', '-am', 'feature');
    git(root, 'switch', 'main');
    await fs.writeFile(path.join(root, 'working-only.ts'), 'export {};\n');
    const snapshot = await new BranchWatchAnalyzer(root).capture('main', 'feature');
    expect(snapshot.referenceSha).toBe(base);
    expect(snapshot.headReference).toBe('feature');
    expect(snapshot.branch).toBe('feature');
    expect(snapshot.changes).toEqual([{ path: 'api.ts', kind: 'modified' }]);
    expect(snapshot.limitations.join(' ')).toContain('committed reference');
  });

  it('treats the checked-out branch as head like the default mode, before its first commit', async () => {
    const root = await workspace();
    git(root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number, required: boolean) { return n; }\n');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'staged.ts'), 'export {};\n');
    git(root, 'add', 'src/staged.ts');
    await fs.unlink(path.join(root, 'removed.ts'));
    await fs.writeFile(path.join(root, 'src', 'untracked.ts'), 'export {};\n');
    const analyzer = new BranchWatchAnalyzer(root);
    const selected = await analyzer.capture('main', ' feature ');
    const workspaceMode = await analyzer.capture('main');
    expect(selected.changes).toEqual([
      { path: 'api.ts', kind: 'modified' }, { path: 'removed.ts', kind: 'deleted' },
      { path: 'src/staged.ts', kind: 'added' }, { path: 'src/untracked.ts', kind: 'untracked' },
    ]);
    expect(selected.headReference).toBeUndefined();
    expect(selected.branch).toBe('feature');
    expect(selected.limitations.join(' ')).not.toContain('committed reference');
    expect(selected).toEqual(workspaceMode);
    const spellings = await Promise.all(['HEAD', 'heads/feature', 'refs/heads/feature', '   '].map(head => analyzer.capture('main', head)));
    for (const snapshot of spellings) expect(snapshot).toEqual(workspaceMode);
  });

  it('keeps a remote or tag named like the checked-out branch apart from the workspace', async () => {
    const root = await workspace();
    git(root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(root, 'committed.ts'), 'export {};\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'feature');
    git(root, 'update-ref', 'refs/remotes/origin/feature', 'HEAD');
    git(root, 'tag', 'feature');
    await fs.writeFile(path.join(root, 'untracked.ts'), 'export {};\n');
    const analyzer = new BranchWatchAnalyzer(root);
    expect((await analyzer.detectRepository()).branch).toBe('feature');
    const remote = await analyzer.capture('main', 'origin/feature');
    expect(remote.headReference).toBe('origin/feature');
    expect(remote.changes).toEqual([{ path: 'committed.ts', kind: 'added' }]);
    expect(remote.limitations.join(' ')).toContain('committed reference');
    await expect(analyzer.capture('main', 'missing')).rejects.toMatchObject({ code: 'invalid-reference' });
  });

  it('keeps commits and working-tree changes when the checked-out branch has commits', async () => {
    const root = await workspace();
    git(root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(root, 'committed.ts'), 'export {};\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'feature');
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number) { return n + 1; }\n');
    await fs.writeFile(path.join(root, 'untracked.ts'), 'export {};\n');
    const snapshot = await new BranchWatchAnalyzer(root).capture('main', 'feature');
    expect(snapshot.headSha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(snapshot.changes).toEqual([
      { path: 'api.ts', kind: 'modified' }, { path: 'committed.ts', kind: 'added' }, { path: 'untracked.ts', kind: 'untracked' },
    ]);
    expect(snapshot.limitations.join(' ')).not.toContain('committed reference');
  });

  it('fingerprints contents, including unsupported files, and inventories renames as delete plus add', async () => {
    const root = await workspace();
    git(root, 'mv', 'api.ts', 'renamed.ts');
    await fs.writeFile(path.join(root, 'notes.txt'), 'one');
    const analyzer = new BranchWatchAnalyzer(root);
    const before = await analyzer.capture('main');
    expect(before.changes).toContainEqual({ path: 'api.ts', kind: 'deleted' });
    expect(before.changes).toContainEqual({ path: 'renamed.ts', kind: 'added' });
    await fs.writeFile(path.join(root, 'notes.txt'), 'two');
    expect((await analyzer.capture('main')).fingerprint).not.toBe(before.fingerprint);
  });

  it('rejects invalid refs, unborn HEAD, detached HEAD and an ambiguous subfolder', async () => {
    const root = await workspace(false);
    await expect(new BranchWatchAnalyzer(root).detectRepository()).rejects.toMatchObject({ code: 'unborn-head' });
    git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
    for (const ref of ['', '--help', 'missing']) await expect(new BranchWatchAnalyzer(root).capture(ref)).rejects.toBeInstanceOf(BranchWatchError);
    await fs.mkdir(path.join(root, 'nested'));
    await expect(new BranchWatchAnalyzer(path.join(root, 'nested')).detectRepository()).rejects.toMatchObject({ code: 'ambiguous-root' });
    git(root, 'switch', '--detach');
    await expect(new BranchWatchAnalyzer(root).capture('main')).rejects.toMatchObject({ code: 'detached-head' });
  });

  it('keeps non-Git and unsupported VCS distinct and never mistakes either for a clean branch', async () => {
    const root = await workspace();
    await fs.rm(path.join(root, '.git'), { recursive: true });
    await expect(new BranchWatchAnalyzer(root).detectRepository()).rejects.toMatchObject({ code: 'not-a-repository' });
    await fs.mkdir(path.join(root, '.hg'));
    await expect(new BranchWatchAnalyzer(root).detectRepository()).rejects.toMatchObject({ code: 'unsupported-vcs' });
  });

  it('does not read exterior symlinks, binary or oversized files', async () => {
    const root = await workspace();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-outside-')); roots.push(external);
    await fs.writeFile(path.join(external, 'secret.ts'), 'secret');
    let symlinkCreated = true;
    try {
      await fs.symlink(path.join(external, 'secret.ts'), path.join(root, 'link.ts'));
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      symlinkCreated = false;
    }
    await fs.writeFile(path.join(root, 'binary.ts'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(root, 'large.ts'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    const result = await new BranchWatchAnalyzer(root).capture('main');
    if (symlinkCreated) expect(result.limitations.join(' ')).toMatch(/symbolic link/);
    expect(result.limitations.join(' ')).toMatch(/binary/);
    expect(result.limitations.join(' ')).toMatch(/size limit/);
    await expect(new BranchWatchAnalyzer(root).resolveFile('../escape.ts')).rejects.toThrow();
    if (symlinkCreated) await expect(new BranchWatchAnalyzer(root).resolveFile('link.ts')).rejects.toThrow();
  });

  it('limits readable changed files using the configured budget', async () => {
    const root = await workspace();
    await fs.appendFile(path.join(root, 'api.ts'), '// changed\n');
    await fs.appendFile(path.join(root, 'removed.ts'), '// changed\n');

    const snapshot = await new BranchWatchAnalyzer(root, undefined, undefined, 'git', 1).capture('main');

    expect(snapshot.readablePaths).toHaveLength(1);
    expect(snapshot.limitations.join(' ')).toContain('limited to 1 changed files');
  });
});

describe('BranchWatchAnalyzer findings', { timeout: GIT_TEST_TIMEOUT }, () => {
  it('reports Vue prop contract changes through Branch Watch', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'Child.vue'), '<script setup lang="ts">defineProps<{ oldName: string }>();</script><template />\n');
    await fs.writeFile(path.join(root, 'Parent.vue'), '<script setup>import Child from "./Child.vue";</script><template><Child oldName="value" /></template>\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'vue component');
    await fs.writeFile(path.join(root, 'Child.vue'), '<script setup lang="ts">defineProps<{ newName: string }>();</script><template />\n');

    const result = await new BranchWatchAnalyzer(root).analyze(await new BranchWatchAnalyzer(root).capture('main'));

    expect(result.review.symbols.find(symbol => symbol.name === 'Child.props')?.breakingChanges)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'member-renamed', symbolName: 'Child.props.newName' })]));
  });

  it('reports class-based Vue prop contract changes through Branch Watch', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'Child.vue'), '<script lang="ts">export class Child extends Vue { @Prop() oldName: string; }</script><template />\n');
    await fs.writeFile(path.join(root, 'Parent.vue'), '<script setup>import Child from "./Child.vue";</script><template><Child oldName="value" /></template>\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'class-based vue component');
    await fs.writeFile(path.join(root, 'Child.vue'), '<script lang="ts">export class Child extends Vue { @Prop() newName: string; }</script><template />\n');

    const analyzer = new BranchWatchAnalyzer(root);
    const result = await analyzer.analyze(await analyzer.capture('main'));

    expect(result.review.symbols.find(symbol => symbol.name === 'Child.props')?.breakingChanges)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'member-renamed', symbolName: 'Child.props.newName' })]));
  });

  it('does not report external packages as incomplete local cycle dependencies', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'api.ts'), "import { DynamoDBClient } from '@aws-sdk/client-dynamodb'; export const client = new DynamoDBClient({});\n");
    const analyzer = new BranchWatchAnalyzer(root);
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.limitations.join(' ')).not.toContain('not resolved locally');
  });

  it('does not scan historical blobs when the affected graph is acyclic', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'large.ts'), Buffer.alloc(3 * 1024 * 1024, 65));
    git(root, 'add', 'large.ts'); git(root, 'commit', '-m', 'large baseline');
    await fs.appendFile(path.join(root, 'api.ts'), '// changed\n');
    const analyzer = new BranchWatchAnalyzer(root);
    const baselineGraph = vi.spyOn(analyzer as any, 'baselineGraph');
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(baselineGraph).not.toHaveBeenCalled();
    expect(result.limitations.join(' ')).not.toContain('Git could not read this repository');
  });

  it('never expands an incomplete historical cycle baseline beyond the configured budget', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'api.ts'), "import { b } from './b'; export const value = b;\n");
    await fs.writeFile(path.join(root, 'b.ts'), "import { c } from './c'; export const b = c;\n");
    await fs.writeFile(path.join(root, 'c.ts'), "import { value } from './api'; export const c = value;\n");
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{}\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'cycle baseline');
    await fs.appendFile(path.join(root, 'api.ts'), '// changed\n');
    const analyzer = new BranchWatchAnalyzer(root, undefined, process.cwd(), 'git', 3);
    const gitCall = vi.spyOn(analyzer as any, 'git');

    const result = await analyzer.analyze(await analyzer.capture('main'));

    const blobReads = gitCall.mock.calls.filter(([args]) => args[0] === 'cat-file' && args[1] === 'blob');
    expect(blobReads.length).toBeLessThanOrEqual(3);
    expect(result.cycleSummary).toEqual({ detected: 0, scopeComplete: false });
    expect(result.limitations.join(' ')).toContain('3-file baseline limit');
  });

  it('keeps file impact for a body-only change and reports introduced versus historical file cycles', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'consumer.ts'), "import { value } from './api'; export const result = value(1);\n");
    git(root, 'add', '.'); git(root, 'commit', '-m', 'consumer');
    const spider = new Spider({ rootDir: root, enableReverseIndex: true, extensionPath: process.cwd() });
    const analyzer = new BranchWatchAnalyzer(root, spider, process.cwd());
    try {
      await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number) { return n + 1; }\n');
      await spider.buildFullIndex();
      const body = await analyzer.analyze(await analyzer.capture('main'));
      expect(body.fileImpacts[0].dependents).toContainEqual({ path: 'consumer.ts', depth: 1, changed: false });
      expect(body.limitations.join(' ')).toContain('behavior unverified');
      expect(body.review.symbols).toEqual([]);
      await fs.writeFile(path.join(root, 'api.ts'), "import { result } from './consumer'; export function value(n: number) { return n + result; }\n");
      await spider.reanalyzeFile(path.join(root, 'api.ts'));
      const introduced = await analyzer.analyze(await analyzer.capture('main'));
      expect(introduced.cycles[0]).toMatchObject({ classification: 'introduced', relation: 'file-dependency', nodePaths: ['api.ts', 'consumer.ts'] });
      expect(introduced.cycleSummary).toEqual({ detected: 1, scopeComplete: true });
      git(root, 'commit', '-am', 'cycle');
      await fs.appendFile(path.join(root, 'api.ts'), '// changed\n');
      expect((await analyzer.analyze(await analyzer.capture('main'))).cycles[0].classification).toBe('existing-touched');
      await fs.writeFile(path.join(root, 'api.ts'), git(root, 'show', 'HEAD:api.ts') + '\n');
      await fs.appendFile(path.join(root, 'removed.ts'), '// unrelated\n');
      expect((await analyzer.analyze(await analyzer.capture('main'))).cycles).toEqual([]);
      expect((await analyzer.analyze(await analyzer.capture('main'))).cycleSummary).toEqual({ detected: 0, scopeComplete: true });
    } finally { await spider.dispose(); }
  });

  it('keeps unsupported, deleted and unreadable files visible without a false clean result', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'notes.txt'), 'notes');
    await fs.unlink(path.join(root, 'removed.ts'));
    const analyzer = new BranchWatchAnalyzer(root);
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.fileImpacts.map(f => f.path)).toEqual(['notes.txt', 'removed.ts']);
    expect(result.fileImpacts.every(f => f.availability === 'unavailable')).toBe(true);
    expect(result.limitations.join(' ')).toContain('Dependency analysis unavailable');
    expect(result.limitations.join(' ')).not.toContain('Cycle cannot be determined');
    expect(result.cycleSummary).toEqual({ detected: 0, scopeComplete: true });
  });

  it('reviews a Python-only signature change (#546)', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'api.py'), 'def value(n):\n    return n\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'python');
    await fs.writeFile(path.join(root, 'api.py'), 'def value(n, m):\n    return n\n');
    const analyzer = new BranchWatchAnalyzer(root);
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.review.symbols.map(symbol => `${symbol.filePath}:${symbol.name}:${symbol.breakingChanges[0]?.type}`)).toEqual(['api.py:value:parameter-added-required']);
    expect(result.limitations.join(' ')).not.toContain('api.py: behavior unverified');
  }, GIT_TEST_TIMEOUT);

  it('reviews a deletion-only diff and lists the files still importing the deleted module (#546)', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'consumer.ts'), "import { old } from './removed';\nexport const copy = old;\n");
    git(root, 'add', '.'); git(root, 'commit', '-m', 'consumer');
    await fs.unlink(path.join(root, 'removed.ts'));
    const analyzer = new BranchWatchAnalyzer(root);
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.review.symbols).toEqual([expect.objectContaining({ filePath: 'removed.ts', name: '(module)', consumers: { updated: [], covered: [], unverified: ['consumer.ts'] } })]);
  }, GIT_TEST_TIMEOUT);

  it('has nothing to review when only untracked files changed', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'draft.ts'), 'export const draft = 1;\n');
    const analyzer = new BranchWatchAnalyzer(root);
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.review).toMatchObject({ changedFiles: [], symbols: [], isPartial: false, limitations: [] });
  }, GIT_TEST_TIMEOUT);

  it('clamps a file budget above the review limit instead of failing the review', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: string) { return n; }\n');
    const analyzer = new BranchWatchAnalyzer(root, undefined, undefined, 'git', 2000);
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.review.symbols.map(symbol => symbol.name)).toEqual(['value']);
  }, GIT_TEST_TIMEOUT);

  it('reviews the other files and marks the review partial when one changed source file cannot be compared (#546)', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'api.ts'), 'export function value(n: number) { return n; }\0\n');
    await fs.writeFile(path.join(root, 'removed.ts'), 'export const renamed = 1;\n');
    const analyzer = new BranchWatchAnalyzer(root);
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.review.isPartial).toBe(true);
    expect(result.review.limitations).toContain('Could not compare api.ts; File is binary.');
    expect(result.review.symbols.map(symbol => `${symbol.filePath}:${symbol.name}`)).toEqual(['removed.ts:old']);
  }, GIT_TEST_TIMEOUT);

  it('bounds impact depth and exposes lookup failures instead of inventing zero impact', async () => {
    const root = await workspace();
    await fs.appendFile(path.join(root, 'api.ts'), '// changed\n');
    const analyzer = new BranchWatchAnalyzer(root, {
      getSymbolDependents: async () => [],
      findReferencingFiles: async file => [{ path: path.join(root, path.basename(file) + '.ts') }],
    });
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.fileImpacts[0].availability).toBe('partial');
    expect(result.fileImpacts[0].dependents.map(d => d.depth)).toEqual([1, 2, 3]);
    const broken = new BranchWatchAnalyzer(root, { getSymbolDependents: async () => [], findReferencingFiles: async () => { throw new Error('unavailable'); } });
    expect((await broken.analyze(await broken.capture('main'))).fileImpacts[0].availability).toBe('partial');

    const recovered = new BranchWatchAnalyzer(root, {
      getSymbolDependents: async () => [],
      findReferencingFiles: async () => [],
      findReferencingFilesWithFallback: async () => [{ path: path.join(root, 'consumer.ts') }],
    });
    expect((await recovered.analyze(await recovered.capture('main'))).fileImpacts[0].dependents[0].path).toBe('consumer.ts');
  });

  it('stops an impact level at the first failed lookup, in queue order, like a sequential walk', async () => {
    const root = await workspace();
    await fs.appendFile(path.join(root, 'api.ts'), '// changed\n');
    const lookups: Record<string, () => Promise<Array<{ path: string }>>> = {
      'api.ts': async () => [{ path: path.join(root, 'dep-a.ts') }, { path: path.join(root, 'dep-b.ts') }],
      'dep-a.ts': async () => { throw new Error('index unavailable'); },
      'dep-b.ts': async () => [{ path: path.join(root, 'late.ts') }],
    };
    const analyzer = new BranchWatchAnalyzer(root, {
      getSymbolDependents: async () => [],
      findReferencingFiles: file => lookups[path.basename(file)]?.() ?? Promise.resolve([]),
    });
    const [impact] = (await analyzer.analyze(await analyzer.capture('main'))).fileImpacts;
    expect(impact.dependents.map(d => d.path)).toEqual(['dep-a.ts', 'dep-b.ts']);
    expect(impact.limitations).toContain('api.ts: dependency index lookup failed; impact is incomplete.');
  });

  it('keeps the affected-scope budget and leftover queue of a sequential cycle walk', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'api.ts'), "import { b } from './b'; export const value = b;\n");
    await fs.writeFile(path.join(root, 'b.ts'), "import { c } from './c'; export const b = c;\n");
    await fs.writeFile(path.join(root, 'c.ts'), "import { value } from './api'; export const c = value;\n");
    const chain = new BranchWatchAnalyzer(root, undefined, process.cwd(), 'git', 2);
    const limitations: string[] = [];
    const result = await chain.buildCycles({ changes: [{ path: 'api.ts', kind: 'modified' }], mergeBaseSha: 'HEAD' }, limitations);
    expect(result.summary).toEqual({ detected: 0, scopeComplete: false });
    expect(limitations).toEqual(['Cycle analysis reached the 2-file affected-scope limit.']);

    // Both seeds fit the budget; a sequential walk still queued 'b.ts' (read after 'api.ts'), so the limit is reported.
    const pair = new BranchWatchAnalyzer(root, undefined, process.cwd(), 'git', 2);
    await fs.writeFile(path.join(root, 'b.ts'), "import { value } from './api'; export const b = value;\n");
    const pairLimitations: string[] = [];
    await pair.buildCycles({ changes: [{ path: 'api.ts', kind: 'modified' }, { path: 'b.ts', kind: 'modified' }], mergeBaseSha: 'HEAD' }, pairLimitations);
    expect(pairLimitations).toEqual(['Cycle analysis reached the 2-file affected-scope limit.']);
  });

  it('keeps the edges read before a failed import resolution and reports the file', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 1;\n');
    const resolvePath = vi.fn(async (_from: string, module: string) => {
      if (module === './broken') throw new Error('resolver failed');
      return path.join(root, 'b.ts');
    });
    const getAnalyzer = vi.spyOn(LanguageService.prototype, 'getAnalyzer').mockReturnValue({
      parseImports: async () => [{ module: './b' }, { module: './broken' }, { module: './after' }],
      resolvePath,
    } as unknown as ReturnType<LanguageService['getAnalyzer']>);
    try {
      const limitations: string[] = [];
      await new BranchWatchAnalyzer(root, undefined, process.cwd()).buildCycles(
        { changes: [{ path: 'api.ts', kind: 'modified' }], mergeBaseSha: 'HEAD' }, limitations);
      expect(limitations).toContain('api.ts: dependency graph could not be analyzed.');
      expect(limitations.join(' ')).not.toContain("'./after'");
    } finally { getAnalyzer.mockRestore(); }
  });

  it('reserves a root lookup for every changed file after a large impact walk', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'other.ts'), 'export const other = 1;\n');
    git(root, 'add', 'other.ts'); git(root, 'commit', '-m', 'other');
    await fs.appendFile(path.join(root, 'api.ts'), '// changed\n');
    await fs.appendFile(path.join(root, 'other.ts'), '// changed\n');
    const analyzer = new BranchWatchAnalyzer(root, {
      getSymbolDependents: async () => [],
      findReferencingFiles: async file => file.endsWith('api.ts')
        ? Array.from({ length: 200 }, (_, index) => ({ path: path.join(root, `dep-${index}.ts`) })) : [],
      findReferencingFilesWithFallback: async file => file.endsWith('other.ts')
        ? [{ path: path.join(root, 'other-consumer.ts') }] : [],
    });
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(result.fileImpacts.find(impact => impact.path === 'other.ts')?.dependents[0].path).toBe('other-consumer.ts');
  });
});
