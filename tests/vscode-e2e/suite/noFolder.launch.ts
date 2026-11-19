import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getContextKey, waitForGraphViewResolved, waitUntil } from './_helpers';

interface EmptyState { reason: string; message?: string }

async function waitForEmptyState(reason: string): Promise<EmptyState> {
  let state: EmptyState | undefined;
  await waitUntil(async () => {
    state = await getContextKey<EmptyState>('graph-it-live.emptyState');
    return state?.reason === reason;
  }, `the view empty state "${reason}" (last: ${JSON.stringify(state)})`, 15_000);
  return state as EmptyState;
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

  // Their notifications are checked in unit tests and by hand: E2E cannot read notifications.
  test('Set Workspace Folder and the index status run without a folder and leave the view alone', async () => {
    await vscode.commands.executeCommand('graph-it-live.setWorkspace');
    await vscode.commands.executeCommand('graph-it-live.showIndexStatus');
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file');
    assert.strictEqual((await getContextKey<EmptyState>('graph-it-live.emptyState'))?.reason, 'no-workspace');
  });
});
