import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { captureWindow, controls, shownCallGraph, showCallGraphAndWait, sleep, waitForFlow } from './_helpers';

/**
 * #770: run in a two-folder workspace whose `graph-it-live.workspaceFolder` names the second folder
 * (see runTests.ts). The call graph used the first folder's index: callers in the second were missing.
 */
suite('Multi-root workspace (#770)', function () {
  this.timeout(120_000);

  test('the call graph of a file in the selected folder shows its callers from that folder', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.strictEqual(folders.length, 2, 'This suite needs a two-folder workspace');
    await vscode.extensions.getExtension('magic5644.graph-it-live')?.activate();
    await vscode.commands.executeCommand('graph-it-live.graphView.focus');
    await sleep(800);

    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folders[1].uri, 'lib.ts'));
    const editor = await vscode.window.showTextDocument(document);
    const position = document.positionAt(document.getText().indexOf('beta'));
    editor.selection = new vscode.Selection(position, position);
    await showCallGraphAndWait(90_000, 200);

    const graph = await shownCallGraph();
    const names = graph?.nodes.map(node => node.name) ?? [];
    assert.ok(names.includes('beta'), `Root missing: ${JSON.stringify(names)}`);
    assert.ok(names.includes('run'), `Caller from the selected folder missing: ${JSON.stringify(names)}`);
  });

  // #823: the other folder's file was drawn against the analyzed folder, and the view said "No calls found".
  test('Seq on a file of the other folder draws its calls against that folder; Flow says they stay in the file', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    await vscode.extensions.getExtension('magic5644.graph-it-live')?.activate();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folders[0].uri, 'maths', 'index.ts'));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(2, 20, 2, 20);
    const window = captureWindow();
    try {
      await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
      // The path is relative to the file's own folder, not to the analyzed one (../first/…).
      const message = 'format makes 3 calls, all inside maths/index.ts: a Flow step is one file, so no call joins two steps. Use view sequence to see them.';
      const flow = await waitForFlow('the flow refusal of format', state => state.state === 'error', 90_000);
      assert.strictEqual(flow.lastError, message);
      assert.deepStrictEqual(window.messages, [`Graph-It-Live: ${message}`], 'said once');

      window.answer = 'sequence';
      await vscode.commands.executeCommand('graph-it-live.showDiagram');
      const shown = await waitForFlow('the sequence of format', state => state.drawnView === 'sequence' && state.view?.flowRequestId === state.requestId, 90_000);
      assert.deepStrictEqual(shown.edges.map(name => /→ (\w+)/.exec(name)?.[1]), ['toNumber', 'mathFix', 'toNumber'], shown.edges.join(' | '));
      assert.deepStrictEqual(shown.view?.crumbs, ['first', 'maths', 'index.ts', 'format']);

      // The Flow tab from that sequence: the refusal alone, on the Flow tab, not over the sequence.
      await controls({ tab: 'flow' });
      const refused = await waitForFlow('the refusal on the Flow tab', state =>
        state.view?.flowLine === message && state.view.tabs.some(tab => tab.tab === 'flow' && tab.selected), 90_000);
      assert.deepStrictEqual(refused.view?.flowButtons, [], 'no sequence drawn under the refusal');
    } finally {
      window.restore();
      await controls({ tab: 'units' });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    }
  });
});
