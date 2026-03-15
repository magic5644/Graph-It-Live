/**
 * MCP Worker State Management
 *
 * Centralized state container for worker thread lifecycle,
 * configuration, and core analysis components.
 *
 * Extracted from McpWorker.ts to reduce complexity and improve testability.
 */

import type { FSWatcher } from "chokidar";
import type { AstWorkerHost } from "../../analyzer/ast/AstWorkerHost";
import type { CallGraphIndexer } from "../../analyzer/callgraph/CallGraphIndexer";
import type { GraphExtractor } from "../../analyzer/callgraph/GraphExtractor";
import type { Parser } from "../../analyzer/Parser";
import type { Spider } from "../../analyzer/Spider";
import type { SymbolReverseIndex } from "../../analyzer/SymbolReverseIndex";
import type { PathResolver } from "../../analyzer/utils/PathResolver";
import type { McpWorkerConfig } from "../types";

/**
 * Warmup completion status
 */
export interface WarmupInfo {
  completed: boolean;
  durationMs?: number;
  filesIndexed?: number;
}

/**
 * Core worker state container
 */
export class WorkerState {
  private _spider: Spider | null = null;
  private _parser: Parser | null = null;
  private _resolver: PathResolver | null = null;
  private _astWorkerHost: AstWorkerHost | null = null;
  private _symbolReverseIndex: SymbolReverseIndex | null = null;
  private _config: McpWorkerConfig | null = null;
  private _isReady = false;
  private _warmupInfo: WarmupInfo = {
    completed: false,
  };
  private _fileWatcher: FSWatcher | null = null;
    private readonly _pendingInvalidations = new Map<string, NodeJS.Timeout>();
  private _callGraphIndexer: CallGraphIndexer | null = null;
  private _graphExtractor: GraphExtractor | null = null;
  private _callGraphIndexedRoot: string | null = null;

  // ============================================================================
  // Core Components
  // ============================================================================

  get spider(): Spider | null {
    return this._spider;
  }

  set spider(value: Spider | null) {
    this._spider = value;
  }

  get parser(): Parser | null {
    return this._parser;
  }

  set parser(value: Parser | null) {
    this._parser = value;
  }

  get resolver(): PathResolver | null {
    return this._resolver;
  }

  set resolver(value: PathResolver | null) {
    this._resolver = value;
  }

  get astWorkerHost(): AstWorkerHost | null {
    return this._astWorkerHost;
  }

  set astWorkerHost(value: AstWorkerHost | null) {
    this._astWorkerHost = value;
  }

  get symbolReverseIndex(): SymbolReverseIndex | null {
    return this._symbolReverseIndex;
  }

  set symbolReverseIndex(value: SymbolReverseIndex | null) {
    this._symbolReverseIndex = value;
  }

  // ============================================================================
  // Call Graph Components
  // ============================================================================

  get callGraphIndexer(): CallGraphIndexer | null {
    return this._callGraphIndexer;
  }

  set callGraphIndexer(value: CallGraphIndexer | null) {
    this._callGraphIndexer = value;
  }

  get graphExtractor(): GraphExtractor | null {
    return this._graphExtractor;
  }

  set graphExtractor(value: GraphExtractor | null) {
    this._graphExtractor = value;
  }

  get callGraphIndexedRoot(): string | null {
    return this._callGraphIndexedRoot;
  }

  set callGraphIndexedRoot(value: string | null) {
    this._callGraphIndexedRoot = value;
  }

  // ============================================================================
  // Configuration & Status
  // ============================================================================

  get config(): McpWorkerConfig | null {
    return this._config;
  }

