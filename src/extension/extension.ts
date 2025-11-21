import * as vscode from 'vscode';
import { GraphProvider } from './GraphProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Graph-It-Live is now active!');

    const provider = new GraphProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(GraphProvider.viewType, provider)
    );

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('graph-it-live')) {
                provider.updateConfig();
            }
        })
    );

    // Listen for file changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            console.log('[Extension] Active editor changed:', editor?.document.fileName);
            provider.updateGraph();
        })
    );
    
    // Also update on save to reflect new imports
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            console.log('[Extension] Document saved:', doc.fileName);
            provider.updateGraph();
        })
    );

    // Register Command to focus the view
    context.subscriptions.push(
        vscode.commands.registerCommand('graph-it-live.showGraph', () => {
            vscode.commands.executeCommand('graph-it-live.graphView.focus');
        })
    );
}

export function deactivate() {}

