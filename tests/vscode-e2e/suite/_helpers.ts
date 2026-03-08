import * as assert from 'node:assert';
import * as vscode from 'vscode';

export type ViewMode = 'file' | 'list' | 'symbol';

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
  await waitForViewMode('file');

  return doc;
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

  const prevCount = (await getContextKey<number>('graph-it-live.callGraphRenderCount')) ?? 0;
  await vscode.commands.executeCommand('graph-it-live.showCallGraph');

  // Poll until callGraphRenderCount increments (callGraphReady received by service)
  const timeoutMs = 45000;
  const intervalMs = 200;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await getContextKey<number>('graph-it-live.callGraphRenderCount');
    if ((current ?? 0) > prevCount) return doc;
    await sleep(intervalMs);
  }
  throw new Error(
    `openCallGraphFor: timed out waiting for callGraphReady for ${pathSegments.join('/')}`,
  );
}
