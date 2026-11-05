import { type FixtureReport, runWebviewFixture } from './_webviewFixture';

suite('File graph interactions in a real webview', () => {
  for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
    test(`filters, clears focus, supports keyboard and preserves viewport (${theme})`, async function () {
      this.timeout(60000);
      await runWebviewFixture<FixtureReport & { filterMs?: number }>(
        { fixture: 'fileGraphInteractions.fixture.tsx', title: 'File graph interaction test', theme, style: 'body { margin: 0; }' },
        (report) => {
          console.log(`${theme}: filter 400 nodes / 1500 edges in ${report.filterMs?.toFixed(0)} ms`);
        },
      );
    });
  }
});
