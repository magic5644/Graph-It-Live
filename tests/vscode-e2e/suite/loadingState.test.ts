import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { runWebviewFixture, screenshot, THEMES } from './_webviewFixture';

/** #611: the four index-loading states share the logo, the message and the progress rendering. */
suite('Loading state in real VS Code webviews', () => {
  for (const [theme, name, bodyClass] of THEMES) {
    test(`shows the logo, message and progress in every view, with unique SVG ids (${name})`, async function () {
      this.timeout(60000);
      // Local screenshots only: suites share one workbench, and a hidden sidebar breaks later layout tests.
      if (process.env.E2E_SCREENSHOT_DIR) {
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      }
      await vscode.commands.executeCommand('notifications.clearAll');
      await runWebviewFixture(
        {
          fixture: 'loadingState.fixture.tsx', title: 'Loading state · every view', theme,
          style: 'body { margin: 8px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); } h2 { margin: 0; height: 28px; font-size: 13px; } section { border: 1px solid var(--vscode-panel-border); overflow: hidden; } .view { position: relative; height: 220px; } .view > div { height: 100% !important; }',
        },
        async (report) => {
          assert.ok(report.theme?.split(' ').includes(bodyClass), `Expected ${bodyClass}, got ${report.theme}`);
          await vscode.commands.executeCommand('notifications.clearAll');
          await screenshot(`loading-state-${name}`);
        },
      );
    });
  }
});
