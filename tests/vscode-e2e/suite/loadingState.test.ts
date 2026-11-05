import { testInEveryTheme } from './_webviewFixture';

/** #611: the four index-loading states share the logo, the message and the progress rendering. */
suite('Loading state in real VS Code webviews', () => {
  testInEveryTheme('shows the logo, message and progress in every view, with unique SVG ids', {
    fixture: 'loadingState.fixture.tsx', title: 'Loading state · every view', screenshot: 'loading-state',
    style: 'body { margin: 8px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); } h2 { margin: 0; height: 28px; font-size: 13px; } section { border: 1px solid var(--vscode-panel-border); overflow: hidden; } .view { position: relative; height: 220px; } .view > div { height: 100% !important; }',
  });
});