  set config(value: McpWorkerConfig | null) {
    this._config = value;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  set isReady(value: boolean) {
    this._isReady = value;
  }

  get warmupInfo(): WarmupInfo {
    return this._warmupInfo;
  }

  set warmupInfo(value: WarmupInfo) {
    this._warmupInfo = value;
  }

  // ============================================================================
  // File Watching
  // ============================================================================

  get fileWatcher(): FSWatcher | null {
    return this._fileWatcher;
  }

  set fileWatcher(value: FSWatcher | null) {
    this._fileWatcher = value;
  }

  get pendingInvalidations(): Map<string, NodeJS.Timeout> {
    return this._pendingInvalidations;
  }

  // ============================================================================
  // Validation Methods
  // ============================================================================

  /**
   * Check if core analysis components are initialized
   * @throws Error if components not ready
   */
  requireReady(): void {
      if (!this._isReady || !this._spider || !this._parser || !this._resolver || !this._config) {
      throw new Error(
        "Worker not initialized. Call init() first. Missing: " +
          [
            !this._spider && "spider",
            !this._parser && "parser",
            !this._resolver && "resolver",
              !this._config && "config",
            !this._isReady && "ready flag",
          ]
            .filter(Boolean)
            .join(", ")
      );
    }
  }

  /**
   * Get spider instance (throws if not initialized)
   */
  getSpider(): Spider {
    this.requireReady();
    // requireReady() guarantees non-null; local alias helps TS narrow
    const spider = this._spider;
    if (!spider) throw new Error("Spider not available after requireReady()");
    return spider;
  }

  /**
   * Get parser instance (throws if not initialized)
   */
  getParser(): Parser {
    this.requireReady();
    const parser = this._parser;
    if (!parser) throw new Error("Parser not available after requireReady()");
    return parser;
  }

  /**
   * Get resolver instance (throws if not initialized)
   */
  getResolver(): PathResolver {
    this.requireReady();
    const resolver = this._resolver;
    if (!resolver) throw new Error("Resolver not available after requireReady()");
    return resolver;
  }

  /**
   * Get AST worker host instance (throws if not initialized)
   */
  getAstWorkerHost(): AstWorkerHost {
    if (!this._astWorkerHost) {
      throw new Error("AstWorkerHost not initialized");
    }
    return this._astWorkerHost;
  }

  /**
   * Get config (throws if not initialized)
   */
  getConfig(): McpWorkerConfig {
    if (!this._config) {
      throw new Error("Config not set. Call init() first.");
    }
    return this._config;
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Reset all state (for shutdown or re-initialization)
   */
  reset(): void {
    // Clear pending invalidations
    for (const timeout of this._pendingInvalidations.values()) {
      clearTimeout(timeout);
    }
    this._pendingInvalidations.clear();

    // Stop file watcher
    if (this._fileWatcher) {
      void this._fileWatcher.close();
      this._fileWatcher = null;
    }

    // Terminate AST worker
    if (this._astWorkerHost) {
      void this._astWorkerHost.stop();
      this._astWorkerHost = null;
    }

    this._symbolReverseIndex = null;

    // Dispose call graph resources
    if (this._graphExtractor) {
      this._graphExtractor.dispose();
      this._graphExtractor = null;
    }
    if (this._callGraphIndexer) {
      this._callGraphIndexer.dispose();
      this._callGraphIndexer = null;
    }
    this._callGraphIndexedRoot = null;

    // Clear components
    this._spider = null;
    this._parser = null;
    this._resolver = null;
    this._config = null;
    this._isReady = false;
    this._warmupInfo = { completed: false };
  }

  /**
   * Get current state summary (for debugging/logging)
   */
  getStateSummary(): {
    isReady: boolean;
    hasSpider: boolean;
    hasParser: boolean;
    hasResolver: boolean;
    hasAstWorkerHost: boolean;
    hasSymbolReverseIndex: boolean;
    hasConfig: boolean;
    warmupCompleted: boolean;
    hasFileWatcher: boolean;
    pendingInvalidationCount: number;
    hasCallGraphIndexer: boolean;
    callGraphIndexedRoot: string | null;
  } {
    return {
      isReady: this._isReady,
      hasSpider: this._spider !== null,
      hasParser: this._parser !== null,
      hasResolver: this._resolver !== null,
      hasAstWorkerHost: this._astWorkerHost !== null,
      hasSymbolReverseIndex: this._symbolReverseIndex !== null,
      hasConfig: this._config !== null,
      warmupCompleted: this._warmupInfo.completed,
      hasFileWatcher: this._fileWatcher !== null,
      pendingInvalidationCount: this._pendingInvalidations.size,
      hasCallGraphIndexer: this._callGraphIndexer !== null,
      callGraphIndexedRoot: this._callGraphIndexedRoot,
    };
  }
}

/**
 * Singleton worker state instance
 */
export const workerState = new WorkerState();
