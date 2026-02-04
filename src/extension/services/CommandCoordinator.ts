import type { IndexerStatusSnapshot } from "../../analyzer/IndexerStatus";

export interface CommandUi {
  showInformationMessage(message: string): Thenable<string | undefined> | void;
}

export interface CommandCoordinatorDependencies {
  forceReindex(): Promise<void>;
  expandAllNodes(): Promise<{ expanded: boolean; message: string }>;
  refreshGraph(): Promise<void>;
  toggleViewMode(): Promise<{ mode: "file" | "list" | "symbol"; message: string }>;
  setViewModeFile(): Promise<void>;
  setViewModeList(): Promise<void>;
  setViewModeSymbol(): Promise<void>;
  showReverseDependencies(): Promise<void>;
  hideReverseDependencies(): Promise<void>;
  getUnusedFilterActive(): boolean;
  toggleUnusedFilter(): Promise<void>;
  getIndexStatus(): IndexerStatusSnapshot | null;
}

interface CommandCoordinatorOptions {
  provider: CommandCoordinatorDependencies;
  ui: CommandUi;
}

export class CommandCoordinator {
  private readonly provider: CommandCoordinatorDependencies;
  private readonly ui: CommandUi;

  constructor(options: CommandCoordinatorOptions) {
    this.provider = options.provider;
    this.ui = options.ui;
  }

  async handleForceReindex(): Promise<void> {
    await this.provider.forceReindex();
    this.ui.showInformationMessage("Graph-It-Live: Re-index triggered");
  }

  async handleExpandAll(): Promise<void> {
    await this.provider.expandAllNodes();
  }

  async handleRefreshGraph(): Promise<void> {
    await this.provider.refreshGraph();
  }

  async handleToggleViewMode(): Promise<void> {
    await this.provider.toggleViewMode();
  }

  async handleSetViewModeFile(): Promise<void> {
    await this.provider.setViewModeFile();
  }

  async handleSetViewModeList(): Promise<void> {
    await this.provider.setViewModeList();
  }

  async handleSetViewModeSymbol(): Promise<void> {
    await this.provider.setViewModeSymbol();
  }

  async handleShowReverseDependencies(): Promise<void> {
    await this.provider.showReverseDependencies();
  }

  async handleHideReverseDependencies(): Promise<void> {
    await this.provider.hideReverseDependencies();
  }

  async handleEnableUnusedFilter(): Promise<void> {
    if (!this.provider.getUnusedFilterActive()) {
      await this.provider.toggleUnusedFilter();
    }
  }

  async handleDisableUnusedFilter(): Promise<void> {
    if (this.provider.getUnusedFilterActive()) {
      await this.provider.toggleUnusedFilter();
    }
  }

  async handleShowIndexStatus(): Promise<void> {
    const status = this.provider.getIndexStatus();
    if (status) {
      const message = `Indexer: ${status.state} ${status.processed}/${status.total} (${status.percentage}%)`;
      this.ui.showInformationMessage(message);
    } else {
      this.ui.showInformationMessage("Graph-It-Live: No indexer available");
    }
  }
}
