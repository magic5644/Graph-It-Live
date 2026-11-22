import * as assert from 'node:assert';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type ViewMode = 'file' | 'list' | 'symbol' | 'architecture';

export function getProjectFile(projectName: string, ...pathSegments: string[]): vscode.Uri {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error('No workspace folders found');
  }
  return vscode.Uri.joinPath(workspaceFolders[0].uri, projectName, ...pathSegments);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `action`, wait until VS Code reports a file event for each of `files`, then until the extension has processed
 * its queued file events. The extension's watcher shares this event stream. A watcher may drop an event: past
 * `timeoutMs` the wait goes on to the idle signal, since the extension recovers a lost event (#600).
 */
export async function settleFileEvents(files: vscode.Uri[], action: () => Thenable<unknown>, timeoutMs = 10000): Promise<void> {
  const pending = new Set(files.map(file => file.fsPath));
  let seen!: () => void;
  const allSeen = new Promise<void>(resolve => { seen = resolve; });
  // path.relative ignores the drive letter case Windows may report differently.
  const observe = (uri: vscode.Uri) => {
    for (const file of pending) if (path.relative(file, uri.fsPath) === '') pending.delete(file);
    if (pending.size === 0) seen();
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate(observe);
  watcher.onDidChange(observe);
  watcher.onDidDelete(observe);
  let timer: NodeJS.Timeout | undefined;
  try {
    await action();
    const timedOut = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
    if (pending.size > 0) await Promise.race([allSeen, timedOut]);
    if (pending.size > 0) console.warn(`No file event within ${timeoutMs} ms for ${[...pending].join(', ')}`);
  } finally {
    clearTimeout(timer);
    watcher.dispose();
  }
  await vscode.commands.executeCommand('graph-it-live.e2eFileUpdatesIdle');
}

/** Poll `condition` until it holds; fails with `what` past the deadline. */
export async function waitUntil(condition: () => Promise<boolean>, what: string, timeoutMs = 30_000, deadline = Date.now() + timeoutMs): Promise<void> {
  if (await condition()) return;
  if (Date.now() >= deadline) assert.fail(`Timed out after ${timeoutMs} ms waiting for ${what}`);
  await sleep(200);
  return waitUntil(condition, what, timeoutMs, deadline);
}

export async function getContextKey<T = unknown>(key: string): Promise<T | undefined> {
  return vscode.commands.executeCommand<T | undefined>('getContext', key);
}

export async function waitForViewMode(
  expected: ViewMode,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<ViewMode> {
  const timeoutMs = options?.timeoutMs ?? 8000;
  const intervalMs = options?.intervalMs ?? 100;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const current = await getContextKey<ViewMode>('graph-it-live.viewMode');
    if (current === expected) {
      return current;
    }
    await sleep(intervalMs);
  }

  const last = await getContextKey<ViewMode>('graph-it-live.viewMode');
  assert.strictEqual(
    last,
    expected,
    `Timed out waiting for viewMode=${expected}. Last value was ${String(last)}`
  );
  return expected;
}

export async function openGraphFor(
  projectName: string,
  ...pathSegments: string[]
): Promise<vscode.TextDocument> {
  const file = getProjectFile(projectName, ...pathSegments);
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc);

  await vscode.commands.executeCommand('graph-it-live.showGraph', file.fsPath);
  // `showGraph` only focuses the view: VS Code resolves the webview later, and until then the
  // view-mode commands return without switching (`viewMode` may already read `file`).
  await waitForGraphViewResolved();
  await waitForViewMode('file');

  return doc;
}

/** Wait until the sidebar webview is resolved, so view-mode commands take effect. */
export async function waitForGraphViewResolved(timeoutMs = 10000, deadline = Date.now() + timeoutMs): Promise<void> {
  if (await getContextKey<boolean>('graph-it-live.graphViewResolved')) return;
  if (Date.now() >= deadline) assert.fail(`Timed out after ${timeoutMs} ms waiting for the Graph-It-Live view to resolve`);
  await sleep(100);
  return waitForGraphViewResolved(timeoutMs, deadline);
}

/**
 * Open a file, execute `graph-it-live.showCallGraph`, and wait until
 * the webview posts `callGraphReady` (detected via the
 * `graph-it-live.callGraphRenderCount` context key incrementing).
 *
 * Focuses the sidebar view first to guarantee `resolveWebviewView` has been
 * called (i.e. `sidebarWebview` is non-null in CallGraphViewService) before
 * `showCallGraph` posts any graph data. Without this, the first call in a
 * fresh test run would silently drop all postMessage calls and time out.
 */
export async function openCallGraphFor(
  projectName: string,
  ...pathSegments: string[]
): Promise<vscode.TextDocument> {
  // Reveal the sidebar so the WebviewViewProvider resolves and CallGraphViewService
  // receives a valid sidebarWebview reference before any postMessage calls.
  await vscode.commands.executeCommand('graph-it-live.graphView.focus');
  await sleep(800); // allow resolveWebviewView + React mount to complete

  const file = getProjectFile(projectName, ...pathSegments);
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc);

  await showCallGraphAndWait(45000, 200);
  return doc;
}

