import * as vscode from 'vscode';
import { GraphProvider } from './GraphProvider';
import { createMcpServerProvider, McpServerProvider } from '../mcp/McpServerProvider';
import { 
    extensionLoggerManager, 
    getExtensionLogger, 
    getLogLevelFromConfig,
    watchLogLevelConfig 
} from './logger';

// Keep track of MCP server provider for cleanup
let mcpServerProvider: McpServerProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
    // Initialize logging system
    const outputChannel = vscode.window.createOutputChannel('Graph-It-Live');
    extensionLoggerManager.initialize(outputChannel);
    extensionLoggerManager.setLevel(getLogLevelFromConfig());
    watchLogLevelConfig(context);
    
    const log = getExtensionLogger('Extension');
    log.info('Graph-It-Live is now active!');

    const provider = new GraphProvider(context.extensionUri, context);
    const disposables: vscode.Disposable[] = [
      // Output channel disposal
      outputChannel,

      // Provider must be registered before command
      vscode.window.registerWebviewViewProvider(
        GraphProvider.viewType,
        provider
      ),

      // Listen for configuration changes
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("graph-it-live")) {
          provider.updateConfig();
          // Notify MCP server of config changes
          mcpServerProvider?.notifyChange();
        }
      }),

      // Listen for file/editor changes - preserve current view type
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        log.debug("Active editor changed:", editor?.document.fileName);
        // Use onActiveFileChanged to preserve view type (file or symbol)
        provider.onActiveFileChanged();
      }),

      // Also update on save to reflect new imports
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        log.debug("Document saved:", doc.fileName);
        // Re-analyze the file and refresh the appropriate view (file or symbol)
        // onFileSaved now handles both cache update and view refresh while preserving view mode
        await provider.onFileSaved(doc.fileName);
      }),

      // Register Command to focus the view
      vscode.commands.registerCommand("graph-it-live.showGraph", () => {
        vscode.commands.executeCommand("graph-it-live.graphView.focus");
      }),
      // Developer commands to aid debugging and manual re-indexing
      vscode.commands.registerCommand(
        "graph-it-live.forceReindex",
        async () => {
          try {
            await provider.forceReindex();
            vscode.window.showInformationMessage(
              "Graph-It-Live: Re-index triggered"
            );
          } catch (e) {
            log.error("Force re-index failed:", e);
            vscode.window.showErrorMessage("Graph-It-Live: Re-index failed");
          }
        }
      ),
      vscode.commands.registerCommand(
        "graph-it-live.expandAllNodes",
        async () => {
          try {
            const result = await provider.expandAllNodes();
            vscode.window.showInformationMessage(
              `Graph-It-Live: ${result.message}`
            );
          } catch (e) {
            log.error("Expand/collapse all nodes failed:", e);
            vscode.window.showErrorMessage("Graph-It-Live: Toggle expand all failed");
          }
        }
      ),
      vscode.commands.registerCommand(
        "graph-it-live.refreshGraph",
        async () => {
          try {
            await provider.refreshGraph();
            vscode.window.showInformationMessage(
              "Graph-It-Live: Graph refreshed"
            );
          } catch (e) {
            log.error("Refresh graph failed:", e);
            vscode.window.showErrorMessage("Graph-It-Live: Refresh failed");
          }
        }
      ),
      vscode.commands.registerCommand(
        "graph-it-live.toggleViewMode",
        async () => {
          try {
            const result = await provider.toggleViewMode();
            vscode.window.showInformationMessage(
              `Graph-It-Live: ${result.message}`
            );
          } catch (e) {
            log.error("Toggle view mode failed:", e);
            vscode.window.showErrorMessage("Graph-It-Live: Toggle view failed");
          }
        }
      ),
      vscode.commands.registerCommand(
        "graph-it-live.showIndexStatus",
        async () => {
          try {
            const status = provider.getIndexStatus();
            if (status) {
              const msg = `Indexer: ${status.state} ${status.processed}/${status.total} (${status.percentage}%)`;
              vscode.window.showInformationMessage(msg);
            } else {
              vscode.window.showInformationMessage(
                "Graph-It-Live: No indexer available"
              );
            }
          } catch (e) {
            log.error("Get index status failed:", e);
            vscode.window.showErrorMessage(
              "Graph-It-Live: Could not get index status"
            );
          }
        }
      ),
    ];

    // Register MCP server provider if a workspace folder is open
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        mcpServerProvider = createMcpServerProvider(context.extensionUri, workspaceFolder);
        const mcpDisposable = mcpServerProvider.register(context);
        disposables.push(mcpDisposable);
        context.subscriptions.push(mcpServerProvider);
    } else {
        log.info('No workspace folder open, MCP server not registered');
    }

    context.subscriptions.push(...disposables);
}

export function deactivate() {
    // Clean up MCP server provider
    mcpServerProvider?.dispose();
    mcpServerProvider = null;
    // VSCode handles disposal of subscriptions automatically
}

