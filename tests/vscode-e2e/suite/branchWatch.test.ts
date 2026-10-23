import * as assert from 'node:assert';
import * as vscode from 'vscode';

interface BranchWatchSnapshot {
  state: { phase: string; reason?: string };
  items: Array<{ label: string }>;
  enabled: boolean;
  available: boolean;
  status: { text: string; visible: boolean };
}

suite('Branch Watch', () => {
  // Opt-in: until it is needed, its view leaves the panel width to the Dependency Graph (#423).
  test('contributes its view collapsed', () => {
    const views = vscode.extensions.getExtension('magic5644.graph-it-live')?.packageJSON.contributes.views as Record<string, Array<{ id: string; visibility?: string }>>;
    const view = views['graph-it-live-explorer'].find((entry) => entry.id === 'graph-it-live.branchWatchView');
    assert.strictEqual(view?.visibility, 'collapsed');
  });

  test('is opt-in, contributes the native commands, and does not open a panel automatically', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'graph-it-live.branchWatch.enable', 'graph-it-live.branchWatch.disable',
      'graph-it-live.branchWatch.pause', 'graph-it-live.branchWatch.resume',
      'graph-it-live.branchWatch.refresh', 'graph-it-live.branchWatch.selectBase',
      'graph-it-live.branchWatch.reveal', 'graph-it-live.branchWatch.openFile',
      'graph-it-live.branchWatch.copyMessage', 'graph-it-live.branchWatch.copyStatus',
    ]) assert.ok(commands.includes(command), `Missing ${command}`);
    if (process.env.E2E_EXPECTED_VSIX_EXTENSION_DIR) {
      assert.ok(!commands.includes('graph-it-live.branchWatch.testSnapshot'), 'Test-only command must not ship in the VSIX');
      return;
    }
    const snapshot = await vscode.commands.executeCommand<BranchWatchSnapshot>('graph-it-live.branchWatch.testSnapshot');
    assert.ok(snapshot, 'Extension test snapshot must be available');
    assert.strictEqual(snapshot?.enabled, false, 'Branch watch is disabled by default');
    assert.strictEqual(snapshot?.status.visible, false, 'Disabled branch watch has no status bar item');
    assert.strictEqual(snapshot?.state.phase, 'disabled');
  });

  test('keeps the normal graph command available when branch watch is unavailable', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('graph-it-live.showGraph'));
    if (!process.env.E2E_EXPECTED_VSIX_EXTENSION_DIR) {
      const snapshot = await vscode.commands.executeCommand<BranchWatchSnapshot>('graph-it-live.branchWatch.testSnapshot');
      assert.ok(snapshot?.items.every(item => !/Tests passed|ready to ship/i.test(item.label)));
    }
  });

  test('exposes a workspace-scoped configurable file limit', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'A workspace folder is required');
    const configuration = vscode.workspace.getConfiguration('graph-it-live', folder.uri);
    const inspected = configuration.inspect<number>('branchWatch.maxFiles');
    assert.strictEqual(inspected?.defaultValue, 200);
    try {
      await configuration.update('branchWatch.maxFiles', 25, vscode.ConfigurationTarget.WorkspaceFolder);
      assert.strictEqual(vscode.workspace.getConfiguration('graph-it-live', folder.uri).get<number>('branchWatch.maxFiles'), 25);
    } finally {
      await configuration.update('branchWatch.maxFiles', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });
});
