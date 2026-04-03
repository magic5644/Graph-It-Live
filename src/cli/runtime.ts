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
import { Parser } from "../analyzer/Parser";
import { SpiderBuilder } from "../analyzer/SpiderBuilder";
import { PathResolver } from "../analyzer/utils/PathResolver";
import { workerState } from "../mcp/shared/state";
import {
  getLogLevelFromEnv,
  loggerFactory,
  setLoggerBackend,
  StderrLogger,
  getLogger,
} from "../shared/logger";
import { CliError, ExitCode } from "./errors";

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
  private _initialized = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.stateDir = path.join(this.workspaceRoot, ".graph-it");
  }

  /** Whether the runtime has been initialized (Spider built + index ready) */
  get initialized(): boolean {
    return this._initialized;
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

    // AstWorkerHost:
    //   - First arg (workerPath): undefined → uses default dist/astWorker.js resolution
    //   - Second arg (extensionPath): undefined → acceptable for CLI since WASM files are
    //     co-located in the same dist/ directory as the CLI binary (resolved via __dirname)
    workerState.astWorkerHost = new AstWorkerHost(undefined, undefined);
    await workerState.astWorkerHost.start();

    // Build Spider via SpiderBuilder
    const builder = new SpiderBuilder()
      .withRootDir(this.workspaceRoot)
      .withMaxDepth(50)
      .withExcludeNodeModules(true)
      .withReverseIndex(true);

    if (tsConfigPath) {
      builder.withTsConfigPath(tsConfigPath);
    }

    workerState.spider = builder.build();
    workerState.config = {
      rootDir: this.workspaceRoot,
      tsConfigPath,
      excludeNodeModules: true,
      maxDepth: 50,
    };
    workerState.isReady = true;
    this._initialized = true;

    log.info("Runtime initialized for", this.workspaceRoot);
  }

  /**
   * Ensure the workspace is indexed (warmup / full build).
   * Streams progress to stderr.
   */
  async ensureIndexed(): Promise<{ filesIndexed: number; durationMs: number }> {
    if (!this._initialized || !workerState.spider) {
      throw new CliError(
        "Runtime not initialized. Call init() first.",
        ExitCode.WORKSPACE_NOT_FOUND,
      );
    }

    const spider = workerState.spider;
    const startTime = Date.now();

    // Subscribe to progress → stderr
    const unsubscribe = spider.subscribeToIndexStatus((snapshot) => {
      if (snapshot.state === "indexing") {
        process.stderr.write(
          `\r  Indexing: ${snapshot.processed}/${snapshot.total} files...`,
        );
      }
    });

    try {
      const result = await spider.buildFullIndex();
      const durationMs = Date.now() - startTime;
      process.stderr.write("\n");
      log.info("Indexed", result.indexedFiles, "files in", result.duration, "ms");

      // Persist state
      this.saveState({
        lastScanTimestamp: new Date().toISOString(),
        filesIndexed: result.indexedFiles,
        workspaceRoot: this.workspaceRoot,
      });

      workerState.warmupInfo = {
        completed: true,
        durationMs: result.duration,
        filesIndexed: result.indexedFiles,
      };

      return { filesIndexed: result.indexedFiles, durationMs };
    } finally {
      unsubscribe();
    }
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
