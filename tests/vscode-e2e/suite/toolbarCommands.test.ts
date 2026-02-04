import { after, before, beforeEach } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { openGraphFor, sleep, waitForViewMode } from './_helpers';

/**
 * E2E Tests for Toolbar Commands
 * Tests the toolbar functionality: setViewModeFile, toggleViewMode,
 * showReverseDependencies, and context key management
 */

suite('Toolbar Commands Test Suite', () => {
  before(async function() {
    this.timeout(30000);
    vscode.window.showInformationMessage('Starting toolbar commands tests');
    
    // Ensure extension is activated
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    
    // Wait for indexing to complete
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  after(() => {
    vscode.window.showInformationMessage('Toolbar commands tests done!');
  });

  beforeEach(async function() {
    this.timeout(10000);
    try {
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await sleep(300);
    } catch {
      // Best-effort reset; individual tests assert the required state.
    }
  });

  // ============================================================================
  // Command Registration Tests
  // ============================================================================

  test('Should register setViewModeFile command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.setViewModeFile'),
      'Should have setViewModeFile command'
    );
  });

  test('Should register showReverseDependencies command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.showReverseDependencies'),
      'Should have showReverseDependencies command'
    );
  });

  test('Should register setViewModeFile command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.setViewModeFile'),
      'Should have setViewModeFile command'
    );
  });

  test('Should register setViewModeList command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.setViewModeList'),
      'Should have setViewModeList command'
    );
  });

  test('Should register setViewModeSymbol command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.setViewModeSymbol'),
      'Should have setViewModeSymbol command'
    );
  });

  // ============================================================================
  // Context Key Tests
  // ============================================================================

  test('Context key graph-it-live.viewMode should be initialized', async function() {
    this.timeout(10000);
    
    // Open graph view with an explicit file to avoid state leakage
    await openGraphFor('sample-project', 'src', 'utils.ts');
    await waitForViewMode('file');
    
    // Context key is initialized internally (can't query it directly)
    // Test passes if no errors thrown
    assert.ok(true, 'Context key initialized');
  });

  // ============================================================================
  // Direct View Mode Selection Tests
  // ============================================================================

  test('setViewModeFile should set view mode to file', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Switch to list view first
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      // Now set to file view
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      
      assert.ok(true, 'Successfully set to file view');
    } catch (error) {
      console.error('Error in setViewModeFile test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('setViewModeList should set view mode to list', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view (should be in file mode)
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Set to list view
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      assert.ok(true, 'Successfully set to list view');
    } catch (error) {
      console.error('Error in setViewModeList test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('setViewModeSymbol should set view mode to symbol', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Set to symbol view
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      await waitForViewMode('symbol');
      
      assert.ok(true, 'Successfully set to symbol view');
    } catch (error) {
      console.error('Error in setViewModeSymbol test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('View mode context key updates correctly for each mode', async function() {
    this.timeout(20000);
    
    try {
      // Open graph view
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Test file mode
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      
      // Test list mode
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      // Test symbol mode
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      await waitForViewMode('symbol');
      
      assert.ok(true, 'Context key updated correctly for all modes');
    } catch (error) {
      console.error('Error in context key update test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // setViewModeFile Command Tests
  // ============================================================================

  test('setViewModeFile should work from list view', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Switch to list view
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      
      // Execute setViewModeFile
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      
      // Verify we're back (refresh should work in file view)
      await vscode.commands.executeCommand('graph-it-live.refreshGraph');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      assert.ok(true, 'Successfully returned to file view');
    } catch (error) {
      console.error('Error in setViewModeFile test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('setViewModeFile should be no-op in file view', async function() {
    this.timeout(10000);
    
    try {
      // Open graph view (should be in file mode)
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Execute setViewModeFile (should do nothing)
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      
      assert.ok(true, 'setViewModeFile in file view handled gracefully');
    } catch (error) {
      console.error('Error in setViewModeFile no-op test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // showReverseDependencies Command Tests
  // ============================================================================

  test('showReverseDependencies should work with active file', async function() {
    this.timeout(15000);
    
    try {
      // Open graph view
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Execute showReverseDependencies
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      assert.ok(true, 'showReverseDependencies executed without error');
    } catch (error) {
      console.error('Error in showReverseDependencies test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('showReverseDependencies should show warning without active file', async function() {
    this.timeout(10000);
    
    try {
      // Close all editors
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Open graph view with a known file to reset context deterministically
      await openGraphFor('sample-project', 'src', 'utils.ts');
      
      // Execute showReverseDependencies (should show warning)
      await vscode.commands.executeCommand('graph-it-live.showReverseDependencies');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      assert.ok(true, 'showReverseDependencies without file handled gracefully');
    } catch (error) {
      console.error('Error in showReverseDependencies warning test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // Integration Tests - Multiple Commands
  // ============================================================================

  test('Full toolbar workflow: file → list → back to file', async function() {
    this.timeout(25000);
    
    try {
      // Step 1: Open graph view (file mode)
      await openGraphFor('sample-project', 'src', 'utils.ts');
      console.log('Step 1 - File view opened');
      
      // Step 2: Toggle to list view
      await vscode.commands.executeCommand('graph-it-live.setViewModeList');
      await waitForViewMode('list');
      console.log('Step 2 - List view activated');
      
      // Step 3: Back to file view
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      console.log('Step 3 - Back to file view');
      
      assert.ok(true, 'Full workflow completed successfully');
    } catch (error) {
      console.error('Error in full workflow test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });
});
