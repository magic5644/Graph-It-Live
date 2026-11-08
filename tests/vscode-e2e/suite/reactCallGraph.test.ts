/**
 * React components in the real call graph view (#591): JSX references are displayed with the React identity,
 * a click opens the component's declaration, and saving a renamed or removed component, or an importer that
 * renders another component, refreshes the displayed edges.
 */
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  getProjectFile, saveDocumentText as saveText, settleFileEvents, showCallGraphAndWait, shownCallGraph as shownGraph,
  waitForRootCallGraphEdges,
} from './_helpers';

const PROJECT = 'react-e2e-591';
const CARD = "import React from 'react';\nexport function Card() { return <section />; }\nexport default function Panel() { return <aside />; }\n";
const PAGE = `import * as UI from './ui';
import { Card as Tile } from './ui';
import Panel from './ui/Card';
export function Page() {
  return <main><UI.Card /><Tile /><Panel /></main>;
}
`;

/** Parsed JSON answer of a Graph-It-Live language model tool. */
async function invokeTool<T>(name: string, input: object): Promise<T | null> {
  const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
  const part = result.content.find(p => p instanceof vscode.LanguageModelTextPart);
  return part instanceof vscode.LanguageModelTextPart ? JSON.parse(part.value) as T : null;
}

/**
 * Whether the call graph index holds Card.tsx#Card, and the dependency index ui/index.ts, for failure messages.
 * Only a watcher event brings ui/index.ts into the dependency index: both ui/ files missing points at the folder watch.
 */
async function indexState(): Promise<string> {
  const card = getProjectFile(PROJECT, 'ui', 'Card.tsx').fsPath;
  const answer = await invokeTool<{ symbol: unknown; reason?: string; callers?: unknown[] }>('graph-it-live_query_call_graph',
    { filePath: card, symbolName: 'Card', direction: 'callers', depth: 1 });
  const importers = await invokeTool<{ referencingFiles?: Array<{ relativePath: string }> }>('graph-it-live_find_referencing_files', { targetPath: card });
  const barrel = importers?.referencingFiles?.some(file => file.relativePath.replaceAll('\\', '/').endsWith('ui/index.ts')) ? 'yes' : 'no';
  const indexed = answer?.symbol ? `yes, ${answer.callers?.length ?? 0} callers` : `no (${answer?.reason ?? 'no answer'})`;
  return `Card in the call graph index: ${indexed}; ui/index.ts in the dependency index: ${barrel}`;
}

/** Wait for the displayed root edges, with the index state in the failure message. */
const waitForRootEdges = (expected: string[], timeoutMs?: number) => waitForRootCallGraphEdges(expected, { timeoutMs, detail: indexState });

/**
 * Open Page.tsx with the cursor on `Page` and show its call graph, which must draw `expected` at once: show()
 * indexes Page's imports itself, without waiting for the create events of the setup files (#600).
 */
async function showPageGraph(expected: string[]): Promise<void> {
  const document = await vscode.workspace.openTextDocument(getProjectFile(PROJECT, 'Page.tsx'));
  const position = new vscode.Position(3, 16);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
  await showCallGraphAndWait(60000, 200);
  return waitForRootEdges(expected, 0);
}

suite('React components in the call graph view', () => {
  const card = () => getProjectFile(PROJECT, 'ui', 'Card.tsx');
  const page = () => getProjectFile(PROJECT, 'Page.tsx');
  const files = () => [card(), getProjectFile(PROJECT, 'ui', 'index.ts'), page()];

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
    await vscode.workspace.fs.writeFile(card(), Buffer.from(CARD));
    await vscode.workspace.fs.writeFile(getProjectFile(PROJECT, 'ui', 'index.ts'), Buffer.from("export * from './Card';\n"));
    await vscode.workspace.fs.writeFile(page(), Buffer.from(PAGE));
  });

  teardown(async function () {
    this.timeout(30000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // The call graph replaced the shared view's file graph: restore it for the next suite.
    await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    // Wait for the delete events to reach the index before the next test.
    await settleFileEvents(files(), () => Promise.all(files().map(file => vscode.workspace.fs.delete(file).then(undefined, () => undefined))));
  });

  test('displays JSX references to React components and opens a clicked component at its declaration', async function () {
    this.timeout(120000);
    await showPageGraph(['Page -REFERENCES@5-> Card', 'Page -REFERENCES@5-> Panel']);
    const graph = (await shownGraph())!;
    const cardNode = graph.nodes.find(node => node.name === 'Card');
    assert.ok(cardNode, JSON.stringify(graph.nodes));
    for (const name of ['Card', 'Panel']) {
      assert.strictEqual(graph.nodes.find(node => node.name === name)?.framework, 'react', `${name} should carry the React identity`);
    }

    assert.strictEqual(await vscode.commands.executeCommand('graph-it-live.e2eCallGraphClick', cardNode.id), true);

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'The click should open an editor');
    // path.relative ignores the drive letter case Windows may report differently.
    assert.strictEqual(path.relative(card().fsPath, editor.document.uri.fsPath), '', editor.document.uri.fsPath);
    const { line, character } = editor.selection.active;
    assert.deepStrictEqual([line, character], [cardNode.startLine, cardNode.startCol]);
    // The node starts at the declared name.
    assert.match(editor.document.lineAt(line).text, /^export function Card\(/);
    assert.ok(editor.document.lineAt(line).text.slice(character).startsWith('Card('), `Position ${character} is not on the name`);
    assert.strictEqual(line, 1, 'Card is declared on the second line');
  });

  test('refreshes the displayed edges when a component is renamed or removed, or an importer changes', async function () {
    this.timeout(180000);
    await showPageGraph(['Page -REFERENCES@5-> Card', 'Page -REFERENCES@5-> Panel']);

    // Renamed component: the importers' names no longer resolve, and no edge stays on the old declaration.
    await saveText(card(), CARD.replace('function Card', 'function Board'));
    await waitForRootEdges(['Page -REFERENCES@5-> Panel']);

    // Importer change: Page renders the renamed component through the barrel.
    await saveText(page(), PAGE.replace('<Tile />', '<UI.Board />'));
    await waitForRootEdges(['Page -REFERENCES@5-> Board', 'Page -REFERENCES@5-> Panel']);

    // Removed component: its edge disappears, the other one stays.
    await saveText(card(), CARD.replace('function Card', 'function Board').replace(/export default function Panel.*\n/, ''));
    await waitForRootEdges(['Page -REFERENCES@5-> Board']);
  });
});
