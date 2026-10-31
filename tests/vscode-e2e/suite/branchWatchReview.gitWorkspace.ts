import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface SnapshotItem {
  label: string | { label: string };
  description?: string;
  children?: SnapshotItem[];
}

interface BranchWatchSnapshot {
  state: { phase: string; reason?: string };
  items: SnapshotItem[];
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
});
