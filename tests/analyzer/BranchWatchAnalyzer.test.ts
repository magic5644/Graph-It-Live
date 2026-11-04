import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_WATCH_MAX_FILES, BRANCH_WATCH_MAX_FILES_LIMIT, BranchWatchAnalyzer, BranchWatchError,
  normalizeBranchWatchMaxFiles, parseCatFileBatch } from '@/analyzer/BranchWatchAnalyzer';
import { LanguageService } from '@/analyzer/LanguageService';
import type { Dependency } from '@/analyzer/types';
import { Spider } from '@/analyzer/Spider';
import { normalizePath } from '@/shared/path';

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

describe('parseCatFileBatch', () => {
  it('splits the blobs of a batch, empty and binary ones included', () => {
    const output = Buffer.concat([Buffer.from('a1 blob 3\nabc\nb2 blob 0\n\nc3 blob 2\n'), Buffer.from([0, 10]), Buffer.from('\n')]);
    expect(parseCatFileBatch(output).map(blob => [...blob])).toEqual([[97, 98, 99], [], [0, 10]]);
    expect(parseCatFileBatch(Buffer.alloc(0))).toEqual([]);
  });

  it('rejects a missing object or a truncated output', () => {
    expect(() => parseCatFileBatch(Buffer.from('a1 missing\n'))).toThrow('Git returned no readable blob for a1.');
    expect(() => parseCatFileBatch(Buffer.from('a1 blob 9\nabc\n'))).toThrow(BranchWatchError);
    expect(() => parseCatFileBatch(Buffer.from('a1 blob 3'))).toThrow('Git returned no readable blob for a1.');
  });
});

