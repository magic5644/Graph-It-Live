import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import * as vscode from 'vscode';

interface WebviewReport { ok: boolean; error?: string; theme?: string }

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
    const file = path.join(output, `react-identity-${name}.png`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log(`React identity screenshot: ${file}`);
  } finally {
    socket.close();
  }
}

suite('React identity in real VS Code webviews', () => {
  for (const [theme, name, bodyClass] of [
    ['Default Light Modern', 'light', 'vscode-light'],
    ['Default Dark Modern', 'dark', 'vscode-dark'],
    ['Default High Contrast', 'high-contrast', 'vscode-high-contrast'],
  ]) {
    test(`preserves identity, fallback, Vue and state highlights (${name})`, async function () {
      this.timeout(60000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // Local screenshots only: suites share one workbench, and a hidden sidebar breaks later layout tests.
      if (process.env.E2E_SCREENSHOT_DIR) {
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      }
      await vscode.commands.executeCommand('notifications.clearAll');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-react-identity-'));
      const config = vscode.workspace.getConfiguration('workbench');
      const previousTheme = config.inspect<string>('colorTheme')?.globalValue;
      const panel = vscode.window.createWebviewPanel('reactIdentityTest', 'React identity · files, symbols and calls', vscode.ViewColumn.One, {
        enableScripts: true, localResourceRoots: [vscode.Uri.file(directory)],
      });
      try {
        await config.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
        const bundle = path.join(directory, 'test.js');
        await build({
          entryPoints: [path.resolve(__dirname, '../fixtures/reactIdentity.fixture.tsx')], outfile: bundle,
          bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'text' },
          define: { 'process.env.NODE_ENV': '"production"' },
        });
        const result = new Promise<WebviewReport>((resolve, reject) => {
          const timer = setTimeout(() => { listener.dispose(); reject(new Error('React identity webview timed out')); }, 45000);
          const listener = panel.webview.onDidReceiveMessage((message: WebviewReport) => { clearTimeout(timer); listener.dispose(); resolve(message); });
        });
        const script = panel.webview.asWebviewUri(vscode.Uri.file(bundle));
        panel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}; style-src 'unsafe-inline'; img-src data:;"><style>body { margin: 8px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); } h2 { margin: 0; height: 32px; font-size: 14px; } section { border: 1px solid var(--vscode-panel-border); overflow: hidden; } #files > div > div, #symbols > div > div { height: 100% !important; } button { font: inherit; }</style></head><body><div id="root"></div><script src="${script}"></script></body></html>`;
        const report = await result;
        assert.strictEqual(report.ok, true, report.error);
        assert.ok(report.theme?.split(' ').includes(bodyClass), `Expected ${bodyClass}, got ${report.theme}`);
        await vscode.commands.executeCommand('notifications.clearAll');
        await screenshot(name);
      } finally {
        panel.dispose();
        await config.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
