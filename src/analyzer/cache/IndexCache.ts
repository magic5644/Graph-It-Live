/**
 * IndexCache — the `.graph-it/cache/` directory shared by the VS Code extension,
 * the MCP server and the CLI, so whichever starts first indexes the workspace
 * and the others start warm.
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * - `meta.json` guards both payloads. It is written last, so a payload is only
 *   trusted once its guard is on disk.
 * - Payloads are written to a temp file then renamed, so a reader never sees a
 *   half-written file.
 * - `index.lock` serializes indexing across processes: a process that finds it
 *   held waits, then restores what the holder wrote instead of indexing again.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SourceFileCollector } from "../SourceFileCollector";
import type { Spider } from "../Spider";
import { getLogger } from "../../shared/logger";
import { normalizePath } from "../../shared/path";
import { configFingerprint } from "./configFingerprint";

const log = getLogger("IndexCache");

/** Layout version of .graph-it/cache/ itself. Bump when file names or roles change. */
export const INDEX_CACHE_SCHEMA = 2;

/** Injected at build time into every Node bundle; "0.0.0-dev" in local builds. */
const ANALYZER_VERSION = process.env.CLI_VERSION ?? "0.0.0-dev";

/**
 * Above this fraction of added/changed/deleted files, a full rebuild is cheaper
 * and safer than an incremental pass.
 */
const STALE_THRESHOLD = 0.2;

/** A lock older than this, or whose process is gone, is taken over. */
export const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 250;

const META_FILE = "meta.json";
const REVERSE_INDEX_FILE = "reverse-index.json";
const CALLGRAPH_FILE = "callgraph.db";
const LOCK_FILE = "index.lock";

/** Spider options that change the reverse index content. The call graph ignores them. */
export interface ReverseIndexOptions {
  excludeNodeModules: boolean;
  ignoreTypeImports: boolean;
}

interface IndexCacheMeta {
  schema: number;
  version: string;
  savedAt: string;
  workspaceRoot: string;
  configFingerprint: string;
  /** Options the cached reverse index was built with; absent when there is none. */
  reverseIndexOptions?: ReverseIndexOptions;
}

interface LockHolder {
  pid: number;
  acquiredAt: number;
}

/** Releases a lock taken by IndexCache.lock() or IndexCache.tryLock(). */
export type ReleaseLock = () => void;

/** Lock files this process holds, with a re-entry count: the lock is per process. */
const heldLocks = new Map<string, number>();

const NO_LOCK: ReleaseLock = () => undefined;

/**
 * Write a file atomically: temp file in the same directory, then rename.
 * The pid suffix keeps concurrent processes from colliding on the temp name.
 */
function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sameOptions(a: ReverseIndexOptions | undefined, b: ReverseIndexOptions): boolean {
  return a?.excludeNodeModules === b.excludeNodeModules && a?.ignoreTypeImports === b.ignoreTypeImports;
}

export class IndexCache {
  readonly dir: string;
  /** The files fingerprinted; a restored index must cover them, not only its own entries. */
  readonly sourceFiles: readonly string[];
  private readonly workspaceRoot: string;
  /** Undefined when resolver configs cannot be fingerprinted: the cache is then disabled. */
  private readonly fingerprint: string | undefined;

