import * as assert from 'node:assert';
import * as vscode from 'vscode';

describe('graph context LM tool', () => {
  it('is contributed and registered', function () {
    const tools = (vscode.lm as unknown as { tools?: ReadonlyArray<{ name: string }> }).tools;
    if (!tools) this.skip();
    assert.ok(tools?.some(tool => tool.name === 'graph-it-live_graph_context'));
  });
});
