import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { branchWatchReact, fixtureGit } from '../fixtures/branchWatch.fixture';
import { getIndexStatus, sleep, waitUntil } from './_helpers';

interface SnapshotItem {
  label: string | { label: string };
  description?: string;
  children?: SnapshotItem[];
}

interface BranchWatchSnapshot {
  state: { phase: string; reason?: string; result?: { review: { symbols: Array<{ name: string; unusedExportEvidence: boolean }> } } };
  items: SnapshotItem[];
  maxFiles: number;
}

const labelOf = (item: SnapshotItem): string => typeof item.label === 'string' ? item.label : item.label.label;

/** Labels of the "Consumers to review" rows: one per reviewed symbol, `<name>: <changes>`. */
function reviewedSymbols(snapshot: BranchWatchSnapshot): string[] {
  const group = snapshot.items.find(item => labelOf(item).startsWith('Consumers to review'));
  return (group?.children ?? []).map(labelOf);
}

async function snapshotOf(): Promise<BranchWatchSnapshot> {
  const snapshot = await vscode.commands.executeCommand<BranchWatchSnapshot>('graph-it-live.branchWatch.testSnapshot');
  assert.ok(snapshot, 'The test snapshot command must be available');
  return snapshot;
}

/** Polls until Branch Watch is ready and `predicate` holds; the last snapshot is in the failure message. */
async function waitForReview(predicate: (symbols: string[]) => boolean, deadline = Date.now() + 90_000): Promise<string[]> {
  const snapshot = await snapshotOf();
  if (snapshot.state.phase === 'ready' && predicate(reviewedSymbols(snapshot))) return reviewedSymbols(snapshot);
  if (Date.now() >= deadline) {
    assert.fail(`Branch Watch review not reached: ${JSON.stringify({ state: snapshot.state, symbols: reviewedSymbols(snapshot) })}`);
  }
  if (snapshot.state.phase === 'unavailable') await vscode.commands.executeCommand('graph-it-live.branchWatch.refresh');
  await new Promise(resolve => setTimeout(resolve, 500));
  return waitForReview(predicate, deadline);
}

/**
 * Regression (#546): Branch Watch filtered the diff before reviewing it, so a Python-only change
 * or a deleted module showed no review while `review-pr` reported one.
 */
