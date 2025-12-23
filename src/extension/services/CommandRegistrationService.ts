import * as vscode from 'vscode';
import type { GraphProvider } from '../GraphProvider';
import type { VsCodeLogger } from '../extensionLogger';

interface CommandRegistrationServiceOptions {
  provider: GraphProvider;
  logger: VsCodeLogger;
}

/**
 * Centralizes VS Code command registration to keep extension.ts lean
 * and ensure consistent error handling/logging.
 */
export class CommandRegistrationService {
  private readonly provider: GraphProvider;
  private readonly logger: VsCodeLogger;

  constructor(options: CommandRegistrationServiceOptions) {
    this.provider = options.provider;
    this.logger = options.logger;
  }

  registerAll(): vscode.Disposable[] {
    return [
      this.registerShowGraphCommand(),
      this.registerForceReindexCommand(),
      this.registerExpandAllCommand(),
      this.registerRefreshGraphCommand(),
      this.registerToggleViewCommand(),
      this.registerToggleUnusedFilterCommands(),
      this.registerShowIndexStatusCommand(),
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
        // Enforce state to true
        if (!this.provider.getUnusedFilterActive()) {
            await this.provider.toggleUnusedFilter();
        }
      },
      'Graph-It-Live: Enable filter failed'
    );
    const d2 = this.registerProviderCommand(
      'graph-it-live.disableUnusedFilter',
      async () => {
        // Enforce state to false
        if (this.provider.getUnusedFilterActive()) {
            await this.provider.toggleUnusedFilter();
        }
      },
      'Graph-It-Live: Disable filter failed'
    );
    return vscode.Disposable.from(d1, d2);
  }

  private registerForceReindexCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.forceReindex',
      async () => {
        await this.provider.forceReindex();
        vscode.window.showInformationMessage('Graph-It-Live: Re-index triggered');
      },
      'Graph-It-Live: Re-index failed'
    );
  }

  private registerExpandAllCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.expandAllNodes',
      async () => {
        await this.provider.expandAllNodes();
      },
      'Graph-It-Live: Toggle expand all failed'
    );
  }

  private registerRefreshGraphCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.refreshGraph',
      async () => {
        await this.provider.refreshGraph();
      },
      'Graph-It-Live: Refresh failed'
    );
  }

  private registerToggleViewCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'graph-it-live.toggleViewMode',
      async () => {
        await this.provider.toggleViewMode();
      },
      'Graph-It-Live: Toggle view failed'
    );
  }

  private registerShowIndexStatusCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('graph-it-live.showIndexStatus', async () => {
      try {
        const status = this.provider.getIndexStatus();
        if (status) {
          const message = `Indexer: ${status.state} ${status.processed}/${status.total} (${status.percentage}%)`;
          vscode.window.showInformationMessage(message);
        } else {
          vscode.window.showInformationMessage('Graph-It-Live: No indexer available');
        }
      } catch (error) {
        this.handleCommandError(
          'graph-it-live.showIndexStatus',
          error,
          'Graph-It-Live: Could not get index status'
        );
      }
    });
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
