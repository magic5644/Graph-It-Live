/**
 * CLI Runtime
 *
 * Manages workspace initialization, Spider lifecycle, cache, and .graph-it/ state.
 * Mirrors the McpWorker pattern but runs in the CLI main process.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AstWorkerHost } from "../analyzer/ast/AstWorkerHost";
import { IndexCache, restoreOrBuildIndex } from "../analyzer/cache/IndexCache";
import { Parser } from "../analyzer/Parser";
import { SourceFileCollector } from "../analyzer/SourceFileCollector";
import { SpiderBuilder } from "../analyzer/SpiderBuilder";
import { PathResolver } from "../analyzer/utils/PathResolver";
import { workerState } from "../mcp/shared/state";
import {
  getLogger,
  getLogLevelFromEnv,
  loggerFactory,
  setLoggerBackend,
  StderrLogger,
} from "../shared/logger";
import { CliError, ExitCode } from "./errors";
import { ErrorCollectorBackend, type CollectedLogEntry } from "./errorCollector";

// Send all logs to stderr so stdout stays clean for data output
setLoggerBackend({
  createLogger(prefix: string, level) {
    return new StderrLogger(prefix, level);
  },
});
loggerFactory.setDefaultLevel(getLogLevelFromEnv("LOG_LEVEL"));

const log = getLogger("CliRuntime");

/** Persisted state written to .graph-it/state.json */
export interface CliState {
  lastScanTimestamp?: string;
  filesIndexed?: number;
  workspaceRoot: string;
}

/** What one ensureIndexed() call actually did. */
export interface IndexOutcome {
  /** Source files held in the index once this run finished. */
  filesIndexed: number;
  /** Source files discovered on disk for this workspace. */
  filesFound: number;
  /** Files parsed during this run — 0 on a fully warm cache hit. */
  filesAnalyzed: number;
  /** Whether the index was restored from .graph-it/cache/ rather than rebuilt. */
  fromCache: boolean;
  /** Wall-clock time spent in ensureIndexed(). */
  durationMs: number;
}

/**
 * Locate the workspace root by searching upward for package.json or tsconfig.json.
 * Falls back to cwd().
 */
