import { SUPPORTED_SOURCE_FILE_REGEX } from "../../shared/constants";
import type {
    SetExpandAllMessage,
    SwitchModeMessage,
    WebviewLogMessage,
    WebviewToExtensionMessage,
} from "../../shared/types";
import { extensionLoggerManager } from "../extensionLogger";
import type { GraphState } from "./GraphState";
import { WebviewMessageRouter } from "./WebviewMessageRouter";

interface MessageDispatcherDependencies {
  graphState: GraphState;
  getUnusedFilterActive(): boolean;
  toggleUnusedFilter(): Promise<void>;
  handleOpenFile(filePath: string, line?: number): Promise<void>;
  handleExpandNode(nodeId: string, knownNodes?: string[]): Promise<void>;
  handleCancelExpandNode(nodeId?: string): Promise<void>;
  handleFindReferencingFiles(nodeId: string): Promise<void>;
  handleDrillDown(filePath: string): Promise<void>;
  updateGraph(): Promise<void>;
  refreshGraph(): Promise<void>;
  handleSelectSymbol(symbolId: string | undefined): Promise<void>;
  sendGraphUpdate(filePath: string, isRefresh?: boolean): Promise<void>;
  setViewMode(mode: "file" | "list" | "symbol"): Promise<void>;
  getViewMode(): "file" | "list" | "symbol";
  getSelectedSymbolId(): string | undefined;
  setSelectedSymbolId(symbolId: string | undefined): void;
  getLastActiveFilePath(): string | undefined;
  parseFilePathAndSymbol(symbolId: string): { actualFilePath: string } | undefined;
  getActiveEditorFilePath(): string | undefined;
  logger: { debug: (message: string, ...args: unknown[]) => void };
}

export class MessageDispatcher {
  private readonly router: WebviewMessageRouter;
  private readonly deps: MessageDispatcherDependencies;

  constructor(deps: MessageDispatcherDependencies) {
    this.deps = deps;
    this.router = new WebviewMessageRouter({
      logger: deps.logger,
      handlers: {
        openFile: async (m) => {
          if (m.path) await deps.handleOpenFile(m.path, m.line);
        },
        expandNode: async (m) => {
          if (m.nodeId) await deps.handleExpandNode(m.nodeId, m.knownNodes);
        },
        cancelExpandNode: async (m) => {
          await deps.handleCancelExpandNode(m.nodeId);
        },
        setExpandAll: async (m) => {
          await this.handleSetExpandAll(m);
        },
        refreshGraph: async () => {
          await deps.refreshGraph();
        },
        findReferencingFiles: async (m) => {
          if (m.nodeId) await deps.handleFindReferencingFiles(m.nodeId);
        },
        drillDown: async (m) => {
          if (m.filePath) await deps.handleDrillDown(m.filePath);
        },
        ready: async () => {
          deps.logger.debug("Webview ready, sending initial graph");
          await deps.updateGraph();
        },
        webviewLog: async (m) => {
          await this.forwardWebviewLog(m);
        },
        switchMode: async (m) => {
          await this.handleSwitchMode(m);
        },
        enableUnusedFilter: async () => {
          if (!deps.getUnusedFilterActive()) {
            await deps.toggleUnusedFilter();
          }
        },
        disableUnusedFilter: async () => {
          if (deps.getUnusedFilterActive()) {
            await deps.toggleUnusedFilter();
          }
        },
        selectSymbol: async (m) => {
          await deps.handleSelectSymbol(m.symbolId);
        },
        navigateToSymbol: async (m) => {
          if (m.filePath && m.line) {
            await deps.handleOpenFile(m.filePath, m.line);
          }
        },
      },
    });
  }

  async handle(message: WebviewToExtensionMessage): Promise<void> {
    await this.router.handle(message);
  }

  private async handleSetExpandAll(message: SetExpandAllMessage): Promise<void> {
    this.deps.logger.debug("Setting expandAll to", message.expandAll);
    await this.deps.graphState.setExpandAll(message.expandAll);
  }

  private async handleSwitchMode(message: SwitchModeMessage): Promise<void> {
    this.deps.logger.debug("Switching to", message.mode, "mode");

    if (message.mode === "file") {
      const previousSymbolId = this.deps.getSelectedSymbolId();
      await this.deps.setViewMode("file");
      this.deps.setSelectedSymbolId(undefined);

      const fallbackLastFile = this.deps.getLastActiveFilePath();
      const candidate = previousSymbolId
        ? this.deps.parseFilePathAndSymbol(previousSymbolId)?.actualFilePath
        : undefined;
      const targetFilePath = candidate || fallbackLastFile;

      if (targetFilePath && SUPPORTED_SOURCE_FILE_REGEX.test(targetFilePath)) {
        await this.deps.sendGraphUpdate(targetFilePath, false);
        return;
      }

      await this.deps.updateGraph();
      return;
    }

    if (message.mode === "symbol") {
      const filePath = this.deps.getActiveEditorFilePath();
      if (filePath) {
        await this.deps.handleDrillDown(filePath);
      }
    }
  }

  private async forwardWebviewLog(message: WebviewLogMessage): Promise<void> {
    const level = message.level ?? "info";
    const msg = message.message ?? "";
    const args = message.args ?? [];
    const webviewLogger = extensionLoggerManager.getLogger("Webview");
    switch (level) {
      case "debug":
        webviewLogger.debug(msg, ...args);
        break;
      case "info":
        webviewLogger.info(msg, ...args);
        break;
      case "warn":
        webviewLogger.warn(msg, ...args);
        break;
      case "error":
        webviewLogger.error(msg, ...args);
        break;
    }
  }
}
