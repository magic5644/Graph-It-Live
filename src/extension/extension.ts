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
import { registerBranchWatch } from './services/BranchWatchService';
import { startPeriodicFlush, type PeriodicFlush } from '../analyzer/stats/statsPersistence';
import { sessionStats } from '../shared/sessionStats';
import { normalizePathForComparison } from '../shared/path';
import { findConfiguredWorkspaceFolder, resolvePreferredWorkspaceFolder } from './workspaceFolder';

// Keep track of MCP server provider for cleanup
let mcpServerProvider: McpServerProvider | null = null;
let graphProvider: GraphProvider | null = null;
// Persists the language model tools' TOON stats under the 'vscode' source.
let statsFlush: PeriodicFlush | null = null;

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

    sessionStats.setSource('vscode');
    statsFlush = startPeriodicFlush(sessionStats, {
        onError: (error) => log.warn('Session stats flush failed:', error instanceof Error ? error.message : String(error)),
    });

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
    const lmToolsService = new LmToolsService({ provider, logger: log, extensionPath: context.extensionPath });
    
    // Get the fileChangeScheduler from provider (it's created during provider construction)
    const fileChangeScheduler = provider.fileChangeScheduler;
    if (!fileChangeScheduler) {
        log.warn('FileChangeScheduler unavailable: activating without an open workspace');
    }
    const editorEventsService = fileChangeScheduler ? new EditorEventsService({
        target: provider,
        logger: log,
        fileChangeScheduler,
    }) : undefined;

    // Call Graph panel — T019: register showCallGraph command
    const callGraphViewService = new CallGraphViewService(context, async (filePath) => {
        const spider = provider.getSpiderForLmTools();
        return spider ? (await spider.findReferencingFilesThroughBarrels(filePath)).map((ref) => ref.path) : [];
    }, () => provider.getWorkspaceRoot());
    provider.setCallGraphViewService(callGraphViewService);
    const branchWatchRegistration = registerBranchWatch(context, provider);
    provider.setBranchWatchRegistration(branchWatchRegistration);
    context.subscriptions.push(branchWatchRegistration);

    const disposables: vscode.Disposable[] = [
      // Output channel disposal
      outputChannel,

        // Call Graph panel service
        callGraphViewService,

        // showCallGraph command
        vscode.commands.registerCommand('graph-it-live.showCallGraph', async () => {
            // Switch the toolbar to call-graph mode only for a file the call graph can render (#770).
            if (!callGraphViewService.canShow()) return;
            await provider.setViewModeCallgraph();
            await callGraphViewService.show();
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
      ...(editorEventsService?.register() ?? []),
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

    const analyzedFolderName = (): string => {
        const root = provider.getWorkspaceRoot();
        return vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === root)?.name ?? 'none';
    };
    const warnUnmatchedWorkspaceFolder = (configured: string): void => {
        const open = (vscode.workspace.workspaceFolders ?? []).map(f => `"${f.name}"`).join(', ') || 'none';
        vscode.window.showWarningMessage(
            `Graph-It-Live: setting workspaceFolder "${configured}" matches no open folder (open: ${open}); analyzing "${analyzedFolderName()}". Run "Graph-It-Live: Set Workspace Folder" to pick one.`
        );
    };
    // The graph's Spider is built at startup: a new root reaches the MCP server at once, the graph after a reload.
    const applyWorkspaceFolderSetting = (): void => {
        const { configured, folder } = findConfiguredWorkspaceFolder();
        if (configured && !folder) {
            warnUnmatchedWorkspaceFolder(configured);
            return;
        }
        const target = folder ?? resolvePreferredWorkspaceFolder();
        if (!target) return;
        mcpServerProvider?.updateWorkspaceFolder(target);
        log.info('Workspace switched to:', target.uri.fsPath);
        if (normalizePathForComparison(target.uri.fsPath) === normalizePathForComparison(provider.getWorkspaceRoot() ?? '')) return;
        vscode.window.showInformationMessage(
            `Graph-It-Live: now analyzing "${target.name}" in the MCP server. Reload the window to update the graph view.`,
            'Reload Window'
        ).then(action => {
            if (action === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    };
    const startupSetting = findConfiguredWorkspaceFolder();
    if (startupSetting.configured && !startupSetting.folder && vscode.workspace.workspaceFolders?.length) {
        warnUnmatchedWorkspaceFolder(startupSetting.configured);
    }

    // Command: switch the workspace root the graph and MCP server analyze
    disposables.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('graph-it-live.workspaceFolder')) applyWorkspaceFolderSetting();
        }),
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
            if (findConfiguredWorkspaceFolder().folder?.uri.toString() === pick.folder.uri.toString()) {
                vscode.window.showInformationMessage(`Graph-It-Live: Already analyzing "${pick.folder.name}".`);
                return;
            }
            // The configuration listener below switches the MCP server and asks for the reload.
            await vscode.workspace.getConfiguration('graph-it-live').update(
                'workspaceFolder', pick.folder.uri.fsPath, vscode.ConfigurationTarget.Workspace
            );
        }),

    // Auto-update MCP server when workspace folders change (add/remove)
        vscode.workspace.onDidChangeWorkspaceFolders((e) => {
            if (!mcpServerProvider) {
                // No MCP provider yet — try to create one if a folder was added
                const first = resolvePreferredWorkspaceFolder();
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
                const fallback = resolvePreferredWorkspaceFolder();
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
    statsFlush?.dispose();
    statsFlush = null;

    await graphProvider?.dispose();
    graphProvider = null;
    
    // Clean up MCP server provider
    mcpServerProvider?.dispose();
    mcpServerProvider = null;
    // VSCode handles disposal of subscriptions automatically
}