/**
 * Execute `graph-it-live.showCallGraph` for the active editor and wait until the
 * webview posts `callGraphReady` (`graph-it-live.callGraphRenderCount` increments).
 */
export async function showCallGraphAndWait(timeoutMs: number, intervalMs: number): Promise<void> {
  const prevCount = (await getContextKey<number>('graph-it-live.callGraphRenderCount')) ?? 0;
  await vscode.commands.executeCommand('graph-it-live.showCallGraph');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await getContextKey<number>('graph-it-live.callGraphRenderCount');
    if ((current ?? 0) > prevCount) return;
    await sleep(intervalMs);
  }
  const file = vscode.window.activeTextEditor?.document.uri.fsPath;
  throw new Error(`Timed out after ${timeoutMs} ms waiting for callGraphReady for ${file}`);
}

export const lmToolsSupported = (): boolean =>
  typeof vscode.lm === 'object' && vscode.lm !== null && typeof vscode.lm.invokeTool === 'function';

/** Invoke the get_index_status LM tool and parse its JSON payload. */
export async function getIndexStatus<T>(): Promise<T> {
  const result = await vscode.lm.invokeTool('graph-it-live_get_index_status', {
    input: { response_format: 'json' },
    toolInvocationToken: undefined,
  });
  const text = result.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
    .join('');
  return JSON.parse(text) as T;
}

/** The call graph the view displays, as the `graph-it-live.callGraph` context key exposes it. */
export interface ShownCallGraph {
  rootSymbolId: string;
  nodes: Array<{ id: string; name: string; path: string; startLine: number; startCol: number; framework?: string }>;
  edges: Array<{ sourceId: string; targetId: string; typeRelation: string; sourceLine: number }>;
}

export const shownCallGraph = async (): Promise<ShownCallGraph | null> =>
  (await getContextKey<ShownCallGraph | null>('graph-it-live.callGraph')) ?? null;

/** `Source -RELATION@line-> Target` edges leaving the graph root, with 1-based lines, deduplicated. */
export function rootCallGraphEdges(graph: ShownCallGraph | null): string[] {
  if (!graph) return [];
  const name = (id: string) => graph.nodes.find(node => node.id === id)?.name ?? id;
  const edges = graph.edges
    .filter(edge => edge.sourceId === graph.rootSymbolId)
    .map(edge => `${name(edge.sourceId)} -${edge.typeRelation}@${edge.sourceLine + 1}-> ${name(edge.targetId)}`);
  // Code-unit order, as the expected arrays are written.
  return [...new Set(edges)].sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/**
 * Wait until the displayed root edges equal `expected`: a save refresh is debounced and re-extracts importers.
 * `detail` adds index state to the failure message.
 */
export async function waitForRootCallGraphEdges(
  expected: string[],
  { timeoutMs = 20000, detail }: { timeoutMs?: number; detail?: () => Promise<string> } = {},
  deadline = Date.now() + timeoutMs,
): Promise<void> {
  const graph = await shownCallGraph();
  const actual = rootCallGraphEdges(graph);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  if (Date.now() >= deadline) {
    const shown = graph ? `root ${graph.rootSymbolId}, nodes ${graph.nodes.map(node => node.name).join(', ')}` : 'no graph';
    const extra = detail ? `; ${await detail()}` : '';
    assert.deepStrictEqual(actual, expected, `Displayed call graph edges did not refresh (${shown}${extra})`);
  }
  await sleep(250);
  return waitForRootCallGraphEdges(expected, { timeoutMs, detail }, deadline);
}

/** Replace the whole text of a file through its document and save it, as a user would. */
export async function saveDocumentText(file: vscode.Uri, text: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(file);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(file, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit), `Could not edit ${file.fsPath}`);
  assert.ok(await document.save(), `Could not save ${file.fsPath}`);
}

