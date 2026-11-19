import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { shownCallGraph, showCallGraphAndWait, sleep } from './_helpers';

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
});