suite('Branch Watch review in a Git workspace (#546)', function () {
  this.timeout(180_000);
  const root = (): string => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The Branch Watch fixture repository must be open');
    return folder.uri.fsPath;
  };

  suiteSetup(async () => {
    await vscode.extensions.getExtension('magic5644.graph-it-live')?.activate();
    await waitForReview(() => true);
  });

  test('shows a review for a Python-only signature change', async () => {
    await fs.writeFile(path.join(root(), 'python', 'api.py'), 'def value(n, required):\n    return n\n');
    await vscode.commands.executeCommand('graph-it-live.branchWatch.refresh');
    const symbols = await waitForReview(labels => labels.some(label => label.startsWith('value: ')));
    assert.ok(symbols.some(label => /^value: .*required/.test(label)), `Python change not reviewed: ${JSON.stringify(symbols)}`);
    await fs.writeFile(path.join(root(), 'python', 'api.py'), 'def value(n):\n    return n\n');
    await vscode.commands.executeCommand('graph-it-live.branchWatch.refresh');
    await waitForReview(labels => labels.length === 0);
  });

  test('shows a review for a deleted module that is still imported', async () => {
    const source = path.join(root(), 'typescript', 'api.ts');
    const content = await fs.readFile(source, 'utf8');
    await fs.rm(source);
    try {
      await vscode.commands.executeCommand('graph-it-live.branchWatch.refresh');
      const symbols = await waitForReview(labels => labels.some(label => label.startsWith('value: ')));
      assert.ok(symbols.some(label => label.startsWith("value: Function 'value' was removed")), `Deletion not reviewed: ${JSON.stringify(symbols)}`);
    } finally {
      await fs.writeFile(source, content);
    }
  });

  test('shows a JSX-only consumer and the unchecked props contract after a save (#576)', async () => {
    const source = path.join(root(), branchWatchReact.source);
    try {
      await fs.writeFile(source, branchWatchReact.changed);
      await vscode.commands.executeCommand('graph-it-live.branchWatch.refresh');
      await waitForReview(labels => labels.some(label => label.startsWith('Widget: ')));
      const snapshot = await snapshotOf();
      const visibleTree = JSON.stringify(snapshot.items);
      assert.ok(visibleTree.includes(branchWatchReact.consumer), `JSX consumer missing from the tree: ${visibleTree}`);
      assert.ok(visibleTree.includes('props-contract compatibility is not checked'), `Props limitation missing: ${visibleTree}`);
      const widget = snapshot.state.result?.review.symbols.find(symbol => symbol.name === 'Widget');
      assert.ok(widget, 'The saved component must be reviewed');
      assert.strictEqual(widget.unusedExportEvidence, false, 'JSX-only consumption must prevent unused-export evidence');
    } finally {
      await fs.writeFile(source, branchWatchReact.content);
    }
  });

  // #770: picking a branch reset the file limit to 200; an item command without its item flipped the view to unavailable.
  test('keeps the file limit after Select Base Branch, and reports an item command run without its item', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const configuration = vscode.workspace.getConfiguration('graph-it-live', folder.uri);
    try {
      await configuration.update('branchWatch.maxFiles', 25, vscode.ConfigurationTarget.WorkspaceFolder);
      await waitUntil(async () => (await snapshotOf()).maxFiles === 25, 'maxFiles 25 applied');

      // No API reports an open quick pick: give it time to list the fixture's branches (never empty: main, feature).
      // The chosen base is saved in the temporary repository, removed after this last suite test.
      const picking = vscode.commands.executeCommand('graph-it-live.branchWatch.selectBase');
      await new Promise(resolve => setTimeout(resolve, 1500));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await picking;
      assert.strictEqual((await snapshotOf()).maxFiles, 25, 'Select Base Branch must keep branchWatch.maxFiles');

      await vscode.commands.executeCommand('graph-it-live.branchWatch.openFile');
      assert.notStrictEqual((await snapshotOf()).state.phase, 'unavailable', 'A missing item must not mark Branch Watch unavailable');
    } finally {
      await configuration.update('branchWatch.maxFiles', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    }
  });

  // #345: the LM tool returns the structure diff of a folder rename, the same as the built CLI.
  test('review_pr returns the structure diff of a renamed folder, like the CLI', async function () {
    if (typeof vscode.lm.invokeTool !== 'function') this.skip();
    const worktree = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-rename-e2e-')), 'wt');
    try {
      // A worktree keeps the open workspace (and Branch Watch) on `feature`.
      fixtureGit(root(), 'worktree', 'add', '-b', 'rename-e2e', worktree, 'feature');
      fixtureGit(worktree, 'mv', 'typescript', 'typescript-renamed');
      fixtureGit(worktree, '-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-m', 'rename typescript');

      for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
        if ((await getIndexStatus<{ isReady?: boolean }>()).isReady) break;
        await sleep(500);
      }
      const invoked = await vscode.lm.invokeTool('graph-it-live_review_pr', {
        input: { baseRef: 'main', headRef: 'rename-e2e', response_format: 'json' },
        toolInvocationToken: undefined,
      });
      const lm = JSON.parse(invoked.content.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('')) as { structure?: { verdict: string; groups: { items: Array<{ status: string }> } } };
      assert.ok(lm.structure, `structure missing from the LM tool result: ${JSON.stringify(lm).slice(0, 500)}`);
      assert.strictEqual(lm.structure.verdict, 'changed');
      assert.ok(lm.structure.groups.items.some(item => item.status === 'RENAMED'), JSON.stringify(lm.structure.groups.items));

      const cliEntry = path.resolve(__dirname, '../../../dist/graph-it.js');
      const cli = JSON.parse(execFileSync(process.execPath, [cliEntry, 'review-pr', '--workspace', root(), '--base', 'main', '--head', 'rename-e2e', '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as { structure: unknown };
      assert.deepStrictEqual(lm.structure, cli.structure);
    } finally {
      try { fixtureGit(root(), 'worktree', 'remove', '--force', worktree); } catch { /* already removed */ }
      try { fixtureGit(root(), 'branch', '-D', 'rename-e2e'); } catch { /* never created */ }
      await fs.rm(path.dirname(worktree), { recursive: true, force: true });
    }
  });
});
