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
  test('is opt-in, contributes the native commands, and does not open a panel automatically', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'graph-it-live.branchWatch.enable', 'graph-it-live.branchWatch.disable',
      'graph-it-live.branchWatch.pause', 'graph-it-live.branchWatch.resume',
      'graph-it-live.branchWatch.refresh', 'graph-it-live.branchWatch.selectBase',
      'graph-it-live.branchWatch.reveal', 'graph-it-live.branchWatch.openFile',
      'graph-it-live.branchWatch.copyMessage', 'graph-it-live.branchWatch.copyStatus',
    ]) assert.ok(commands.includes(command), `Missing ${command}`);
    const snapshot = await vscode.commands.executeCommand<BranchWatchSnapshot>('graph-it-live.branchWatch.testSnapshot');
    assert.ok(snapshot, 'Extension test snapshot must be available');
    assert.strictEqual(snapshot?.enabled, false, 'Branch watch is disabled by default');
    assert.strictEqual(snapshot?.status.visible, false, 'Disabled branch watch has no status bar item');
    assert.strictEqual(snapshot?.state.phase, 'disabled');
  });

  test('keeps the normal graph command available when branch watch is unavailable', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('graph-it-live.showGraph'));
    const snapshot = await vscode.commands.executeCommand<BranchWatchSnapshot>('graph-it-live.branchWatch.testSnapshot');
    assert.ok(snapshot?.items.every(item => !/Tests passed|ready to ship/i.test(item.label)));
  });
});
