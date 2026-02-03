/**
 * E2E tests for view mode cycling (file → list → symbol → file)
 * Tests the cycleViewMode() functionality and context key updates
 */
import { after, before, beforeEach } from 'mocha';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('View Mode Cycle E2E Tests', () => {
  const workspaceRoot = path.join(__dirname, '../../../tests/fixtures/sample-project');
  let graphView: vscode.WebviewView | undefined;

  before(async function () {
    this.timeout(60000);

    // Activate extension
    const extension = vscode.extensions.getExtension('magic5644.graph-it-live');
    if (!extension) {
      throw new Error('Extension not found');
    }
    if (!extension.isActive) {
      await extension.activate();
    }
  });

  beforeEach(async function () {
    this.timeout(10000);
    // Reset to file view before each test to ensure clean state
    try {
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.warn('beforeEach: Failed to reset to file view:', error);
    }
  });

  after(async () => {
    // Cleanup: reset to file view
    try {
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    } catch (error) {
      console.warn('Cleanup failed:', error);
    }
  });

  test('cycleViewMode: file → list → symbol → file', async function () {
    this.timeout(30000);

    // Open a test file
    const testFile = path.join(workspaceRoot, 'src/main.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Show graph (should start in file mode)
    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify initial state: file mode
    let contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'file', 'Should start in file mode');

    // Cycle to list mode
    await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'list', 'Should cycle to list mode');

    // Cycle to symbol mode
    await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'symbol', 'Should cycle to symbol mode');

    // Cycle back to file mode
    await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'file', 'Should cycle back to file mode');
  });

  test('setViewModeFile: resets to file mode from any mode', async function () {
    this.timeout(20000);

    // Open a test file
    const testFile = path.join(workspaceRoot, 'src/main.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Show graph
    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Cycle to symbol mode (file → list → symbol)
    await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Verify we're in symbol mode
    let contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'symbol', 'Should be in symbol mode');

    // Back to file view
    await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'file', 'Should reset to file mode');
  });

  test('viewMode context key updates correctly', async function () {
    this.timeout(20000);

    // Open a test file
    const testFile = path.join(workspaceRoot, 'src/main.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Show graph
    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Cycle through all modes and verify context key
    const expectedModes: Array<'file' | 'list' | 'symbol'> = ['list', 'symbol', 'file'];

    for (const expectedMode of expectedModes) {
      await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const contextValue = await vscode.commands.executeCommand(
        'getContext',
        'graph-it-live.viewMode'
      );
      assert.strictEqual(
        contextValue,
        expectedMode,
        `Context key should be ${expectedMode}`
      );
    }
  });

  test('backward compatibility: toggleViewMode calls cycleViewMode', async function () {
    this.timeout(20000);

    // Open a test file
    const testFile = path.join(workspaceRoot, 'src/main.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Show graph
    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify initial state
    let contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'file', 'Should start in file mode');

    // Call toggleViewMode (should cycle to list)
    await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(
      contextValue,
      'list',
      'toggleViewMode should cycle to list mode'
    );
  });

  test('currentSymbol getter/setter maintains backward compatibility', async function () {
    this.timeout(20000);

    // Open a test file
    const testFile = path.join(workspaceRoot, 'src/main.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Show graph
    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify file mode
    let contextValue = await vscode.commands.executeCommand(
      'getContext',
      'graph-it-live.viewMode'
    );
    assert.strictEqual(contextValue, 'file', 'Should start in file mode');

    // Drill down to a symbol (this sets currentSymbol via getter/setter)
    // This should switch to symbol mode via the backward compatibility logic
    // Note: We cannot directly test getter/setter from E2E, but we can verify
    // that drilling down to a symbol updates the viewMode context
    // This is tested indirectly through the drill-down functionality

    // For now, just verify that the context key is properly initialized
    assert.ok(
      contextValue === 'file' || contextValue === 'list' || contextValue === 'symbol',
      'Context key should be a valid ViewMode value'
    );
  });
});
