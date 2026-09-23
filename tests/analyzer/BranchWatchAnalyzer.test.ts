import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BranchWatchAnalyzer, BranchWatchError } from '@/analyzer/BranchWatchAnalyzer';
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

describe('BranchWatchAnalyzer capture', () => {
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
    expect(before.limitations.join(' ')).toContain('deletion impact');
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
    await fs.writeFile(path.join(root, 'working-only.ts'), 'export {};\n');
    const snapshot = await new BranchWatchAnalyzer(root).capture('main', 'feature');
    expect(snapshot.referenceSha).toBe(base);
    expect(snapshot.headReference).toBe('feature');
    expect(snapshot.changes).toEqual([{ path: 'api.ts', kind: 'modified' }]);
    expect(snapshot.limitations.join(' ')).toContain('committed reference');
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
});

describe('BranchWatchAnalyzer findings', () => {
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
  }, 15_000);

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
