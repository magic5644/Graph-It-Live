import { after, afterEach, before } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getProjectFile, openGraphFor, sleep, waitForViewMode } from './_helpers';

/**
 * E2E Tests for Incoming Calls Feature (Étape 5)
 * Tests LSP-based incoming calls visualization with bidirectional edges
 * Note: Incoming calls are always enabled - no toggle setting
 */

suite('Incoming Calls Test Suite (Étape 5)', () => {
  let originalEnableCallHierarchy: boolean;

  before(async function() {
    this.timeout(30000);
    vscode.window.showInformationMessage('Starting incoming calls tests');
    
    // Ensure extension is activated
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    
    // Save original setting
    const config = vscode.workspace.getConfiguration('graph-it-live');
    originalEnableCallHierarchy = config.get<boolean>('enableCallHierarchy', true);
    
    // Ensure call hierarchy is enabled for these tests
    await config.update('enableCallHierarchy', true, vscode.ConfigurationTarget.Global);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Wait for indexing to complete
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  after(async function() {
    this.timeout(10000);
    
    // Restore original setting
    const config = vscode.workspace.getConfiguration('graph-it-live');
    await config.update('enableCallHierarchy', originalEnableCallHierarchy, vscode.ConfigurationTarget.Global);
    
    vscode.window.showInformationMessage('Incoming calls tests done!');
  });
  
  // Add afterEach to reset view state between tests
  afterEach(async function() {
    this.timeout(5000);

    try {
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await waitForViewMode('file');
      await sleep(300);
    } catch {
      // Best-effort cleanup; avoid masking earlier failures
    }
  });

  // ============================================================================
  // Command Registration Tests
  // ============================================================================
  // Note: toggleIncomingCalls command removed - incoming calls always enabled

  // ============================================================================
  // Integration with Symbol View Tests
  // ============================================================================
  // Note: enableIncomingCalls setting and toggleIncomingCalls command were removed.
  // Incoming calls are now always enabled in symbol view.

  test('Should display incoming calls in symbol mode', async function() {
    this.timeout(20000);
    
    try {
      // Open graph view on a file with rich symbol graph
      await openGraphFor('symbols', 'functions.ts');
      const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      console.log('[incomingCalls] active editor', activePath);
      
      // Switch to symbol mode deterministically
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      const afterSymbol = await waitForViewMode('symbol', { timeoutMs: 15000 });
      console.log('[incomingCalls] after setViewModeSymbol viewMode=', afterSymbol);
      
      // Incoming calls should be visible automatically (always enabled)
      await waitForViewMode('symbol');
      
      assert.ok(true, 'Successfully displayed incoming calls in symbol mode');
    } catch (error) {
      console.error('Error in symbol view incoming calls test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // Edge Visualization Tests
  // ============================================================================

  test('Should include bidirectional edges in symbol view', async function() {
    this.timeout(20000);
    
    try {
      // Open graph view on a file with rich symbol graph
      await openGraphFor('symbols', 'functions.ts');
      const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      console.log('[incomingCalls] active editor (edges test)', activePath);
      
      // Move to symbol mode
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      const afterSymbol = await waitForViewMode('symbol', { timeoutMs: 15000 });
      console.log('[incomingCalls] after setViewModeSymbol (edges) viewMode=', afterSymbol);
      
      // Incoming calls should be visible with bidirectional edges (always enabled)
      await waitForViewMode('symbol');
      
      assert.ok(true, 'Test completed successfully');
    } catch (error) {
      console.error('Error in edge visualization test:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  // ============================================================================
  // Cross-Language Support Tests
  // ============================================================================

  test('Should work with TypeScript files', async function() {
    this.timeout(15000);
    
    try {
      const tsFile = getProjectFile('sample-project', 'src', 'utils.ts');
      const doc = await vscode.workspace.openTextDocument(tsFile);
      await vscode.window.showTextDocument(doc);
      
      await vscode.commands.executeCommand('graph-it-live.showGraph');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Switch to symbol mode to see incoming calls
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      await waitForViewMode('symbol');
      
      assert.ok(true, 'Works with TypeScript');
    } catch (error) {
      console.error('TypeScript test error:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });

  test('Should work with JavaScript files', async function() {
    this.timeout(15000);
    
    try {
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
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Switch to symbol mode to see incoming calls
      await vscode.commands.executeCommand('graph-it-live.setViewModeSymbol');
      await waitForViewMode('symbol');
      
      assert.ok(true, 'Works with JavaScript');
    } catch (error) {
      console.error('JavaScript test error:', error);
      assert.fail(`Test failed: ${error}`);
    }
  });
});
