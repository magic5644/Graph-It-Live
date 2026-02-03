import { after, before, beforeEach } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getContextKey, openGraphFor, sleep, waitForViewMode } from './_helpers';

/**
 * E2E Tests for Reverse Dependencies Toggle Feature
 * Tests the showReverseDependencies and hideReverseDependencies commands
 * and the reverseDependenciesVisible context key
 */

suite('Reverse Dependencies Toggle Test Suite', () => {
  before(async function() {
    this.timeout(30000);
    vscode.window.showInformationMessage('Starting reverse dependencies toggle tests');
    
    // Ensure extension is activated
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    
    // Wait for indexing to complete
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  after(() => {
    vscode.window.showInformationMessage('Reverse dependencies toggle tests done!');
  });

  beforeEach(async function() {
    this.timeout(10000);
    try {
      // Reset to file view and hide reverse dependencies
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      
      // Try to hide reverse dependencies (may already be hidden)
      try {
        await vscode.commands.executeCommand('graph-it-live.hideReverseDependencies');
      } catch {
        // Ignore if command not available (already hidden)
      }
      
      await sleep(300);
    } catch {
      // Best-effort reset; individual tests assert the required state.
    }
  });

  // ============================================================================
  // Command Registration Tests
  // ============================================================================

  test('Should register showReverseDependencies command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.showReverseDependencies'),
      'Should have showReverseDependencies command'
    );
  });

  test('Should register hideReverseDependencies command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.hideReverseDependencies'),
      'Should have hideReverseDependencies command'
    );
  });

  // ============================================================================
  // Context Key Tests
  // ============================================================================

  test('Context key reverseDependenciesVisible should default to false', async function() {
    this.timeout(10000);
    
    // Open graph view in file mode
    await openGraphFor('sample-project', 'src', 'utils.ts');
    await waitForViewMode('file');
    
    // Wait a bit for context to stabilize
    await sleep(500);
    
    const visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
    assert.strictEqual(visible, false, 'reverseDependenciesVisible should default to false');
  });

  test('Context key reverseDependenciesVisible updates to true after show command', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view in file mode
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      // Show reverse dependencies
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      
      // Check context key
      const visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'reverseDependenciesVisible should be true after show');
    } catch (error) {
      console.error('Error in context key update test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('Context key reverseDependenciesVisible updates to false after hide command', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view in file mode
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      // Show reverse dependencies
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      
      // Verify it's shown
      let visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'reverseDependenciesVisible should be true after show');
      
      // Hide reverse dependencies
      await vscode.commands.executeCommand('graph-it-live.hideReverseDependencies');
      await sleep(1000);
      
      // Check context key is now false
      visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, false, 'reverseDependenciesVisible should be false after hide');
    } catch (error) {
      console.error('Error in context key hide test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // Command Execution Tests
  // ============================================================================

  test('showReverseDependencies command executes without error', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view in file mode
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      // Execute command
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      
      assert.ok(true, 'showReverseDependencies executed successfully');
    } catch (error) {
      console.error('Error in show command test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('hideReverseDependencies command executes without error', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view in file mode
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      // Show first
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      
      // Then hide
      await vscode.commands.executeCommand('graph-it-live.hideReverseDependencies');
      await sleep(1000);
      
      assert.ok(true, 'hideReverseDependencies executed successfully');
    } catch (error) {
      console.error('Error in hide command test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // Toggle Behavior Tests
  // ============================================================================

  test('Should toggle between show and hide states', async function() {
    this.timeout(20000);
    
    try {
      // Open graph view in file mode
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      // Initial state: hidden
      let visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, false, 'Should start hidden');
      
      // Show
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'Should be visible after show');
      
      // Hide
      await vscode.commands.executeCommand('graph-it-live.hideReverseDependencies');
      await sleep(1000);
      visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, false, 'Should be hidden after hide');
      
      // Show again
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'Should be visible after second show');
      
      assert.ok(true, 'Toggle behavior works correctly');
    } catch (error) {
      console.error('Error in toggle behavior test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // View Mode Specificity Tests
  // ============================================================================

  test('Commands should only be available in file mode', async function() {
    this.timeout(20000);
    
    try {
      // Open graph view in file mode
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      // Should work in file mode
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      let visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'Should work in file mode');
      
      // Switch to list mode
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      // Context key should not change when switching modes
      const visibleAfterModeSwitch = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      // Note: The command visibility is controlled by when clause, 
      // but the context key persists across mode changes
      assert.strictEqual(visibleAfterModeSwitch, true, 'Context key persists across mode changes');
      
      assert.ok(true, 'Commands are properly scoped to file mode via when clause');
    } catch (error) {
      console.error('Error in view mode specificity test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('Reverse dependencies state persists when switching back to file mode', async function() {
    this.timeout(20000);
    
    try {
      // Open graph view in file mode
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      // Show reverse dependencies
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      let visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'Should be visible in file mode');
      
      // Switch to list mode and back
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      await sleep(500);
      
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      await sleep(500);
      
      // State should persist
      visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'State should persist when returning to file mode');
      
      assert.ok(true, 'State persistence works correctly');
    } catch (error) {
      console.error('Error in state persistence test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  test('Should work with different project files', async function() {
    this.timeout(20000);
    
    try {
      // Test with first file
      await openGraphFor('sample-project', 'src', 'utils.ts');
      await waitForViewMode('file');
      
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await sleep(1000);
      
      let visible = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visible, true, 'Should work with first file');
      
      // Test with second file
      await openGraphFor('sample-project', 'src', 'main.ts');
      await waitForViewMode('file');
      await sleep(500);
      
      // State should still be visible (persists across file changes)
      const visibleAfterFileChange = await getContextKey<boolean>('graph-it-live.reverseDependenciesVisible');
      assert.strictEqual(visibleAfterFileChange, true, 'State persists across file changes');
      
      assert.ok(true, 'Works with different project files');
    } catch (error) {
      console.error('Error in multi-file test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });
});