  /**
   * @param sourceFiles Workspace source files, as collected with node_modules excluded.
   *                    Every surface must fingerprint the same list to share the cache.
   */
  constructor(workspaceRoot: string, sourceFiles: readonly string[]) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.dir = IndexCache.dirFor(this.workspaceRoot);
    this.sourceFiles = sourceFiles;
    this.fingerprint = configFingerprint(this.workspaceRoot, sourceFiles);
  }

  static dirFor(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".graph-it", "cache");
  }

  /**
   * Collect the workspace source files, then open the cache.
   * Never cancelled: a partial walk would fingerprint another configuration.
   */
  static async open(workspaceRoot: string): Promise<IndexCache> {
    const sourceFiles = await new SourceFileCollector({
      excludeNodeModules: true,
      yieldIntervalMs: 30,
      isCancelled: () => false,
    }).collectAllSourceFiles(workspaceRoot);
    return new IndexCache(workspaceRoot, sourceFiles);
  }

  get enabled(): boolean {
    return this.fingerprint !== undefined;
  }

  get callGraphPath(): string {
    return path.join(this.dir, CALLGRAPH_FILE);
  }

  /**
   * Whether the guard matches this workspace, configuration and analyzer version.
   *
   * NOTE: the version is "0.0.0-dev" in a local build, so a rebuilt analyzer does
   * NOT invalidate the cache during development — use `--reindex` there.
   */
  isValid(): boolean {
    return this.matches(this.readMeta());
  }

  /** The cached reverse index, or null when it is missing or built with other options. */
  readReverseIndex(options: ReverseIndexOptions): string | null {
    const meta = this.readMeta();
    if (!this.matches(meta) || !sameOptions(meta?.reverseIndexOptions, options)) return null;
    try {
      return fs.readFileSync(path.join(this.dir, REVERSE_INDEX_FILE), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Write the given payloads, then the guard. A payload left out is kept when the
   * guard already matches, and deleted otherwise: a new guard must never bless a
   * file written for another configuration.
   * Best-effort: a cache that fails to write only costs the next start some time.
   */
  save(payload: {
    reverseIndex?: { data: string; options: ReverseIndexOptions };
    callGraph?: Uint8Array;
  }): boolean {
    if (!this.fingerprint) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.ensureGitignore();
      const previous = this.readMeta();
      const keepOthers = this.matches(previous);

      const reverseIndexPath = path.join(this.dir, REVERSE_INDEX_FILE);
      if (payload.reverseIndex) writeFileAtomic(reverseIndexPath, payload.reverseIndex.data);
      else if (!keepOthers) fs.rmSync(reverseIndexPath, { force: true });

      if (payload.callGraph) writeFileAtomic(this.callGraphPath, payload.callGraph);
      else if (!keepOthers) fs.rmSync(this.callGraphPath, { force: true });

      const meta: IndexCacheMeta = {
        schema: INDEX_CACHE_SCHEMA,
        version: ANALYZER_VERSION,
        savedAt: new Date().toISOString(),
        workspaceRoot: this.workspaceRoot,
        configFingerprint: this.fingerprint,
        reverseIndexOptions: payload.reverseIndex?.options ?? (keepOthers ? previous?.reverseIndexOptions : undefined),
      };
      writeFileAtomic(path.join(this.dir, META_FILE), JSON.stringify(meta, null, 2));
      return true;
    } catch (error) {
      log.warn("Could not save index cache:", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Delete the cached payloads and guard. Leaves another process's lock in place. */
  clear(): void {
    for (const file of [META_FILE, REVERSE_INDEX_FILE, CALLGRAPH_FILE]) {
      fs.rmSync(path.join(this.dir, file), { force: true });
    }
    try {
      fs.rmdirSync(this.dir);
    } catch {
      // Missing, or still holding a lock: either way there is nothing to clear.
    }
  }

  /**
   * Take the lock without waiting. Returns null when another live process holds it.
   * Re-entrant within one process, which only ever writes synchronously.
   */
  tryLock(): ReleaseLock | null {
    if (!this.enabled) return NO_LOCK;
    const lockPath = path.join(this.dir, LOCK_FILE);
    const count = heldLocks.get(normalizePath(lockPath));
    if (count) {
      heldLocks.set(normalizePath(lockPath), count + 1);
      return this.releaser(lockPath);
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!this.createLockFile(lockPath)) {
        if (!this.isLockStale(lockPath)) return null;
        // ponytail: two waiters breaking the same stale lock at once can both
        // win. Only reachable after a crash or a 10 min index; add an flock if it
        // ever shows up.
        fs.rmSync(lockPath, { force: true });
        if (!this.createLockFile(lockPath)) return null;
      }
    } catch (error) {
      // An unwritable cache directory: work without a lock, the save fails anyway.
      log.warn("Could not lock index cache:", error instanceof Error ? error.message : String(error));
      return NO_LOCK;
    }
    heldLocks.set(normalizePath(lockPath), 1);
    return this.releaser(lockPath);
  }

  /**
   * Take the lock, waiting while another live process holds it.
   * Bounded by LOCK_STALE_MS: a lock older than that is taken over.
   */
  async lock(onWait?: (holderPid: number | undefined) => void): Promise<ReleaseLock> {
    let notified = false;
    for (;;) {
      const release = this.tryLock();
      if (release) return release;
      if (!notified) {
        notified = true;
        onWait?.(this.readLockHolder(path.join(this.dir, LOCK_FILE))?.pid);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  private releaser(lockPath: string): ReleaseLock {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const key = normalizePath(lockPath);
      const count = (heldLocks.get(key) ?? 1) - 1;
      if (count > 0) {
        heldLocks.set(key, count);
        return;
      }
      heldLocks.delete(key);
      // Never delete a lock another process took over after ours went stale.
      if (this.readLockHolder(lockPath)?.pid === process.pid) {
        fs.rmSync(lockPath, { force: true });
      }
    };
  }

  private createLockFile(lockPath: string): boolean {
    const holder: LockHolder = { pid: process.pid, acquiredAt: Date.now() };
    try {
      fs.writeFileSync(lockPath, JSON.stringify(holder), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  private readLockHolder(lockPath: string): LockHolder | undefined {
    try {
      const holder = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockHolder;
      return typeof holder.pid === "number" ? holder : undefined;
    } catch {
      return undefined;
    }
  }

  private isLockStale(lockPath: string): boolean {
    const holder = this.readLockHolder(lockPath);
    if (!holder) {
      // Unreadable: maybe being written right now. Only its age can tell.
      try {
        return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        return true;
      }
    }
    // Our own pid without an entry in heldLocks: left behind by an earlier process.
    if (holder.pid === process.pid) return true;
    return Date.now() - holder.acquiredAt > LOCK_STALE_MS || !isProcessAlive(holder.pid);
  }

  /** `.graph-it/` holds only generated state, so it ignores itself in git. */
  private ensureGitignore(): void {
    try {
      fs.writeFileSync(path.join(path.dirname(this.dir), ".gitignore"), "*\n", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private readMeta(): IndexCacheMeta | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, META_FILE), "utf-8")) as IndexCacheMeta;
    } catch {
      return undefined;
    }
  }

  private matches(meta: IndexCacheMeta | undefined): boolean {
    return (
      this.fingerprint !== undefined &&
      meta?.schema === INDEX_CACHE_SCHEMA &&
      meta.version === ANALYZER_VERSION &&
      meta.configFingerprint === this.fingerprint &&
      typeof meta.workspaceRoot === "string" &&
      normalizePath(meta.workspaceRoot) === normalizePath(this.workspaceRoot)
    );
  }
}

/** What one restoreOrBuildIndex() call did. */
export interface CachedIndexOutcome {
  /** Source files held in the index once this run finished. */
  filesIndexed: number;
  /** Source files discovered on disk. */
  filesFound: number;
  /** Files parsed during this run — 0 on a fully warm cache hit. */
  filesAnalyzed: number;
  /** Whether the index was restored from the cache rather than rebuilt. */
  fromCache: boolean;
  cancelled: boolean;
}

/** One run's outcome, plus the deleted files it dropped from a restored index. */
type IndexRun = CachedIndexOutcome & { deleted: number };

export interface RestoreOrBuildOptions {
  /** Null runs without any cache: always a full build, nothing written. */
  cache: IndexCache | null;
  reverseIndexOptions: ReverseIndexOptions;
  /** Full build used when nothing usable is cached (in-process or worker). */
  buildFullIndex: () => Promise<{ indexedFiles: number; cancelled: boolean }>;
  onWait?: (holderPid: number | undefined) => void;
  onReindexStart?: (changedFiles: number) => void;
}

/**
 * Restore the cached reverse index and re-index only what changed, or build it
 * from scratch; then write it back. Holds the cache lock for the whole run, so
 * a second process waits and restores this one's result instead of indexing.
 */
export async function restoreOrBuildIndex(
  spider: Spider,
  options: RestoreOrBuildOptions,
): Promise<CachedIndexOutcome> {
  const { cache } = options;
  const release = cache ? await cache.lock(options.onWait) : NO_LOCK;
  try {
    const cached = cache?.readReverseIndex(options.reverseIndexOptions);
    // enableReverseIndex() re-checks the index version and rootDir on its own.
    const restored = cached ? spider.enableReverseIndex(cached) : false;
    if (restored) log.info("Restored reverse index from cache");

    const incremental = cache && restored ? await reindexChanged(spider, cache, options) : null;
    const { deleted, ...outcome } = incremental ?? (await buildFromScratch(spider, options));

    const changed = !outcome.fromCache || outcome.filesAnalyzed > 0 || deleted > 0;
    if (cache && changed && !outcome.cancelled) {
      const data = spider.getSerializedReverseIndex();
      if (data) cache.save({ reverseIndex: { data, options: options.reverseIndexOptions } });
    }
    return outcome;
  } finally {
    release();
  }
}

async function reindexChanged(
  spider: Spider,
  cache: IndexCache,
  options: RestoreOrBuildOptions,
): Promise<IndexRun | null> {
  // Files on disk the index never saw count as stale: an index persisted
  // mid-build would otherwise validate against its own few entries only.
  const validation = await spider.validateReverseIndex(STALE_THRESHOLD, cache.sourceFiles);
  if (!validation?.isValid) {
    log.info("Cached index too stale, rebuilding from scratch");
    return null;
  }

  for (const deleted of validation.missingFiles) {
    spider.handleFileDeleted(deleted);
  }
  if (validation.staleFiles.length > 0) {
    options.onReindexStart?.(validation.staleFiles.length);
  }
  const reindexed = await spider.reindexStaleFiles(validation.staleFiles);
  log.info(`Incremental index: ${reindexed} changed, ${validation.missingFiles.length} deleted`);

  const filesIndexed = spider.getCacheStats().reverseIndexStats?.indexedFiles ?? 0;
  return {
    filesIndexed,
    filesFound: cache.sourceFiles.length,
    filesAnalyzed: reindexed,
    fromCache: true,
    cancelled: false,
    deleted: validation.missingFiles.length,
  };
}

async function buildFromScratch(spider: Spider, options: RestoreOrBuildOptions): Promise<IndexRun> {
  // A restored index may still contain deleted files when churn forces a full rebuild.
  spider.clearCache();
  const result = await options.buildFullIndex();
  return {
    // A full build counts every file it attempted, including ones that failed to
    // parse; the reverse index holds only the files actually indexed.
    filesIndexed: spider.getCacheStats().reverseIndexStats?.indexedFiles ?? result.indexedFiles,
    filesFound: result.indexedFiles,
    filesAnalyzed: result.indexedFiles,
    fromCache: false,
    cancelled: result.cancelled,
    deleted: 0,
  };
}
