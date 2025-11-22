import * as vscode from 'vscode';
import { GraphProvider } from './GraphProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Graph-It-Live is now active!');

    const provider = new GraphProvider(context.extensionUri);
    const disposables: vscode.Disposable[] = [
        // Provider must be registered before command
        vscode.window.registerWebviewViewProvider(GraphProvider.viewType, provider),

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('graph-it-live')) {
                provider.updateConfig();
            }
        }),

        // Listen for file/editor changes
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            console.log('[Extension] Active editor changed:', editor?.document.fileName);
            provider.updateGraph();
        }),
        
        // Also update on save to reflect new imports
        vscode.workspace.onDidSaveTextDocument((doc) => {
            console.log('[Extension] Document saved:', doc.fileName);
            provider.updateGraph();
        }),

        // Register Command to focus the view
        vscode.commands.registerCommand('graph-it-live.showGraph', () => {
            vscode.commands.executeCommand('graph-it-live.graphView.focus');
        })
    ];

    context.subscriptions.push(...disposables);
}

export function deactivate() {
    // No cleanup needed - VSCode handles disposal of subscriptions automatically
}

