import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getContextKey, sleep, waitForGraphViewResolved } from './_helpers';

interface EmptyState { reason: string; message?: string }

async function waitForEmptyState(reason: string, deadline = Date.now() + 15_000): Promise<EmptyState> {
  const state = await getContextKey<EmptyState>('graph-it-live.emptyState');
  if (state?.reason === reason) return state;
  if (Date.now() >= deadline) assert.fail(`View empty state is ${JSON.stringify(state)}, expected reason "${reason}"`);
  await sleep(200);
  return waitForEmptyState(reason, deadline);
}

/** #770: run in a window with no folder open (see runTests.ts). */
suite('Without a folder (#770)', function () {
  this.timeout(60_000);

  suiteSetup(async () => {
    assert.strictEqual(vscode.workspace.workspaceFolders, undefined, 'This suite needs a window without a folder');
    await vscode.extensions.getExtension('magic5644.graph-it-live')?.activate();
  });

  test('the Dependency Graph view asks for a folder instead of waiting for graph data', async () => {
    await vscode.commands.executeCommand('graph-it-live.showGraph');
    await waitForGraphViewResolved();
    const state = await waitForEmptyState('no-workspace');
    assert.strictEqual(state.message, 'Open a folder to see its dependency graph');
  });

  test('view commands refuse without switching the view mode', async () => {
    await waitForGraphViewResolved();
    for (const id of ['forceReindex', 'refreshGraph', 'setViewModeList', 'setViewModeSymbol', 'setViewModeArchitecture',
      'showReverseDependencies', 'hideReverseDependencies', 'expandAllNodes', 'toggleViewMode']) {
      await vscode.commands.executeCommand(`graph-it-live.${id}`);
      assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file', `${id} switched the view mode`);
    }
    await waitForEmptyState('no-workspace');
  });

  test('Set Workspace Folder and the index status answer without a folder', async () => {
    await vscode.commands.executeCommand('graph-it-live.setWorkspace');
    await vscode.commands.executeCommand('graph-it-live.showIndexStatus');
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file');
  });
});