describe('BranchWatchAnalyzer ref tree', { timeout: GIT_TEST_TIMEOUT }, () => {
  it('copies every tracked file: binary and oversized ones empty, a limitation only for source files', async () => {
    const root = await workspace(false);
    await fs.mkdir(path.join(root, 'assets'));
    await fs.writeFile(path.join(root, 'assets', 'logo.png'), Buffer.from([137, 80, 0, 71]));
    await fs.writeFile(path.join(root, 'assets', 'big.txt'), Buffer.alloc(3 * 1024 * 1024, 65));
    await fs.writeFile(path.join(root, 'bin.ts'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(root, 'style.css'), 'a {}\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
    const analyzer = new BranchWatchAnalyzer(root);
    const copied = await analyzer.withRefTree('HEAD', async (directory, limitations) => ({
      limitations,
      files: Object.fromEntries(await Promise.all(['api.ts', 'style.css', 'assets/logo.png', 'assets/big.txt', 'bin.ts'].map(async file =>
        [file, await fs.readFile(path.join(directory, file), 'utf8').catch(() => null)]))),
    }));
    expect(copied.files).toEqual({ 'api.ts': 'export function value(n: number) { return n; }\n', 'style.css': 'a {}\n', 'assets/logo.png': '', 'assets/big.txt': '', 'bin.ts': null });
    expect(copied.limitations).toEqual(['bin.ts: baseline file is binary.']);
    expect(await analyzer.mergeBase('main', 'HEAD')).toBe(git(root, 'rev-parse', 'HEAD'));
  });

  it('rejects a ref Git cannot read', async () => {
    const root = await workspace();
    await expect(new BranchWatchAnalyzer(root).withRefTree('no-such-ref', async () => undefined)).rejects.toThrow(BranchWatchError);
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
    const refGraph = vi.spyOn(analyzer as any, 'refGraph');
    const result = await analyzer.analyze(await analyzer.capture('main'));
    expect(refGraph).not.toHaveBeenCalled();
    expect(result.limitations.join(' ')).not.toContain('Git could not read this repository');
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

describe('BranchWatchAnalyzer whole-graph cycles (#605)', { timeout: GIT_TEST_TIMEOUT }, () => {
  /** api.ts -> b.ts -> c.ts -> api.ts in the working tree; `committed` commits it as the base. */
  async function cycleWorkspace(committed: boolean) {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'api.ts'), "import { b } from './b'; export const value = b;\n");
    await fs.writeFile(path.join(root, 'b.ts'), "import { c } from './c'; export const b = c;\n");
    await fs.writeFile(path.join(root, 'c.ts'), committed ? "import { value } from './api'; export const c = value;\n" : 'export const c = 1;\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'chain');
    if (!committed) await fs.writeFile(path.join(root, 'c.ts'), "import { value } from './api'; export const c = value;\n");
    return root;
  }
  const changed = (...files: string[]) => files.map(file => ({ path: file, kind: 'modified' as const }));

  it('reports a cycle wider than maxFiles, with no scope limitation', async () => {
    const root = await cycleWorkspace(false);
    const analyzer = new BranchWatchAnalyzer(root, undefined, process.cwd(), 'git', 1);
    const limitations: string[] = [];
    const result = await analyzer.buildCycles({ changes: changed('c.ts'), mergeBaseSha: git(root, 'rev-parse', 'HEAD') }, limitations);
    expect(result.findings).toEqual([expect.objectContaining({ classification: 'introduced', nodePaths: ['api.ts', 'b.ts', 'c.ts'], changedPaths: ['c.ts'] })]);
    expect(result.summary).toEqual({ detected: 1, scopeComplete: true });
    expect(limitations).toEqual([]);
  });

  it('builds the base graph once per merge base, and again when the merge base moves', async () => {
    const root = await cycleWorkspace(true);
    const analyzer = new BranchWatchAnalyzer(root, undefined, process.cwd());
    const withRefTree = vi.spyOn(analyzer, 'withRefTree');
    const first = git(root, 'rev-parse', 'HEAD');
    await fs.appendFile(path.join(root, 'api.ts'), '// edit 1\n');
    const touched = await analyzer.buildCycles({ changes: changed('api.ts'), mergeBaseSha: first }, []);
    expect(touched.findings.map(finding => finding.classification)).toEqual(['existing-touched']);
    await fs.appendFile(path.join(root, 'b.ts'), '// edit 2\n');
    await analyzer.buildCycles({ changes: changed('api.ts', 'b.ts'), mergeBaseSha: first }, []);
    expect(withRefTree).toHaveBeenCalledTimes(1);

    // The base drops the back edge: the same head cycle is now introduced, from a freshly built base.
    await fs.writeFile(path.join(root, 'c.ts'), 'export const c = 1;\n');
    git(root, 'commit', '-qam', 'break cycle');
    const second = git(root, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(root, 'c.ts'), "import { value } from './api'; export const c = value;\n");
    const introduced = await analyzer.buildCycles({ changes: changed('c.ts'), mergeBaseSha: second }, []);
    expect(introduced.findings.map(finding => finding.classification)).toEqual(['introduced']);
    expect(withRefTree.mock.calls.map(([ref]) => ref)).toEqual([first, second]);
  });

  it('reports an unreadable base as a limitation, not as an empty result, and retries it', async () => {
    const root = await cycleWorkspace(true);
    const analyzer = new BranchWatchAnalyzer(root, undefined, process.cwd());
    const withRefTree = vi.spyOn(analyzer, 'withRefTree');
    const missing = '0'.repeat(40);
    for (let attempt = 0; attempt < 2; attempt++) {
      const limitations: string[] = [];
      // eslint-disable-next-line no-await-in-loop -- the second attempt checks that the failure was not cached
      const result = await analyzer.buildCycles({ changes: changed('api.ts'), mergeBaseSha: missing }, limitations);
      expect(result).toEqual({ findings: [], summary: { detected: 0, scopeComplete: false } });
      expect(limitations.join(' ')).toContain('Cycle cannot be determined: the merge-base import graph could not be read.');
    }
    expect(withRefTree).toHaveBeenCalledTimes(2);
  });

  it('reads the head graph from the index without parsing a workspace file', async () => {
    const root = await cycleWorkspace(false);
    const dependency = (file: string): Dependency => ({ path: path.join(root, file), type: 'import', line: 1, module: `./${file}` });
    const indexed: Record<string, Dependency[]> = { 'api.ts': [dependency('b.ts')], 'b.ts': [dependency('c.ts')], 'c.ts': [dependency('api.ts')] };
    const analyze = vi.fn(async (file: string) => indexed[path.basename(file)] ?? []);
    const getAnalyzer = vi.spyOn(LanguageService.prototype, 'getAnalyzer');
    try {
      const analyzer = new BranchWatchAnalyzer(root, { getSymbolDependents: async () => [], analyze } as never, process.cwd());
      const result = await analyzer.buildCycles({ changes: changed('c.ts'), mergeBaseSha: git(root, 'rev-parse', 'HEAD') }, []);
      expect(result.findings.map(finding => finding.classification)).toEqual(['introduced']);
      expect(analyze.mock.calls.map(([file]) => path.basename(file)).sort()).toEqual(['api.ts', 'b.ts', 'c.ts', 'removed.ts']);
      const parsedInWorkspace = getAnalyzer.mock.calls.filter(([file]) => normalizePath(file).startsWith(normalizePath(root) + '/'));
      expect(parsedInWorkspace).toEqual([]);
    } finally { getAnalyzer.mockRestore(); }
  });

  it('prefers the reverse index (analyzeFromIndex) over analyze for the head graph', async () => {
    const root = await cycleWorkspace(false);
    const analyze = vi.fn(async () => []);
    const analyzeFromIndex = vi.fn(async () => []);
    await new BranchWatchAnalyzer(root, { getSymbolDependents: async () => [], analyze, analyzeFromIndex } as never, process.cwd())
      .buildCycles({ changes: changed('c.ts'), mergeBaseSha: 'HEAD' }, []);
    expect(analyzeFromIndex).toHaveBeenCalledTimes(4);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('does not build the base when no head cycle goes through a changed file', async () => {
    const root = await cycleWorkspace(false);
    const analyzer = new BranchWatchAnalyzer(root, undefined, process.cwd());
    const withRefTree = vi.spyOn(analyzer, 'withRefTree');
    const result = await analyzer.buildCycles({ changes: changed('removed.ts'), mergeBaseSha: git(root, 'rev-parse', 'HEAD') }, []);
    expect(result).toEqual({ findings: [], summary: { detected: 0, scopeComplete: true } });
    expect(withRefTree).not.toHaveBeenCalled();
  });

  it('reports a head file the index cannot analyze as a limitation', async () => {
    const root = await cycleWorkspace(false);
    const analyze = vi.fn(async (file: string) => { if (file.endsWith('b.ts')) throw new Error('not indexed'); return []; });
    const limitations: string[] = [];
    const result = await new BranchWatchAnalyzer(root, { getSymbolDependents: async () => [], analyze } as never, process.cwd())
      .buildCycles({ changes: changed('c.ts'), mergeBaseSha: 'HEAD' }, limitations);
    expect(result.summary).toEqual({ detected: 0, scopeComplete: false });
    expect(limitations).toEqual(['Import graph at the working tree: 1 file(s) could not be analyzed.']);
  });

  it('matches Windows-style changed paths with the normalized graph paths', async () => {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'a.ts'), "import { b } from './b'; export const a = b;\n");
    await fs.writeFile(path.join(root, 'src', 'b.ts'), "import { a } from './a'; export const b = a;\n");
    const result = await new BranchWatchAnalyzer(root, undefined, process.cwd())
      .buildCycles({ changes: [{ path: String.raw`src\a.ts`, kind: 'untracked' }], mergeBaseSha: git(root, 'rev-parse', 'HEAD') }, []);
    expect(result.findings).toEqual([expect.objectContaining({ classification: 'introduced', nodePaths: ['src/a.ts', 'src/b.ts'], changedPaths: ['src/a.ts'] })]);
  });

  it('reads an explicit head ref from its committed tree, cached by its SHA', async () => {
    const root = await cycleWorkspace(false);
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-qb', 'feature'); git(root, 'commit', '-qam', 'cycle'); git(root, 'checkout', '-q', 'main');
    const head = git(root, 'rev-parse', 'feature');
    const analyzer = new BranchWatchAnalyzer(root, undefined, process.cwd());
    const withRefTree = vi.spyOn(analyzer, 'withRefTree');
    const scope = { changes: changed('c.ts'), mergeBaseSha: base, headReference: 'feature', headSha: head };
    expect((await analyzer.buildCycles(scope, [])).findings.map(finding => finding.classification)).toEqual(['introduced']);
    await analyzer.buildCycles(scope, []);
    expect(withRefTree.mock.calls.map(([ref]) => ref)).toEqual([head, base]);
  });
});
