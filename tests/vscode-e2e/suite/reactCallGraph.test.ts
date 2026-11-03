/**
 * React components in the real call graph view (#591): JSX references are displayed with the React identity,
 * a click opens the component's declaration, and saving a renamed or removed component, or an importer that
 * renders another component, refreshes the displayed edges.
 */
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getContextKey, getProjectFile, showCallGraphAndWait, sleep } from './_helpers';

interface ShownGraph {
  rootSymbolId: string;
  nodes: Array<{ id: string; name: string; path: string; startLine: number; startCol: number; framework?: string }>;
  edges: Array<{ sourceId: string; targetId: string; typeRelation: string; sourceLine: number }>;
}

const PROJECT = 'react-e2e-591';
const CARD = "import React from 'react';\nexport function Card() { return <section />; }\nexport default function Panel() { return <aside />; }\n";
const PAGE = `import * as UI from './ui';
import { Card as Tile } from './ui';
import Panel from './ui/Card';
export function Page() {
  return <main><UI.Card /><Tile /><Panel /></main>;
}
`;

const shownGraph = async () => (await getContextKey<ShownGraph | null>('graph-it-live.callGraph')) ?? null;

/** `Source -RELATION@line-> Target` edges leaving the graph root, with 1-based lines, deduplicated. */
function rootEdges(graph: ShownGraph | null): string[] {
  if (!graph) return [];
  const name = (id: string) => graph.nodes.find(node => node.id === id)?.name ?? id;
  const edges = graph.edges
    .filter(edge => edge.sourceId === graph.rootSymbolId)
    .map(edge => `${name(edge.sourceId)} -${edge.typeRelation}@${edge.sourceLine + 1}-> ${name(edge.targetId)}`);
  return [...new Set(edges)].sort();
}

/** Whether the call graph index holds Card.tsx#Card, for failure messages. */
async function indexedCard(): Promise<string> {
  const result = await vscode.lm.invokeTool('graph-it-live_query_call_graph', {
    input: { filePath: getProjectFile(PROJECT, 'ui', 'Card.tsx').fsPath, symbolName: 'Card', direction: 'callers', depth: 1 },
    toolInvocationToken: undefined,
  });
  const part = result.content.find(p => p instanceof vscode.LanguageModelTextPart);
  const answer = part instanceof vscode.LanguageModelTextPart ? JSON.parse(part.value) as { symbol: unknown; reason?: string; callers?: unknown[] } : null;
  return answer?.symbol ? `yes, ${answer.callers?.length ?? 0} callers` : `no (${answer?.reason ?? 'no answer'})`;
}

/** Wait until the displayed root edges equal `expected`; a save refresh is debounced and re-extracts importers. */
async function waitForRootEdges(expected: string[], timeoutMs = 20000, deadline = Date.now() + timeoutMs): Promise<void> {
  const graph = await shownGraph();
  const actual = rootEdges(graph);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  if (Date.now() >= deadline) {
    const shown = graph ? `root ${graph.rootSymbolId}, nodes ${graph.nodes.map(node => node.name).join(', ')}` : 'no graph';
    assert.deepStrictEqual(actual, expected, `Displayed call graph edges did not refresh (${shown}; Card in the index: ${await indexedCard()})`);
  }
  await sleep(250);
  return waitForRootEdges(expected, timeoutMs, deadline);
}

/**
 * Open Page.tsx with the cursor on `Page` and show its call graph until it draws `expected`: the create events
 * of the setup files reach the call graph after a debounce, and a show() before them draws Page alone.
 */
async function showPageGraph(expected: string[], deadline = Date.now() + 30000): Promise<void> {
  const document = await vscode.workspace.openTextDocument(getProjectFile(PROJECT, 'Page.tsx'));
  const position = new vscode.Position(3, 16);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
  await showCallGraphAndWait(60000, 200);
  if (JSON.stringify(rootEdges(await shownGraph())) === JSON.stringify(expected) || Date.now() >= deadline) {
    return waitForRootEdges(expected, 0);
  }
  await sleep(500);
  return showPageGraph(expected, deadline);
}

/** Replace the whole text of a file through its document and save it, as a user would. */
async function saveText(file: vscode.Uri, text: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(file);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit), `Could not edit ${file.fsPath}`);
  assert.ok(await document.save(), `Could not save ${file.fsPath}`);
}

suite('React components in the call graph view', () => {
  const card = () => getProjectFile(PROJECT, 'ui', 'Card.tsx');
  const page = () => getProjectFile(PROJECT, 'Page.tsx');

  suiteSetup(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    assert.ok(ext, 'Extension should exist');
    if (!ext.isActive) await ext.activate();
    await vscode.commands.executeCommand('graph-it-live.graphView.focus');
  });

  setup(async function () {
    this.timeout(30000);
    await vscode.workspace.fs.writeFile(card(), Buffer.from(CARD));
    await vscode.workspace.fs.writeFile(getProjectFile(PROJECT, 'ui', 'index.ts'), Buffer.from("export * from './Card';\n"));
    await vscode.workspace.fs.writeFile(page(), Buffer.from(PAGE));
    await sleep(1500); // let the create events reach the index
  });

  teardown(async function () {
    this.timeout(30000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // The call graph replaced the shared view's file graph: restore it for the next suite.
    await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    await vscode.workspace.fs.delete(getProjectFile(PROJECT), { recursive: true }).then(undefined, () => undefined);
    await sleep(1500); // let the delete events reach the index before the next suite
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
