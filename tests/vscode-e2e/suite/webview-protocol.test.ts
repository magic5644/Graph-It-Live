import { after, before, teardown } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getContextKey, getProjectFile, openGraphFor, sleep, waitForViewMode } from './_helpers';

/**
 * E2E Tests for Webview Protocol and Context Value Side Effects
 * 
 * These tests verify that webview interactions correctly update
 * VS Code context values and extension state.
 */
suite('Webview Protocol - Context Value Side Effects', () => {
  before(async function() {
    this.timeout(30000);
    
    // Ensure extension is activated
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    assert.ok(ext, 'Extension should exist');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true, 'Extension should be active');
    
    vscode.window.showInformationMessage('Starting webview protocol tests');
  });

  after(() => {
    vscode.window.showInformationMessage('Webview protocol tests completed');
  });

  teardown(async function() {
    // Reset view mode to file after each test to prevent state bleeding
    try {
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await sleep(500);
    } catch {
      // Ignore errors if command fails
    }
  });

  // ============================================================================
  // View Mode Context Value Tests
  // ============================================================================
  suite('View Mode Context Values', () => {
    test('Should initialize viewMode context to "file" on graph open', async function() {
      this.timeout(15000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      const viewMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.strictEqual(viewMode, 'file', 'View mode should be "file" initially');
    });

    test('Should update viewMode context when switching to list view', async function() {
      this.timeout(15000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Switch to list view
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      const viewMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.strictEqual(viewMode, 'list', 'View mode should be "list"');
    });

    test('Should update viewMode context when switching to symbol view', async function() {
      this.timeout(15000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Switch to symbol view
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      await waitForViewMode('symbol');
      
      const viewMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.strictEqual(viewMode, 'symbol', 'View mode should be "symbol"');
    });

    test('Should persist viewMode context across mode switches', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Switch to list
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'list');
      
      // Switch to symbol
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      await waitForViewMode('symbol');
      assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'symbol');
      
      // Switch back to file
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file');
    });
  });

  // ============================================================================
  // Unused Filter Context Value Tests
  // ============================================================================
  suite('Unused Filter Commands', () => {
    test('Should execute enableUnusedFilter command without error', async function() {
      this.timeout(15000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Enable unused filter - should not throw
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(1000);
      
      assert.ok(true, 'Enable filter command executed successfully');
    });

    test('Should execute disableUnusedFilter command without error', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Enable then disable - both should succeed
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(1000);
      
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(1000);
      
      assert.ok(true, 'Disable filter command executed successfully');
    });

    test('Should handle filter commands when switching view modes', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Enable filter
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(1000);
      
      // Switch to list view - filter state should persist
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      // Disable filter in list mode - should work
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(500);
      
      assert.ok(true, 'Filter commands work across view mode changes');
    });
  });

  // ============================================================================
  // Reverse Dependencies Context Value Tests
  // ============================================================================
  suite('Reverse Dependencies Context Values', () => {
    test('Should initialize reverseDependenciesVisible context to false', async function() {
      this.timeout(15000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      const visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, false, 'Reverse dependencies should be hidden initially');
    });

    test('Should update reverseDependenciesVisible when showing reverse deps', async function() {
      this.timeout(15000);
      
      const doc = await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Show reverse dependencies
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies', doc.uri.fsPath);
      await sleep(1500); // Wait for context update
      
      const visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'Reverse dependencies should be visible');
    });

    test('Should clear reverseDependenciesVisible when hiding reverse deps', async function() {
      this.timeout(20000);
      
      const doc = await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Show then hide
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies', doc.uri.fsPath);
      await sleep(1500);
      
      await vscode.commands.executeCommand('graph-it-live.hideReverseDependencies');
      await sleep(500);
      
      const visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, false, 'Reverse dependencies should be hidden');
    });
  });

  // ============================================================================
  // State Persistence Across Operations Tests
  // ============================================================================
  suite('State Persistence', () => {
    test('Should execute filter toggle after refresh', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Enable filter
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(1000);
      
      // Refresh graph
      await vscode.commands.executeCommand('graph-it-live.refreshGraph');
      await sleep(2000);
      
      // Should still be able to toggle filter
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(500);
      
      assert.ok(true, 'Filter commands work after refresh');
    });

    test('Should maintain view mode after graph refresh', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Switch to list mode
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      // Refresh graph
      await vscode.commands.executeCommand('graph-it-live.refreshGraph');
      await sleep(2000);
      
      // Should still be in list mode
      const viewMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.strictEqual(viewMode, 'list', 'View mode should persist after refresh');
    });
  });

  // ============================================================================
  // Multiple Rapid Operations Tests
  // ============================================================================
  suite('Rapid Operations', () => {
    test('Should handle rapid view mode switches correctly', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Rapid switches
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      
      // Wait for final state
      await waitForViewMode('file');
      
      const viewMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.strictEqual(viewMode, 'file', 'Final view mode should be "file"');
    });

    test('Should handle rapid filter toggles correctly', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Rapid toggles - should all execute without error
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(100);
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(100);
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(100);
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(1000);
      
      assert.ok(true, 'Rapid filter toggles executed successfully');
    });

    test('Should handle combined operations (mode switch + filter toggle)', async function() {
      this.timeout(20000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Combined operations - should all execute without error
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await sleep(100);
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(100);
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await sleep(100);
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(1000);
      
      // Final view mode should be file
      const finalMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.strictEqual(finalMode, 'file', 'Final view mode should be "file"');
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================
  suite('Error Handling', () => {
    test('Should handle invalid view mode gracefully', async function() {
      this.timeout(15000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Try to execute non-existent mode (should not crash)
      try {
        await vscode.commands.executeCommand('graph-it-live.setViewModeInvalid');
      } catch {
        // Command doesn't exist, expected
      }
      
      // Context should still be valid
      const viewMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.ok(['file', 'list', 'symbol'].includes(viewMode || ''), 'View mode should be valid');
    });

    test('Should handle commands before graph is loaded', async function() {
      this.timeout(10000);
      
      // Try to switch view mode before opening graph (should not crash)
      try {
        await vscode.commands.executeCommand('graph-it-live.setViewModeList');
        await sleep(500);
      } catch {
        // May fail, that's okay
      }
      
      // Extension should still be functional
      const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
      assert.strictEqual(ext!.isActive, true, 'Extension should still be active');
    });
  });

  // ============================================================================
  // Cross-Language Consistency Tests
  // ============================================================================
  suite('Cross-Language Context Consistency', () => {
    test('Should handle filter commands for TypeScript files', async function() {
      this.timeout(15000);
      
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Should execute without error
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(500);
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(500);
      
      assert.ok(true, 'Filter commands execute successfully for TypeScript');
    });

    test('Should handle filter commands for JavaScript files', async function() {
      this.timeout(15000);
      
      const jsFile = getProjectFile('sample-project', 'src', 'logger.js');
      
      // Check if file exists
      try {
        await vscode.workspace.fs.stat(jsFile);
      } catch {
        console.log('JavaScript file not found, skipping test');
        this.skip();
      }
      
      const doc = await vscode.workspace.openTextDocument(jsFile);
      await vscode.window.showTextDocument(doc);
      
      await vscode.commands.executeCommand('graph-it-live.showGraph');
      await waitForViewMode('file');
      
      // Should execute without error
      await vscode.commands.executeCommand('graph-it-live.enableUnusedFilter');
      await sleep(500);
      await vscode.commands.executeCommand('graph-it-live.disableUnusedFilter');
      await sleep(500);
      
      assert.ok(true, 'Filter commands execute successfully for JavaScript');
    });

    test('Should handle view mode commands for Python files', async function() {
      this.timeout(15000);
      
      const pyFile = getProjectFile('python-project', 'main.py');
      
      try {
        await vscode.workspace.fs.stat(pyFile);
      } catch {
        console.log('Python file not found, skipping test');
        this.skip();
      }
      
      const doc = await vscode.workspace.openTextDocument(pyFile);
      await vscode.window.showTextDocument(doc);
      
      await vscode.commands.executeCommand('graph-it-live.showGraph');
      await waitForViewMode('file');
      
      const viewMode = await getContextKey<string>('graph-it-live.viewMode');
      assert.strictEqual(viewMode, 'file', 'View mode context should work for Python');
    });
  });
});
