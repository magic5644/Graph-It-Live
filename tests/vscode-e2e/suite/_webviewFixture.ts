import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import * as vscode from 'vscode';

export interface FixtureReport { ok: boolean; error?: string; theme?: string }

/** The three theme kinds a webview must stay readable in: [theme, short name, body class]. */
export const THEMES = [
  ['Default Light Modern', 'light', 'vscode-light'],
  ['Default Dark Modern', 'dark', 'vscode-dark'],
  ['Default High Contrast', 'high-contrast', 'vscode-high-contrast'],
] as const;

/** Optional local screenshots from the actual Electron workbench, via its loopback debugging port. */
async function screenshot(name: string): Promise<void> {
  const output = process.env.E2E_SCREENSHOT_DIR;
  if (!output) return;
  const port = process.env.E2E_CDP_PORT;
  assert.match(port ?? '', /^\d+$/, 'Screenshots require E2E_CDP_PORT');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const target = targets.find(item => item.type === 'page' && item.url.includes('workbench'));
  assert.ok(target, 'Electron workbench debugging target missing');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Electron screenshot timed out')), 15000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })));
      socket.addEventListener('error', event => { clearTimeout(timeout); reject(new Error(`Screenshot socket failed: ${event.type}`)); });
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: { data: string }; error?: { message: string } };
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.result) resolve(message.result.data);
        else reject(new Error(message.error?.message ?? 'Screenshot data missing'));
      });
    });
    await fs.mkdir(output, { recursive: true });
    const file = path.join(output, `${name}.png`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log(`Screenshot: ${file}`);
  } finally {
    socket.close();
  }
}

/**
 * Bundles a fixture from `tests/vscode-e2e/fixtures/`, runs it in a real webview panel under `theme`, and hands
 * its single report to `inspect` while the panel is still shown. With `screenshot` and `E2E_SCREENSHOT_DIR` set,
 * captures the workbench after `inspect`. Restores the theme and closes the panel after: suites share one
 * workbench, so the layout stays as found (hidden side bars broke later layout tests).
 */
export async function runWebviewFixture<T extends FixtureReport>(
  options: { fixture: string; title: string; theme: string; style: string; screenshot?: string },
  inspect: (report: T) => void | Promise<void> = () => {},
): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const shot = process.env.E2E_SCREENSHOT_DIR ? options.screenshot : undefined;
  await vscode.commands.executeCommand('notifications.clearAll');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-webview-'));
  const config = vscode.workspace.getConfiguration('workbench');
  const previousTheme = config.inspect<string>('colorTheme')?.globalValue;
  const panel = vscode.window.createWebviewPanel('graphItFixture', options.title, vscode.ViewColumn.One, {
    enableScripts: true, localResourceRoots: [vscode.Uri.file(directory)],
  });
  try {
    await config.update('colorTheme', options.theme, vscode.ConfigurationTarget.Global);
    const bundle = path.join(directory, 'test.js');
    await build({
      entryPoints: [path.resolve(__dirname, '../fixtures', options.fixture)], outfile: bundle,
      bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'text' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { listener.dispose(); reject(new Error(`${options.title}: webview timed out`)); }, 45000);
      const listener = panel.webview.onDidReceiveMessage((message: T) => { clearTimeout(timer); listener.dispose(); resolve(message); });
    });
    const script = panel.webview.asWebviewUri(vscode.Uri.file(bundle));
    panel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}; style-src 'unsafe-inline'; img-src data:; worker-src blob:;"><style>${options.style}</style></head><body><div id="root"></div><script src="${script}"></script></body></html>`;
    const report = await result;
    assert.strictEqual(report.ok, true, report.error);
    await inspect(report);
    if (shot !== undefined) {
      await vscode.commands.executeCommand('notifications.clearAll');
      await screenshot(shot);
    }
  } finally {
    panel.dispose();
    await config.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * A test body for one theme kind: runs the fixture under it, checks the webview got that theme's body class, and
 * names its local screenshot `<screenshot>-<theme>`.
 */
export function fixtureInTheme(
  [theme, name, bodyClass]: (typeof THEMES)[number],
  options: { fixture: string; title: string; style: string; screenshot: string },
): Mocha.AsyncFunc {
  return async function () {
    this.timeout(60000);
    await runWebviewFixture({ ...options, theme, screenshot: `${options.screenshot}-${name}` }, (report) => {
      assert.ok(report.theme?.split(' ').includes(bodyClass), `Expected ${bodyClass}, got ${report.theme}`);
    });
  };
}
