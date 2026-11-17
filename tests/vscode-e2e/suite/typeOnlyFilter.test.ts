import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getContextKey, openGraphFor } from './_helpers';

type TypeOnlyState = { hide: boolean; edges: string[] };

/** #745: `ignoreTypeImports` filters the file graph live; the index keeps the type-only imports. */
suite('Type-only import filter', () => {
  const config = () => vscode.workspace.getConfiguration('graph-it-live');

  async function waitForState(check: (state: TypeOnlyState) => boolean, message: string, deadline = Date.now() + 15000): Promise<TypeOnlyState> {
    const state = await getContextKey<TypeOnlyState>('graph-it-live.fileGraphTypeOnly');
    if (state && check(state)) return state;
    if (Date.now() > deadline) assert.fail(`${message}: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return waitForState(check, message, deadline);
  }

  test('keeps the type-only edge in the graph and toggles the filter without a restart', async function () {
    this.timeout(60000);
    const previous = config().inspect<boolean>('ignoreTypeImports')?.globalValue;
    try {
      await config().update('ignoreTypeImports', false, vscode.ConfigurationTarget.Global);
      await openGraphFor('trace-resolved', 'entry.ts');
      const isTypeEdge = (edge: string) => edge.includes('entry.ts->') && edge.endsWith('types.ts');
      const shown = await waitForState((state) => state.edges.some(isTypeEdge), 'The type-only import was not flagged');
      assert.strictEqual(shown.hide, false);

      await config().update('ignoreTypeImports', true, vscode.ConfigurationTarget.Global);
      const hidden = await waitForState((state) => state.hide, 'The filter did not apply live');
      assert.ok(hidden.edges.some(isTypeEdge), 'The graph data lost the type-only edge instead of filtering it in the view');
    } finally {
      await config().update('ignoreTypeImports', previous, vscode.ConfigurationTarget.Global);
    }
  });
});
