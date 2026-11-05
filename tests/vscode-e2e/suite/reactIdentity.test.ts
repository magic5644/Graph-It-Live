import * as assert from 'node:assert';
import { runWebviewFixture, THEMES } from './_webviewFixture';

suite('React identity in real VS Code webviews', () => {
  for (const [theme, name, bodyClass] of THEMES) {
    test(`preserves identity, fallback, Vue and state highlights (${name})`, async function () {
      this.timeout(60000);
      await runWebviewFixture(
        {
          fixture: 'reactIdentity.fixture.tsx', title: 'React identity · files, symbols and calls', theme, screenshot: `react-identity-${name}`,
          style: 'body { margin: 8px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); } h2 { margin: 0; height: 32px; font-size: 14px; } section { border: 1px solid var(--vscode-panel-border); overflow: hidden; } #files > div > div, #symbols > div > div { height: 100% !important; } button { font: inherit; }',
        },
        async (report) => {
          assert.ok(report.theme?.split(' ').includes(bodyClass), `Expected ${bodyClass}, got ${report.theme}`);
        },
      );
    });
  }
});
