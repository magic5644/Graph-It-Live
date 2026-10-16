import * as vscode from 'vscode';
import { validateReviewCallGraphTarget } from '@/shared/reviewTarget';
import type { GraphProvider } from '../GraphProvider';
import type { VsCodeLogger } from '../extensionLogger';
import type { CommandCoordinator } from './CommandCoordinator';

interface CommandRegistrationServiceOptions {
  provider: GraphProvider;
  commandCoordinator: CommandCoordinator;
  logger: VsCodeLogger;
}

/**
 * Centralizes VS Code command registration to keep extension.ts lean
 * and ensure consistent error handling/logging.
 */
export class CommandRegistrationService {
  private readonly provider: GraphProvider;
  private readonly commandCoordinator: CommandCoordinator;
  private readonly logger: VsCodeLogger;

  constructor(options: CommandRegistrationServiceOptions) {
    this.provider = options.provider;
    this.commandCoordinator = options.commandCoordinator;
    this.logger = options.logger;
  }

  registerAll(): vscode.Disposable[] {
    return [
      this.registerShowGraphCommand(),
      this.registerForceReindexCommand(),
      this.registerExpandAllCommand(),
      this.registerRefreshGraphCommand(),
      this.registerToggleViewModeCommand(), // Backward compatibility
      this.registerSetViewModeFileCommand(),
      this.registerSetViewModeListCommand(),
      this.registerSetViewModeSymbolCommand(),
      this.registerSetViewModeArchitectureCommand(),
      this.registerShowReverseDependenciesCommand(),
      this.registerHideReverseDependenciesCommand(),
      this.registerToggleUnusedFilterCommands(),
      this.registerShowIndexStatusCommand(),
      this.registerReviewCallGraphCommand(),
      this.registerGetContextCommand(), // For E2E testing
    ];
  }

