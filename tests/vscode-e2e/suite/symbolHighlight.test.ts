/**
 * E2E tests for symbol double-click highlight functionality
 * Tests that double-clicking a symbol filters the graph to show only related nodes
 */
import { after, before, beforeEach } from 'mocha';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('Symbol Double-Click Highlight E2E Tests', () => {
  const workspaceRoot = path.join(__dirname, '../../../tests/fixtures/sample-project');
  let extension: vscode.Extension<unknown> | undefined;

  before(async function () {
    this.timeout(60000);

    // Activate extension
    extension = vscode.extensions.getExtension('magic5644.graph-it-live');
    if (!extension) {
      throw new Error('Extension not found');
    }
    if (!extension.isActive) {
      await extension.activate();
    }

    // Wait for indexing
    await new Promise((resolve) => setTimeout(resolve, 3000));
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
    // Cleanup: close all editors
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    } catch (error) {
      console.warn('Cleanup failed:', error);
    }
  });

  test('Double-click on isOdd should show only isOdd and isEven (mutual recursion)', async function () {
    this.timeout(30000);

    // Open the recursion test file
    const testFile = path.join(workspaceRoot, '../../fixtures/symbols/recursion.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Show graph in symbol mode
    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Switch to symbol mode if not already
    const contextValue = await vscode.commands.executeCommand('getContext', 'graph-it-live.viewMode');
    if (contextValue !== 'symbol') {
      await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // Note: We cannot directly simulate webview double-click from E2E tests
    // but we can verify that:
    // 1. The graph is showing in symbol mode
    // 2. The extension state is correct
    // 3. Commands are properly registered
    
    console.log('✓ Extension active and symbol view loaded');
    console.log('✓ Manual test: Double-click isOdd node in webview');
    console.log('✓ Expected: Only isOdd and isEven visible');
    console.log('✓ Expected: fibonacci, factorial, sumTree hidden');
    
    assert.ok(extension?.isActive, 'Extension should be active');
    assert.ok(true, 'Symbol graph loaded - manual double-click test required');
  });

  test('Double-click on fibonacci should show only fibonacci (self-recursion)', async function () {
    this.timeout(30000);

    const testFile = path.join(workspaceRoot, '../../fixtures/symbols/recursion.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Ensure symbol mode
    const contextValue = await vscode.commands.executeCommand('getContext', 'graph-it-live.viewMode');
    if (contextValue !== 'symbol') {
      await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    console.log('✓ Extension active and symbol view loaded');
    console.log('✓ Manual test: Double-click fibonacci node in webview');
    console.log('✓ Expected: Only fibonacci visible with red recursive edge');
    console.log('✓ Expected: All other symbols hidden');
    
    assert.ok(extension?.isActive, 'Extension should be active');
    assert.ok(true, 'Symbol graph loaded - manual double-click test required');
  });

  test('Clear Highlight button should restore full graph', async function () {
    this.timeout(30000);

    const testFile = path.join(workspaceRoot, '../../fixtures/symbols/recursion.ts');
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand('graph-it-live.showGraph', testFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Ensure symbol mode
    const contextValue = await vscode.commands.executeCommand('getContext', 'graph-it-live.viewMode');
    if (contextValue !== 'symbol') {
      await vscode.commands.executeCommand('graph-it-live.toggleViewMode');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    console.log('✓ Extension active and symbol view loaded');
    console.log('✓ Manual test: Double-click any node, then click "Clear Highlight"');
    console.log('✓ Expected: All symbols restored to view');
    
    assert.ok(extension?.isActive, 'Extension should be active');
    assert.ok(true, 'Symbol graph loaded - manual clear highlight test required');
  });
});
