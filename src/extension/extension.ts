import * as vscode from 'vscode';
import { GraphProvider } from './GraphProvider';
import { createMcpServerProvider, McpServerProvider } from '../mcp/McpServerProvider';
import { 
  extensionLoggerManager, 
  getExtensionLogger, 
  getLogLevelFromConfig,
  watchLogLevelConfig 
} from './extensionLogger';
import { setLoggerBackend } from '../shared/logger';
import { CommandRegistrationService } from './services/CommandRegistrationService';
import { EditorEventsService } from './services/EditorEventsService';

// Keep track of MCP server provider for cleanup
let mcpServerProvider: McpServerProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
    // Initialize logging system
    const outputChannel = vscode.window.createOutputChannel('Graph-It-Live');
    extensionLoggerManager.initialize(outputChannel);
    // Redirect shared loggers to the extension OutputChannel by setting the shared backend
    setLoggerBackend({
      createLogger(prefix: string, level) {
        const l = extensionLoggerManager.getLogger(prefix);
        // Respect the requested level when provided
        if (level) l.setLevel(level);
        return l;
      }
    });
    extensionLoggerManager.setLevel(getLogLevelFromConfig());
    watchLogLevelConfig(context);
    
    const log = getExtensionLogger('Extension');
    log.info('Graph-It-Live is now active!');

    const provider = new GraphProvider(context.extensionUri, context);
    const commandService = new CommandRegistrationService({ provider, logger: log });
    
    // Get the fileChangeScheduler from provider (it's created during provider construction)
    const fileChangeScheduler = provider.fileChangeScheduler;
    if (!fileChangeScheduler) {
        log.error('FileChangeScheduler not initialized in GraphProvider');
        throw new Error('FileChangeScheduler not available');
    }
    
    const editorEventsService = new EditorEventsService({ 
        provider, 
        logger: log,
        fileChangeScheduler 
    });
    const disposables: vscode.Disposable[] = [
      // Output channel disposal
      outputChannel,

      // Provider must be registered before command
      vscode.window.registerWebviewViewProvider(
        GraphProvider.viewType,
        provider
      ),

      // Register commands via centralized service
      ...commandService.registerAll(),
      // Editor/workspace event listeners
      ...editorEventsService.register(),
    ];

    // Register MCP server provider if a workspace folder is open
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        mcpServerProvider = createMcpServerProvider(context.extensionUri, workspaceFolder);
        const mcpDisposable = mcpServerProvider.register(context);
        disposables.push(mcpDisposable);
        context.subscriptions.push(mcpServerProvider);
        provider.notifyMcpServerOfConfigChange = () => mcpServerProvider?.notifyChange();
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
