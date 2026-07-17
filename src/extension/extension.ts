import * as vscode from 'vscode';
import { createMcpServerProvider, McpServerProvider } from './McpServerProvider';
import { setLoggerBackend } from '../shared/logger';
import {
    extensionLoggerManager,
    getExtensionLogger,
    getLogLevelFromConfig,
    watchLogLevelConfig
} from './extensionLogger';
import { GraphProvider } from './GraphProvider';
import { CallGraphViewService } from './services/CallGraphViewService';
import { parseReviewCallGraphDepth } from '../shared/reviewTarget';
import { CommandCoordinator } from './services/CommandCoordinator';
import { CommandRegistrationService } from './services/CommandRegistrationService';
import { EditorEventsService } from './services/EditorEventsService';
import { LmToolsService } from './services/LmToolsService';

// Keep track of MCP server provider for cleanup
let mcpServerProvider: McpServerProvider | null = null;
let graphProvider: GraphProvider | null = null;

function resolvePreferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    const getWorkspaceFolder = (vscode.workspace as typeof vscode.workspace & {
        getWorkspaceFolder?: (uri: vscode.Uri) => vscode.WorkspaceFolder | undefined;
    }).getWorkspaceFolder;

    if (activeEditor?.document.uri.scheme === 'file' && typeof getWorkspaceFolder === 'function') {
        const editorFolder = getWorkspaceFolder(activeEditor.document.uri);
        if (editorFolder) {
            return editorFolder;
        }
    }

    return vscode.workspace.workspaceFolders?.[0];
}

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
    graphProvider = provider; // Keep reference for deactivation
    const commandCoordinator = new CommandCoordinator({
        provider,
        ui: vscode.window,
    });
    const commandService = new CommandRegistrationService({
        provider,
        commandCoordinator,
        logger: log,
    });
    const lmToolsService = new LmToolsService({ provider, logger: log });
    
    // Watch for performance profile changes and apply preset values
    const profileWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('graph-it-live.performanceProfile')) {
            const config = vscode.workspace.getConfiguration('graph-it-live');
            const profile = config.get<'default' | 'low-memory' | 'high-performance' | 'custom'>('performanceProfile', 'default');
            
            if (profile !== 'custom') {
                // Apply profile settings automatically
                await provider.stateManager.applyProfileSettings(profile);
                log.info(`Applied performance profile: ${profile}`);
            }
        }
    });
    
    // Get the fileChangeScheduler from provider (it's created during provider construction)
    const fileChangeScheduler = provider.fileChangeScheduler;
    if (!fileChangeScheduler) {
        log.error('FileChangeScheduler not initialized in GraphProvider');
        throw new Error('FileChangeScheduler not available');
    }
    
    const editorEventsService = new EditorEventsService({ 
        target: provider, 
        logger: log,
        fileChangeScheduler 
    });

    // Call Graph panel — T019: register showCallGraph command
    const callGraphViewService = new CallGraphViewService(context);
    provider.setCallGraphViewService(callGraphViewService);

    const disposables: vscode.Disposable[] = [
      // Output channel disposal
      outputChannel,
      
      // Profile watcher
      profileWatcher,

        // Call Graph panel service
        callGraphViewService,

        // showCallGraph command
        vscode.commands.registerCommand('graph-it-live.showCallGraph', () => {
            provider.setViewModeCallgraph();
            callGraphViewService.show().catch((err: unknown) => {
                log.error('graph-it-live.showCallGraph error:', err);
            });
        }),

        vscode.window.registerUriHandler({
            handleUri: async (uri) => {
                if (uri.path !== '/graph-it-live.reviewCallGraph') return;
                const query = new URLSearchParams(uri.query);
                const file = query.get('file');
                const symbol = query.get('symbol') ?? undefined;
                if (!file) {
                    vscode.window.showErrorMessage('Graph-It-Live: Invalid review link');
                    return;
                }
                try {
                    const depth = parseReviewCallGraphDepth(query.get('depth'));
                    await vscode.commands.executeCommand('graph-it-live.reviewCallGraph', { file, symbol, depth });
                } catch {
                    vscode.window.showErrorMessage('Graph-It-Live: Invalid review link');
                }
            },
        }),

      // Provider must be registered before command
      vscode.window.registerWebviewViewProvider(
        GraphProvider.viewType,
        provider
      ),

      // Register commands via centralized service
      ...commandService.registerAll(),
        // Native VS Code Language Model Tools (always active, targets Copilot Chat)
        ...lmToolsService.registerAll(),
      // Editor/workspace event listeners
      ...editorEventsService.register(),
    ];

    // Register MCP server provider if a workspace folder is open
    const workspaceFolder = resolvePreferredWorkspaceFolder();
    if (workspaceFolder) {
        mcpServerProvider = createMcpServerProvider(context.extensionUri, workspaceFolder);
        const mcpDisposable = mcpServerProvider.register(context);
        disposables.push(mcpDisposable);
        context.subscriptions.push(mcpServerProvider);
        provider.notifyMcpServerOfConfigChange = () => mcpServerProvider?.notifyChange();
    } else {
        log.info('No workspace folder open, MCP server not registered');
    }

    // Command: switch the workspace root the graph and MCP server analyze
    disposables.push(
        vscode.commands.registerCommand('graph-it-live.setWorkspace', async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showWarningMessage('Graph-It-Live: No workspace folders are open.');
                return;
            }
            if (folders.length === 1) {
                vscode.window.showInformationMessage(
                    `Graph-It-Live: Already analyzing "${folders[0].name}".`
                );
                return;
            }
            const items = folders.map(f => ({
                label: f.name,
                description: f.uri.fsPath,
                folder: f,
            }));
            const current = mcpServerProvider?.workspaceRoot;
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: `Current workspace: ${current ?? 'none'} — select a folder to analyze`,
                title: 'Graph-It-Live: Set Workspace Folder',
            });
            if (!pick) {
                return;
            }
            if (mcpServerProvider) {
                mcpServerProvider.updateWorkspaceFolder(pick.folder);
            }
            log.info('Workspace switched to:', pick.folder.uri.fsPath);
            // MCP server restarts immediately with new workspace root.
            // The graph view Spider is initialized at extension startup, so a
            // window reload is required for it to analyze the new root.
            vscode.window.showInformationMessage(
                `Graph-It-Live: MCP server switched to "${pick.folder.name}". Reload the window to update the graph view.`,
                'Reload Window'
            ).then(action => {
                if (action === 'Reload Window') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }),

    // Auto-update MCP server when workspace folders change (add/remove)
        vscode.workspace.onDidChangeWorkspaceFolders((e) => {
            if (!mcpServerProvider) {
                // No MCP provider yet — try to create one if a folder was added
                const first = vscode.workspace.workspaceFolders?.[0];
                if (first) {
                    mcpServerProvider = createMcpServerProvider(context.extensionUri, first);
                    mcpServerProvider.register(context);
                    context.subscriptions.push(mcpServerProvider);
                    provider.notifyMcpServerOfConfigChange = () => mcpServerProvider?.notifyChange();
                    log.info('MCP server registered after workspace folder added:', first.uri.fsPath);
                }
                return;
            }
            // If the current root was removed, fall back to first remaining folder
            const removed = e.removed.some(
                f => f.uri.fsPath === mcpServerProvider!.workspaceRoot
            );
            if (removed) {
                const fallback = vscode.workspace.workspaceFolders?.[0];
                if (fallback) {
                    mcpServerProvider.updateWorkspaceFolder(fallback);
                    log.info('Workspace folder removed — MCP switched to:', fallback.uri.fsPath);
                }
            }
        })
    );

    context.subscriptions.push(...disposables);
}

export async function deactivate() {
    // Flush caches to disk
    await graphProvider?.flushCaches();
    graphProvider = null;
    
    // Clean up MCP server provider
    mcpServerProvider?.dispose();
    mcpServerProvider = null;
    // VSCode handles disposal of subscriptions automatically
}