export function findWorkspaceRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);

  while (dir !== root) {
    if (
      fs.existsSync(path.join(dir, "package.json")) ||
      fs.existsSync(path.join(dir, "tsconfig.json"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  // Fallback to the original startDir
  return path.resolve(startDir);
}

/**
 * Find tsconfig.json in the given directory, or null.
 */
function findTsConfig(rootDir: string): string | undefined {
  const tsConfigPath = path.join(rootDir, "tsconfig.json");
  return fs.existsSync(tsConfigPath) ? tsConfigPath : undefined;
}

/**
 * CliRuntime owns the full analysis lifecycle for CLI usage.
 */
export class CliRuntime {
  readonly workspaceRoot: string;
  private readonly stateDir: string;
  private readonly cacheEnabled: boolean;
  private _initialized = false;
  private _indexReady = false;
  private _sourceFiles: string[] | null = null;
  private indexCache: IndexCache | null = null;
  private errorCollectorBackend: ErrorCollectorBackend | null = null;

  constructor(workspaceRoot: string, options?: { cache?: boolean }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.stateDir = path.join(this.workspaceRoot, ".graph-it");
    this.cacheEnabled = (options?.cache ?? true) && !process.env.GRAPH_IT_NO_CACHE;
  }

  /** Delete the persisted index cache. Backs the `--reindex` flag. */
  clearCache(): void {
    new IndexCache(this.workspaceRoot, []).clear();
  }

  /** Whether the runtime has been initialized (Spider built + index ready) */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Enable silent error collection mode.
   * All log output goes to in-memory collector instead of stderr.
   * Call disableErrorCollection() to restore normal logging and retrieve errors.
   */
  enableErrorCollection(): void {
    if (this.errorCollectorBackend) {
      return; // Already enabled
    }
    this.errorCollectorBackend = new ErrorCollectorBackend();
    setLoggerBackend(this.errorCollectorBackend);
  }

  /**
   * Disable error collection and restore normal stderr logging.
   * Returns all collected log entries.
   */
  disableErrorCollection(): CollectedLogEntry[] {
    if (!this.errorCollectorBackend) {
      return [];
    }
    const entries = this.errorCollectorBackend.getCollectedEntries();
    // Restore StderrLogger backend
    setLoggerBackend({
      createLogger(prefix: string, level) {
        return new StderrLogger(prefix, level);
      },
    });
    this.errorCollectorBackend = null;
    return entries;
  }

  /**
   * Get currently collected log entries (without stopping collection).
   */
  getCollectedErrors(): CollectedLogEntry[] {
    return this.errorCollectorBackend?.getCollectedEntries() ?? [];
  }

  /**
   * Clear all collected log entries.
   */
  clearCollectedErrors(): void {
    this.errorCollectorBackend?.clear();
  }

  /**
   * Initialize the runtime: build Spider, start AstWorker, etc.
   * Does NOT perform indexing — call ensureIndexed() for that.
   */
  async init(): Promise<void> {
    if (this._initialized) return;

    // Ensure .graph-it/ exists
    fs.mkdirSync(this.stateDir, { recursive: true });

    const tsConfigPath = findTsConfig(this.workspaceRoot);

    // Initialize Parser & PathResolver (stored on workerState for tool reuse)
    workerState.parser = new Parser();
    workerState.resolver = new PathResolver(
      tsConfigPath,
      true, // excludeNodeModules
      this.workspaceRoot,
    );

    // In the CLI bundle, __dirname = dist/, so path.resolve(__dirname, '..') is the
    // package root — used to locate dist/wasm/*.wasm and dist/queries/*.scm for all
    // WASM-based language parsers (Python, Rust, Go, Java, C#) and the call graph.
    const cliExtensionPath = path.resolve(__dirname, '..');

    // AstWorkerHost:
    //   - First arg (workerPath): undefined → uses default dist/astWorker.js resolution
    //   - Second arg (extensionPath): cliExtensionPath → enables WASM parsers for
    //     Python/Rust symbol extraction (tree-sitter-python.wasm, tree-sitter-rust.wasm)
    workerState.astWorkerHost = new AstWorkerHost(undefined, cliExtensionPath);
    await workerState.astWorkerHost.start();

    // Build Spider via SpiderBuilder
    // extensionPath is required for LanguageService to locate WASM files for
    // Python, Rust, Go, Java, and C# parsers used during file-level dependency analysis.
    const builder = new SpiderBuilder()
      .withRootDir(this.workspaceRoot)
      .withMaxDepth(50)
      .withExcludeNodeModules(true)
      .withReverseIndex(true)
      .withExtensionPath(cliExtensionPath);

    if (tsConfigPath) {
      builder.withTsConfigPath(tsConfigPath);
    }

    workerState.spider = builder.build();
    if (this.cacheEnabled) {
      this.indexCache = new IndexCache(this.workspaceRoot, await this.collectSourceFiles());
      workerState.indexCache = this.indexCache;
    }
    workerState.config = {
      rootDir: this.workspaceRoot,
      tsConfigPath,
      excludeNodeModules: true,
      maxDepth: 50,
      extensionPath: cliExtensionPath,
    };
    workerState.isReady = true;
    this._initialized = true;

    log.info("Runtime initialized for", this.workspaceRoot);
  }

  /**
   * Ensure the workspace is indexed (warmup / full build).
   * Streams progress to stderr.
   */
  async ensureIndexed(options?: { silent?: boolean }): Promise<IndexOutcome> {
    if (!this._initialized || !workerState.spider) {
      throw new CliError(
        "Runtime not initialized. Call init() first.",
        ExitCode.WORKSPACE_NOT_FOUND,
      );
    }

    if (this._indexReady) {
      const warm = workerState.warmupInfo;
      return {
        filesIndexed: warm?.filesIndexed ?? 0,
        filesFound: warm?.filesFound ?? warm?.filesIndexed ?? 0,
        filesAnalyzed: warm?.filesAnalyzed ?? 0,
        fromCache: warm?.fromCache ?? false,
        durationMs: warm?.durationMs ?? 0,
      };
    }

    const spider = workerState.spider;
    const startTime = Date.now();
    const silent = options?.silent ?? false;
    // Names the work actually in progress: a warm run re-analyzes only the files
    // that changed, and calling that "Indexing" over the whole workspace count
    // would misreport where the answers come from.
    let progressLabel = "Indexing";

    const unsubscribe = spider.subscribeToIndexStatus((snapshot) => {
      // total === 0 means there is nothing to do — printing "0/0" reads as a bug.
      if (!silent && snapshot.state === "indexing" && snapshot.total > 0) {
        process.stderr.write(
          `\r  ${progressLabel}: ${snapshot.processed}/${snapshot.total} files...`,
        );
      }
    });

    try {
      const result = await restoreOrBuildIndex(spider, {
        cache: this.indexCache,
        reverseIndexOptions: { excludeNodeModules: true, ignoreTypeImports: false },
        sourceFiles: this.indexCache ? await this.collectSourceFiles() : undefined,
        buildFullIndex: () => {
          if (!silent) process.stderr.write("\r  Indexing workspace...");
          return spider.buildFullIndex();
        },
        onWait: (holderPid) => {
          if (!silent) {
            process.stderr.write(`  Waiting for the index being built by process ${holderPid ?? "?"}...\n`);
          }
        },
        onReindexStart: () => {
          progressLabel = "Re-indexing changed";
        },
      });

      const durationMs = Date.now() - startTime;
      if (!silent) {
        process.stderr.write(this.describeOutcome(result) + "\n");
      }
      log.info(
        `${result.fromCache ? "Cache" : "Index"}: ${result.filesIndexed} files,`,
        `${result.filesAnalyzed} analyzed in ${durationMs}ms`,
      );

      this.saveState({
        lastScanTimestamp: new Date().toISOString(),
        filesIndexed: result.filesIndexed,
        workspaceRoot: this.workspaceRoot,
      });

      const { cancelled: _cancelled, ...outcome } = result;
      workerState.warmupInfo = { completed: true, durationMs, ...outcome };
      this._indexReady = true;

      return { ...outcome, durationMs };
    } finally {
      unsubscribe();
    }
  }

  /** One-line stderr summary naming where this run's index came from. */
  private describeOutcome(result: Omit<IndexOutcome, "durationMs">): string {
    if (!result.fromCache) {
      return `\r  Indexed ${result.filesIndexed}/${result.filesFound} files`;
    }
    if (result.filesAnalyzed === 0) {
      return `\r  Loaded ${result.filesIndexed} files from cache (nothing changed)`;
    }
    return `\r  Loaded ${result.filesIndexed} files from cache, re-indexed ${result.filesAnalyzed} changed`;
  }

  /** Walk the workspace once per process and memoize the result. */
  private async collectSourceFiles(): Promise<string[]> {
    this._sourceFiles ??= await new SourceFileCollector({
      excludeNodeModules: true,
      yieldIntervalMs: 30,
      isCancelled: () => false,
    }).collectAllSourceFiles(this.workspaceRoot);
    return this._sourceFiles;
  }

  /**
   * Dispose all resources.
   */
  async dispose(): Promise<void> {
    if (workerState.astWorkerHost) {
      await workerState.astWorkerHost.stop();
    }
    if (workerState.spider) {
      await workerState.spider.dispose();
    }
    workerState.reset();
    this._initialized = false;
    this._indexReady = false;
  }

  // ============================================================================
  // .graph-it/state.json persistence
  // ============================================================================

  private saveState(state: CliState): void {
    try {
      fs.writeFileSync(
        path.join(this.stateDir, "state.json"),
        JSON.stringify(state, null, 2),
      );
    } catch (err) {
      log.warn("Could not save state:", err instanceof Error ? err.message : String(err));
    }
  }

  loadState(): CliState | null {
    try {
      const raw = fs.readFileSync(path.join(this.stateDir, "state.json"), "utf-8");
      return JSON.parse(raw) as CliState;
    } catch {
      return null;
    }
  }
}