/** What the extension showed through `vscode.window` while captured: toasts and quick picks. */
export interface WindowCapture {
  messages: string[];
  picks: { labels: string[]; placeHolder?: string }[];
  /** Label the next quick pick answers; undefined presses Escape. */
  answer: string | undefined;
  restore(): void;
}

/**
 * Records the extension's toasts and answers its quick picks (E2E cannot read or click either); `restore()` puts them back.
 * VS Code gives each extension its own `vscode` object, picked by the requiring file's folder: required from the
 * extension's folder, it is the extension's one, also when the tests run from the test host against the installed VSIX.
 */
export function captureWindow(): WindowCapture {
  const extension = vscode.extensions.getExtension('magic5644.graph-it-live');
  assert.ok(extension, 'the extension under test');
  const api = createRequire(path.join(extension.extensionPath, 'package.json'))('vscode') as typeof vscode;
  const window = api.window as unknown as Record<string, unknown>;
  const names = ['showInformationMessage', 'showWarningMessage', 'showErrorMessage', 'showQuickPick'];
  const saved = Object.fromEntries(names.map(name => [name, window[name]]));
  const labelOf = (item: string | vscode.QuickPickItem) => (typeof item === 'string' ? item : item.label);
  const capture: WindowCapture = { messages: [], picks: [], answer: undefined, restore: () => Object.assign(window, saved) };
  const record = (message: string) => {
    capture.messages.push(message);
    return Promise.resolve(undefined);
  };
  Object.assign(window, {
    showInformationMessage: record,
    showWarningMessage: record,
    showErrorMessage: record,
    showQuickPick: async (items: readonly (string | vscode.QuickPickItem)[] | Thenable<readonly (string | vscode.QuickPickItem)[]>, options?: vscode.QuickPickOptions) => {
      const list = await items;
      capture.picks.push({ labels: list.map(labelOf), placeHolder: options?.placeHolder });
      return list.find(item => labelOf(item) === capture.answer);
    },
  });
  assert.strictEqual(api.window.showQuickPick, window.showQuickPick, 'vscode.window could not be captured');
  return capture;
}

/** What the Architecture mode shows, as the webview reports it (`diagramShown`). */
export interface DiagramShown {
  tabs: { tab: string; selected: boolean; disabled?: string }[];
  crumbs: string[];
  banner?: string;
  focused?: string;
  flowRequestId?: number;
  flowButtons: string[];
  flowLine?: string;
  flowBusy: boolean;
}

/** getContext `graph-it-live.flowDiagram`: FlowDiagramService.getE2EState(). */
export interface FlowE2EState {
  requestId: number;
  entry?: string;
  nodes: string[];
  edges: string[];
  stale: boolean;
  follow: boolean;
  state?: string;
  lastError?: string;
  lastOpened?: { file: string; line: number };
  svgDigest?: string;
  view?: DiagramShown;
}

export const flowState = async (): Promise<FlowE2EState> =>
  (await getContextKey<FlowE2EState>('graph-it-live.flowDiagram')) ?? { requestId: 0, nodes: [], edges: [], stale: false, follow: false };
export const selectedTab = (state: FlowE2EState) => state.view?.tabs.find(tab => tab.selected)?.tab;
export const controls = (value: Record<string, unknown>) => vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', value);

export async function waitForFlow(what: string, accept: (state: FlowE2EState) => boolean, timeoutMs = 120_000): Promise<FlowE2EState> {
  let last = await flowState();
  await waitUntil(async () => {
    last = await flowState();
    return accept(last);
  }, `${what} (last: ${JSON.stringify({ ...last, nodes: last.nodes.length })})`, timeoutMs);
  return last;
}

/** `file:line` of a step or call accessible name (`…, <file>:<line>, <lane> lane`). */
export function locationOf(name: string): { file: string; line: number } {
  const match = /(?:, | at )([^,]+):(\d+), \w+ lane$/.exec(name);
  assert.ok(match, `no file:line in "${name}"`);
  return { file: match[1], line: Number(match[2]) };
}

