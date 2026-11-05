import { fixtureInTheme, THEMES } from './_webviewFixture';

suite('React identity in real VS Code webviews', () => {
  for (const theme of THEMES) {
    test(`preserves identity, fallback, Vue and state highlights (${theme[1]})`, fixtureInTheme(theme, {
      fixture: 'reactIdentity.fixture.tsx', title: 'React identity · files, symbols and calls', screenshot: 'react-identity',
      style: 'body { margin: 8px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); } h2 { margin: 0; height: 32px; font-size: 14px; } section { border: 1px solid var(--vscode-panel-border); overflow: hidden; } #files > div > div, #symbols > div > div { height: 100% !important; } button { font: inherit; }',
    }));
  }
});
