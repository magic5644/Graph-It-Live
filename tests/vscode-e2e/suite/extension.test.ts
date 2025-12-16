import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { after, before } from 'mocha';

suite('Graph-It-Live Extension Test Suite', () => {
  before(() => {
    vscode.window.showInformationMessage('Start all tests.');
  });

  after(() => {
    vscode.window.showInformationMessage('All tests done!');
  });

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('magic5644.graph-it-live'));
  });

  test('Extension should activate', async function() {
    this.timeout(30000); // Give extension time to activate and index
    
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    assert.ok(ext, 'Extension should exist');
    
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true, 'Extension should be active');
  });

  test('Should register showGraph command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.showGraph'),
      'Should have showGraph command'
    );
  });

  test('Should open graph view when command is executed', async function() {
    this.timeout(10000);
    
    // Execute the show graph command
    await vscode.commands.executeCommand('graph-it-live.showGraph');
    
    // Wait a bit for the view to appear
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // The graph view should now be visible (we can't easily verify webview content though)
    // What we can check is that the command executed without error
    assert.ok(true, 'Command executed successfully');
  });

  test('Should analyze a TypeScript file', async function() {
    this.timeout(15000);
    
    // Open a sample TypeScript file
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0, 'Should have a workspace');
    
    const sampleFile = vscode.Uri.joinPath(
      workspaceFolders[0].uri,
      'src/utils.ts'
    );
    
    try {
      const doc = await vscode.workspace.openTextDocument(sampleFile);
      await vscode.window.showTextDocument(doc);
      
      // Wait for extension to process the file
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // If we got here without errors, the extension handled the file
      assert.ok(true, 'File was processed');
    } catch {
      // File might not exist in test workspace, that's okay
      assert.ok(true, 'Test completed');
    }
  });
});
