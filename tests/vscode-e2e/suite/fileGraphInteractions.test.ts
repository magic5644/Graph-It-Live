import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import * as vscode from 'vscode';

suite('File graph interactions in a real webview', () => {
  for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
    test(`filters, clears focus, supports keyboard and preserves viewport (${theme})`, async function () {
      this.timeout(60000);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-webview-'));
      const config = vscode.workspace.getConfiguration('workbench');
      const previousTheme = config.inspect<string>('colorTheme')?.globalValue;
      const panel = vscode.window.createWebviewPanel('fileGraphTest', 'File graph interaction test', vscode.ViewColumn.One, {
        enableScripts: true, localResourceRoots: [vscode.Uri.file(directory)],
      });
      try {
        await config.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
        const bundle = path.join(directory, 'test.js');
        await build({
          entryPoints: [path.resolve(__dirname, '../fixtures/fileGraphInteractions.tsx')], outfile: bundle,
          bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'text' },
          define: { 'process.env.NODE_ENV': '"production"' },
        });
        const result = new Promise<{ ok: boolean; error?: string; filterMs?: number }>((resolve, reject) => {
          const timer = setTimeout(() => { listener.dispose(); reject(new Error('Webview test timed out')); }, 45000);
          const listener = panel.webview.onDidReceiveMessage(message => { clearTimeout(timer); listener.dispose(); resolve(message); });
        });
        const script = panel.webview.asWebviewUri(vscode.Uri.file(bundle));
        panel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}; style-src 'unsafe-inline';"><style>body { margin: 0; }</style></head><body><div id="root"></div><script src="${script}"></script></body></html>`;
        const report = await result;
        assert.strictEqual(report.ok, true, report.error);
        console.log(`${theme}: filter 400 nodes / 1500 edges in ${report.filterMs?.toFixed(0)} ms`);
      } finally {
        panel.dispose();
        await config.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