  private registerShowGraphCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('graph-it-live.showGraph', async () => {
      try {
        await vscode.commands.executeCommand('graph-it-live.graphView.focus');
      } catch (error) {
        this.handleCommandError('graph-it-live.showGraph', error, 'Graph-It-Live: Could not focus the graph');
      }
    });
  }

  private registerToggleUnusedFilterCommands(): vscode.Disposable {
    const d1 = this.registerProviderCommand(
      'graph-it-live.enableUnusedFilter',
      async () => {
        await this.commandCoordinator.handleEnableUnusedFilter();
      },
      'Graph-It-Live: Enable filter failed'
    );
    const d2 = this.registerProviderCommand(
      'graph-it-live.disableUnusedFilter',
      async () => {
        await this.commandCoordinator.handleDisableUnusedFilter();
      },
      'Graph-It-Live: Disable filter failed'
    );
    return vscode.Disposable.from(d1, d2);
  }

  private registerForceReindexCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.forceReindex',
      async () => {
        await this.commandCoordinator.handleForceReindex();
      },
      'Graph-It-Live: Re-index failed'
    );
  }

  private registerExpandAllCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.expandAllNodes',
      async () => {
        await this.commandCoordinator.handleExpandAll();
      },
      'Graph-It-Live: Toggle expand all failed'
    );
  }

  private registerRefreshGraphCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.refreshGraph',
      async () => {
        await this.commandCoordinator.handleRefreshGraph();
      },
      'Graph-It-Live: Refresh failed'
    );
  }
  /**
   * Register toggleViewMode command for backward compatibility
   * Toggles between file and symbol views (skips list view)
   */
  private registerToggleViewModeCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.toggleViewMode',
      async () => {
        await this.commandCoordinator.handleToggleViewMode();
      },
      'Graph-It-Live: Toggle view mode failed'
    );
  }
  private registerSetViewModeFileCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.setViewModeFile',
      async () => {
        await this.commandCoordinator.handleSetViewModeFile();
      },
      'Graph-It-Live: Switch to file view failed'
    );
  }

  private registerSetViewModeListCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.setViewModeList',
      async () => {
        await this.commandCoordinator.handleSetViewModeList();
      },
      'Graph-It-Live: Switch to list view failed'
    );
  }

  private registerSetViewModeSymbolCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.setViewModeSymbol',
      async () => {
        await this.commandCoordinator.handleSetViewModeSymbol();
      },
      'Graph-It-Live: Switch to symbol view failed'
    );
  }

  private registerSetViewModeArchitectureCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.setViewModeArchitecture',
      async () => {
        await this.commandCoordinator.handleSetViewModeArchitecture();
      },
      'Graph-It-Live: Switch to architecture view failed'
    );
  }

  private registerShowReverseDependenciesCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.showReverseDependencies',
      async () => {
        await this.commandCoordinator.handleShowReverseDependencies();
      },
      'Graph-It-Live: Show reverse dependencies failed'
    );
  }

  private registerHideReverseDependenciesCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.hideReverseDependencies',
      async () => {
        await this.commandCoordinator.handleHideReverseDependencies();
      },
      'Graph-It-Live: Hide reverse dependencies failed'
    );
  }

  private registerShowIndexStatusCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('graph-it-live.showIndexStatus', async () => {
      try {
        await this.commandCoordinator.handleShowIndexStatus();
      } catch (error) {
        this.handleCommandError(
          'graph-it-live.showIndexStatus',
          error,
          'Graph-It-Live: Could not get index status'
        );
      }
    });
  }

  private registerReviewCallGraphCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('graph-it-live.reviewCallGraph', async (target: unknown) => {
      try {
        const value = validateReviewCallGraphTarget(target);
        await this.provider.showReviewCallGraph(value.file, value.symbol, value.depth);
      } catch (error) {
        this.handleCommandError('graph-it-live.reviewCallGraph', error, 'Graph-It-Live: Invalid review link');
      }
    });
  }

  /**
   * Registers a test helper command to get context key values
   * This is needed for E2E testing as VS Code doesn't expose context keys directly
   */
  private registerGetContextCommand(): vscode.Disposable {
    const architecture = () => this.provider.getArchitectureE2EState();
    // Context keys are stored in VS Code's internal state, so GraphProvider tracks the ones tests read.
    const getters = new Map<string, () => unknown>([
      ['graph-it-live.viewMode', () => this.provider.getViewMode()],
      ['graph-it-live.reverseDependenciesVisible', () => this.provider.getReverseDependenciesVisible()],
      ['graph-it-live.callGraphRenderCount', () => this.provider.getCallGraphRenderCount()],
      ['graph-it-live.callGraphNodeCount', () => this.provider.getCallGraphNodeCount()],
      ['graph-it-live.callGraphEdgeCount', () => this.provider.getCallGraphEdgeCount()],
      ['graph-it-live.callGraphCycleCount', () => this.provider.getCallGraphCycleCount()],
      ['graph-it-live.fileGraphNodeMetadata', () => this.provider.getFileGraphNodeMetadata()],
      ['graph-it-live.architectureRenderCount', () => architecture()?.renderCount ?? 0],
      ['graph-it-live.architectureGroupCount', () => architecture()?.groupCount ?? 0],
      ['graph-it-live.architectureGroupEdgeCount', () => architecture()?.groupEdgeCount ?? 0],
      ['graph-it-live.architectureRevision', () => architecture()?.revision],
      ['graph-it-live.architectureBuildCount', () => architecture()?.buildCount ?? 0],
      ['graph-it-live.architectureCommunityMode', () => architecture()?.communityMode],
      ['graph-it-live.architectureStale', () => architecture()?.stale ?? false],
      ['graph-it-live.architectureResizeCount', () => architecture()?.resizeCount ?? 0],
      ['graph-it-live.architectureViewSize', () => architecture()?.viewSize],
    ]);
    // Unknown keys return undefined.
    return vscode.commands.registerCommand('getContext', (key: string) => getters.get(key)?.());
  }

  private registerProviderCommand(
    commandId: string,
    handler: () => Promise<void>,
    errorMessage: string
  ): vscode.Disposable {
    return vscode.commands.registerCommand(commandId, async () => {
      try {
        await handler();
      } catch (error) {
        this.handleCommandError(commandId, error, errorMessage);
      }
    });
  }

  private handleCommandError(commandId: string, error: unknown, userMessage: string): void {
    this.logger.error(`${commandId} failed:`, error);
    vscode.window.showErrorMessage(userMessage);
  }
}
