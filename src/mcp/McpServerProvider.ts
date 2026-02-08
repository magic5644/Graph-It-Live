/**
 * MCP Server Provider
 *
 * Registers the Graph-It-Live MCP server with VS Code using the
 * vscode.lm.registerMcpServerDefinitionProvider API.
 *
 * The MCP server runs as a separate Node.js process (mcpServer.js) which
 * spawns a Worker Thread (mcpWorker.js) for CPU-intensive analysis.
 *
 * This module is the ONLY MCP-related file that imports from 'vscode'.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { getExtensionLogger } from '../extension/extensionLogger';

/** Logger instance for McpServerProvider */
const log = getExtensionLogger('McpServerProvider');

// ============================================================================
// Types
// ============================================================================

export interface McpServerProviderOptions {
  /** URI of the extension directory (for locating dist/mcpServer.js) */
  extensionUri: vscode.Uri;
  /** Workspace folder to analyze */
  workspaceFolder: vscode.WorkspaceFolder;
}

// ============================================================================
// McpServerProvider Class
// ============================================================================

/**
 * Provides MCP server definitions to VS Code
 * Handles registration, configuration changes, and lifecycle management
 */
export class McpServerProvider implements vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceFolder: vscode.WorkspaceFolder;
  private registration: vscode.Disposable | null = null;
  private readonly didChangeEmitter = new vscode.EventEmitter<void>();
  private isEnabled = false;

  constructor(options: McpServerProviderOptions) {
    this.extensionUri = options.extensionUri;
    this.workspaceFolder = options.workspaceFolder;
  }

  /**
   * Register the MCP server provider with VS Code
   * @param context Extension context for subscriptions
   * @returns Disposable for cleanup
   */
  register(context: vscode.ExtensionContext): vscode.Disposable {
    // Check if MCP is enabled in settings
    this.isEnabled = this.isMcpEnabled();

    // Check if vscode.lm API is available (requires VS Code 1.96+)
    if (!vscode.lm || !('registerMcpServerDefinitionProvider' in vscode.lm)) {
      log.warn('vscode.lm.registerMcpServerDefinitionProvider not available. MCP server requires VS Code 1.96+');
      return { dispose: () => {} };
    }

    log.info('Registering MCP server provider...');
    log.debug('MCP server currently', this.isEnabled ? 'enabled' : 'disabled', 'in settings');

    try {
      // Always register the provider, but return empty list if disabled
      // This allows dynamic enable/disable without restart
      this.registration = vscode.lm.registerMcpServerDefinitionProvider(
        'graphItLiveMcp',
        {
          onDidChangeMcpServerDefinitions: this.didChangeEmitter.event,
          provideMcpServerDefinitions: () => this.provideMcpServerDefinitions(),
          resolveMcpServerDefinition: (definition) => definition,
        }
      );

      // Listen for configuration changes
      context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration('graph-it-live.enableMcpServer')) {
            this.onConfigChanged();
          }
          // Also trigger when debug logging setting changes
          if (e.affectsConfiguration('graph-it-live.enableMcpDebugLogging')) {
            log.info('MCP debug logging setting changed, restarting server...');
            this.didChangeEmitter.fire();
          }
        })
      );

      log.info('MCP server provider registered');
      return this.registration;
    } catch (error) {
      log.error('Failed to register MCP server provider:', error);
      return { dispose: () => {} };
    }
  }

  /**
   * Check if MCP server is enabled in settings
   */
  private isMcpEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('graph-it-live');
    return config.get<boolean>('enableMcpServer', false);
  }

  /**
   * Get configuration values for the MCP server
   */
  private getConfig(): {
    excludeNodeModules: boolean;
    maxDepth: number;
    tsConfigPath: string | undefined;
    enableDebugLogging: boolean;
  } {
    const config = vscode.workspace.getConfiguration('graph-it-live');
    
    // Try to find tsconfig.json in the workspace
    const tsconfigPath = this.findTsConfig();

    return {
      excludeNodeModules: config.get<boolean>('excludeNodeModules', true),
      maxDepth: config.get<number>('maxDepth', 50),
      tsConfigPath: tsconfigPath,
      enableDebugLogging: config.get<boolean>('enableMcpDebugLogging', false),
    };
  }

  /**
   * Find tsconfig.json in the workspace
   */
  private findTsConfig(): string | undefined {
    const workspaceRoot = this.workspaceFolder.uri.fsPath;
    const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
    
    // We'll let the server check if it exists
    return tsconfigPath;
  }

  /**
   * Provide MCP server definitions to VS Code
   */
  private provideMcpServerDefinitions(): vscode.McpServerDefinition[] {
    if (!this.isEnabled) {
      return [];
    }

    const serverPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'mcpServer.mjs').fsPath;
    const workspaceRoot = this.workspaceFolder.uri.fsPath;
    const extensionPath = this.extensionUri.fsPath;
    const config = this.getConfig();

    log.debug('Providing MCP server definition for', workspaceRoot);

    // Build environment variables for the server
    // Note: env type is Record<string, string | number> per VS Code API
    const env: Record<string, string | number> = {
      WORKSPACE_ROOT: workspaceRoot,
      EXTENSION_PATH: extensionPath,
      EXCLUDE_NODE_MODULES: String(config.excludeNodeModules),
      MAX_DEPTH: config.maxDepth, // Keep as number
    };

    if (config.tsConfigPath) {
      env.TSCONFIG_PATH = config.tsConfigPath;
    }

    // Pass debug logging setting to MCP server
    if (config.enableDebugLogging) {
      env.DEBUG_MCP = 'true';
      log.info('MCP debug logging enabled - logs will be written to ~/mcp-debug.log');
    }

    // Create stdio server definition
    // Constructor: (label, command, args?, env?, version?)
    const serverDefinition = new vscode.McpStdioServerDefinition(
      'Graph-It-Live Dependency Analyzer',
      'node',
      [serverPath],
      env
    );

    // Set cwd on the definition
    serverDefinition.cwd = vscode.Uri.file(workspaceRoot);

    return [serverDefinition];
  }

  /**
   * Handle configuration changes
   */
  private onConfigChanged(): void {
    const newEnabled = this.isMcpEnabled();

    if (newEnabled !== this.isEnabled) {
      this.isEnabled = newEnabled;
      log.info('MCP server', newEnabled ? 'enabled' : 'disabled');

      // Notify VS Code that server definitions changed
      this.didChangeEmitter.fire();

      // If toggling on and we don't have a registration, we need to re-register
      // This is handled by the extension on config change
    }
  }

  /**
   * Notify that server definitions have changed (e.g., workspace changed)
   */
  notifyChange(): void {
    this.didChangeEmitter.fire();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.registration?.dispose();
    this.didChangeEmitter.dispose();
  }
}

/**
 * Create an MCP server provider for the given workspace
 * @param extensionUri Extension directory URI
 * @param workspaceFolder Workspace folder to analyze
 * @returns McpServerProvider instance
 */
export function createMcpServerProvider(
  extensionUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder
): McpServerProvider {
  return new McpServerProvider({
    extensionUri,
    workspaceFolder,
  });
}
