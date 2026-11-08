/**
 * Vue templates in the real call graph view (#645): the SFC component node at the `<template>` shows the
 * template's components and calls, a click on a template target opens its `.vue` file at its `<template>`,
 * and saving an edited template refreshes the displayed edges.
 */
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  getProjectFile, saveDocumentText as saveText, settleFileEvents, showCallGraphAndWait, shownCallGraph as shownGraph,
  waitForRootCallGraphEdges as waitForRootEdges,
} from './_helpers';

const PROJECT = 'vue-e2e-645';
const CHILD = '<script setup lang="ts">\nconst row = 1;\n</script>\n\n<template>\n  <slot :row="row" />\n</template>\n';
const FORMAT = 'export function format(value: number): string {\n  return String(value);\n}\n';
const PARENT = `<script setup lang="ts">
import Child from "./Child.vue";
import { format } from "./format";
</script>

<template>
  <section>
    <Child />
    <p>{{ format(1) }}</p>
  </section>
</template>
`;

suite('Vue templates in the call graph view', () => {
  const parent = () => getProjectFile(PROJECT, 'Parent.vue');
  const child = () => getProjectFile(PROJECT, 'Child.vue');
  const files = () => [child(), getProjectFile(PROJECT, 'format.ts'), parent()];

  /** Open Parent.vue with the cursor inside its template and show the component node's call graph. */
  async function showParentGraph(expected: string[]): Promise<void> {
    const document = await vscode.workspace.openTextDocument(parent());
    const position = new vscode.Position(7, 6);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
    await showCallGraphAndWait(60000, 200);
    return waitForRootEdges(expected);
  }

  suiteSetup(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    assert.ok(ext, 'Extension should exist');
    if (!ext.isActive) await ext.activate();
    await vscode.commands.executeCommand('graph-it-live.graphView.focus');
  });

  suiteTeardown(async function () {
    this.timeout(30000);
    // Wait for the delete events to reach the index before the next suite.
    await settleFileEvents([getProjectFile(PROJECT)],
      () => vscode.workspace.fs.delete(getProjectFile(PROJECT), { recursive: true }).then(undefined, () => undefined));
  });

  setup(async function () {
    this.timeout(30000);
    await vscode.workspace.fs.writeFile(child(), Buffer.from(CHILD));
    await vscode.workspace.fs.writeFile(getProjectFile(PROJECT, 'format.ts'), Buffer.from(FORMAT));
    await vscode.workspace.fs.writeFile(parent(), Buffer.from(PARENT));
  });

  teardown(async function () {
    this.timeout(30000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // The call graph replaced the shared view's file graph: restore it for the next suite.
    await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    // Wait for the delete events to reach the index before the next test.
    await settleFileEvents(files(), () => Promise.all(files().map(file => vscode.workspace.fs.delete(file).then(undefined, () => undefined))));
  });

  test('displays template components and calls, and opens a clicked template target at its <template>', async function () {
    this.timeout(120000);
    await showParentGraph(['Parent -CALLS@9-> format', 'Parent -REFERENCES@8-> Child']);
    const graph = (await shownGraph())!;
    assert.strictEqual(graph.nodes.find(node => node.id === graph.rootSymbolId)?.name, 'Parent', 'The cursor in the template selects the component node');
    const childNode = graph.nodes.find(node => node.name === 'Child');
    assert.ok(childNode, JSON.stringify(graph.nodes));

    assert.strictEqual(await vscode.commands.executeCommand('graph-it-live.e2eCallGraphClick', childNode.id), true);

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'The click should open an editor');
    // path.relative ignores the drive letter case Windows may report differently.
    assert.strictEqual(path.relative(child().fsPath, editor.document.uri.fsPath), '', editor.document.uri.fsPath);
    const { line, character } = editor.selection.active;
    assert.deepStrictEqual([line, character], [4, 0], 'Child.vue opens at its <template> element');
    assert.match(editor.document.lineAt(line).text, /^<template>/);
  });

  test('refreshes the displayed edges when the template is edited', async function () {
    this.timeout(180000);
    await showParentGraph(['Parent -CALLS@9-> format', 'Parent -REFERENCES@8-> Child']);

    // The component is removed from the template: its edge goes, the call stays and keeps its line.
    await saveText(parent(), PARENT.replace('    <Child />\n', '    <hr />\n'));
    await waitForRootEdges(['Parent -CALLS@9-> format']);

    // The call becomes a handler reference, and the component comes back one line lower.
    await saveText(parent(), PARENT.replace('{{ format(1) }}', '<button @click="format">x</button>').replace('    <Child />\n', '    <hr />\n    <Child />\n'));
    await waitForRootEdges(['Parent -REFERENCES@10-> format', 'Parent -REFERENCES@9-> Child']);
  });
});
