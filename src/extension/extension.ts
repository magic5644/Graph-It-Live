import * as vscode from 'vscode';
import { GraphProvider } from './GraphProvider';
import { createMcpServerProvider, McpServerProvider } from '../mcp/McpServerProvider';

// Keep track of MCP server provider for cleanup
let mcpServerProvider: McpServerProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('Graph-It-Live is now active!');

    const provider = new GraphProvider(context.extensionUri, context);
    const disposables: vscode.Disposable[] = [
        // Provider must be registered before command
        vscode.window.registerWebviewViewProvider(GraphProvider.viewType, provider),

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('graph-it-live')) {
                provider.updateConfig();
                // Notify MCP server of config changes
                mcpServerProvider?.notifyChange();
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

    // Register MCP server provider if a workspace folder is open
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        mcpServerProvider = createMcpServerProvider(context.extensionUri, workspaceFolder);
        const mcpDisposable = mcpServerProvider.register(context);
        disposables.push(mcpDisposable);
        context.subscriptions.push(mcpServerProvider);
    } else {
        console.log('[Extension] No workspace folder open, MCP server not registered');
    }

    context.subscriptions.push(...disposables);
}

export function deactivate() {
    // Clean up MCP server provider
    mcpServerProvider?.dispose();
    mcpServerProvider = null;
    // VSCode handles disposal of subscriptions automatically
}

