import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { captureWindow, controls, getContextKey, selectedTab, waitForFlow, waitForGraphViewResolved, waitUntil } from './_helpers';

interface EmptyState { reason: string; message?: string }

async function waitForEmptyState(reason: string): Promise<EmptyState> {
  let state: EmptyState | undefined;
  await waitUntil(async () => {
    state = await getContextKey<EmptyState>('graph-it-live.emptyState');
    return state?.reason === reason;
  }, `the view empty state "${reason}" (last: ${JSON.stringify(state)})`, 15_000);
  return state as EmptyState;
}

/** Runs each command in turn, checking it left the view mode on `file`. */
async function refuseInOrder([id, ...rest]: string[]): Promise<void> {
  if (!id) return;
  await vscode.commands.executeCommand(`graph-it-live.${id}`);
  assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file', `${id} switched the view mode`);
  return refuseInOrder(rest);
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
    await refuseInOrder(['forceReindex', 'refreshGraph', 'setViewModeList', 'setViewModeSymbol', 'setViewModeArchitecture',
      'showReverseDependencies', 'hideReverseDependencies', 'expandAllNodes', 'toggleViewMode']);
    await waitForEmptyState('no-workspace');
  });

  // Their notifications are checked in unit tests and by hand: E2E cannot read notifications.
  test('Set Workspace Folder and the index status run without a folder and leave the view alone', async () => {
    await vscode.commands.executeCommand('graph-it-live.setWorkspace');
    await vscode.commands.executeCommand('graph-it-live.showIndexStatus');
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file');
    assert.strictEqual((await getContextKey<EmptyState>('graph-it-live.emptyState'))?.reason, 'no-workspace');
  });

  // #795: Flow draws a loose file; Units, Folder and Matrix (and exports) ask for a folder. Runs last: it leaves the Architecture mode.
  test('Flow draws a loose file; the other diagrams ask for a folder', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'g-loose-'));
    const file = path.join(folder, 'main.ts');
    // A step is one file's symbols: the call must cross files to draw an edge.
    fs.writeFileSync(path.join(folder, 'lib.ts'), 'export function helper(): number {\n  return 1;\n}\n');
    fs.writeFileSync(file, "import { helper } from './lib';\n\nexport function main(): number {\n  return helper() + 1;\n}\n");
    const window = captureWindow();
    try {
      await vscode.commands.executeCommand('graph-it-live.showDiagram');
      assert.deepStrictEqual(window.messages, ['Graph-It-Live: Open a folder or a source file to see a diagram.']);
      assert.strictEqual(window.picks.length, 0, 'nothing to pick');

      const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
      editor.selection = new vscode.Selection(3, 4, 3, 4);
      window.messages.length = 0;
      await vscode.commands.executeCommand('graph-it-live.showDiagram');
      assert.deepStrictEqual(window.picks.map(pick => pick.labels), [['flow', 'sequence']], 'only Flow and Sequence without a folder');
      await vscode.commands.executeCommand('graph-it-live.showFolderDiagram');
      assert.deepStrictEqual(window.messages, ['Graph-It-Live: Open a folder to see the Folder diagram.']);
      assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file');

      await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
      const shown = await waitForFlow('the loose file flow', state => Boolean(state.entry?.includes('main')) && state.view?.flowRequestId === state.requestId, 30_000);
      assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'architecture');
      assert.strictEqual(selectedTab(shown), 'flow');
      assert.match(shown.nodes[0], /^Step 1 of 2: main, main\.ts:3, main lane$/);
      assert.ok(shown.edges.length > 0, 'main calls helper');
      assert.deepStrictEqual(shown.view?.tabs.filter(tab => tab.disabled).map(tab => tab.disabled), [
        'Open a folder to see the Units diagram', 'Open a folder to see the Folder diagram', 'Open a folder to see the Matrix diagram',
      ]);
      // #798 c: the loose file's entry as a sequence, on the Sequence tab.
      await controls({ tab: 'sequence' });
      const sequence = await waitForFlow('the loose file sequence', state =>
        state.drawnView === 'sequence' && state.view?.flowRequestId === state.requestId && selectedTab(state) === 'sequence', 30_000);
      assert.match(sequence.nodes[0], /^Lifeline 1 of \d+: main\.ts, main\.ts:1$/);
      await controls({ tab: 'flow' });
      await waitForFlow('the loose file flow again', state => state.drawnView === 'flow' && state.view?.flowRequestId === state.requestId && selectedTab(state) === 'flow', 30_000);

      window.messages.length = 0;
      await controls({ exportDiagram: { target: 'file', output: 'flow.svg' } });
      await waitUntil(async () => window.messages.length > 0, 'the export refusal');
      assert.deepStrictEqual(window.messages, ['Graph-It-Live: Open a folder to export the Flow diagram: exports are written inside the workspace.']);
    } finally {
      window.restore();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
