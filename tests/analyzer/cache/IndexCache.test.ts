import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IndexCache,
  INDEX_CACHE_SCHEMA,
  LOCK_STALE_MS,
  restoreOrBuildIndex,
  type ReverseIndexOptions,
} from "@/analyzer/cache/IndexCache";
import type { Spider } from "@/analyzer/Spider";

const OPTIONS: ReverseIndexOptions = { excludeNodeModules: true, ignoreTypeImports: false };

/** A pid that existed a moment ago and is gone now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid ?? 999_999;
}

describe("IndexCache", () => {
  let tmpDir: string;
  let cacheDir: string;
  let lockPath: string;
  const sourceFiles = (): string[] => [path.join(tmpDir, "src", "a.ts")];
  const open = (): IndexCache => new IndexCache(tmpDir, sourceFiles());
  const readMeta = () => JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf-8"));
  const writeLock = (holder: { pid: number; acquiredAt: number }) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(holder));
  };

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-index-cache-")));
    cacheDir = path.join(tmpDir, ".graph-it", "cache");
    lockPath = path.join(cacheDir, "index.lock");
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "export const a = 1;\n");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("payloads and guard", () => {
    it("round-trips the reverse index under a guard naming the workspace", () => {
      expect(open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } })).toBe(true);

      const cache = open();
      expect(cache.isValid()).toBe(true);
      expect(cache.readReverseIndex(OPTIONS)).toBe("INDEX");
      expect(readMeta()).toMatchObject({ schema: INDEX_CACHE_SCHEMA, reverseIndexOptions: OPTIONS });
    });

    it.each([
      { excludeNodeModules: false, ignoreTypeImports: false },
      { excludeNodeModules: true, ignoreTypeImports: true },
    ])("does not hand out a reverse index built with other options (%o)", (other) => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });

      expect(open().readReverseIndex(other)).toBeNull();
    });

    it("finds the same cache from the other platform's separator style", async () => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });
      const meta = readMeta();
      const swapped: string = meta.workspaceRoot.includes("/")
        ? meta.workspaceRoot.replaceAll("/", "\\")
        : meta.workspaceRoot.replaceAll("\\", "/");
      fs.writeFileSync(path.join(cacheDir, "meta.json"), JSON.stringify({ ...meta, workspaceRoot: swapped }));

      expect((await IndexCache.open(tmpDir)).isValid()).toBe(true);
    });

    it.each([
      ["another version", { version: "999.0.0" }],
      ["another schema", { schema: 1 }],
      ["another workspace", { workspaceRoot: "/somewhere/else" }],
      ["another resolver config", { configFingerprint: "different" }],
    ])("rejects a guard written by %s", (_label, change) => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });
      fs.writeFileSync(path.join(cacheDir, "meta.json"), JSON.stringify({ ...readMeta(), ...change }));

      expect(open().isValid()).toBe(false);
      expect(open().readReverseIndex(OPTIONS)).toBeNull();
    });

    it("rejects a missing or corrupt guard", () => {
      expect(open().isValid()).toBe(false);
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });
      fs.writeFileSync(path.join(cacheDir, "meta.json"), "{ not json");

      expect(open().isValid()).toBe(false);
    });

    it("returns null when the guard remains but the reverse index is gone", () => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });
      fs.rmSync(path.join(cacheDir, "reverse-index.json"));

      expect(open().readReverseIndex(OPTIONS)).toBeNull();
    });

    it("keeps the other payload and its options when the guard still matches", () => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });

      open().save({ callGraph: new Uint8Array([1, 2]) });

      expect(open().readReverseIndex(OPTIONS)).toBe("INDEX");
      expect(fs.readFileSync(open().callGraphPath)).toEqual(Buffer.from([1, 2]));
    });

    it("deletes the other payload instead of blessing it with a new guard", () => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });
      open().save({ callGraph: new Uint8Array([1]) });
      fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), '{"compilerOptions":{"baseUrl":"src"}}');

      open().save({ reverseIndex: { data: "NEW", options: OPTIONS } });
      expect(fs.existsSync(open().callGraphPath)).toBe(false);

      fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
      open().save({ callGraph: new Uint8Array([2]) });
      expect(fs.existsSync(path.join(cacheDir, "reverse-index.json"))).toBe(false);
      expect(readMeta().reverseIndexOptions).toBeUndefined();
    });

    it("leaves no temp file behind", () => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS }, callGraph: new Uint8Array([1]) });

      expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    it("makes .graph-it/ ignore itself in git, without overwriting an edited .gitignore", () => {
      open().save({ callGraph: new Uint8Array([1]) });
      const gitignore = path.join(tmpDir, ".graph-it", ".gitignore");
      expect(fs.readFileSync(gitignore, "utf-8")).toBe("*\n");

      fs.writeFileSync(gitignore, "*\n!keep\n");
      open().save({ callGraph: new Uint8Array([1]) });
      expect(fs.readFileSync(gitignore, "utf-8")).toBe("*\n!keep\n");
    });

    it("reports a failed save instead of throwing when the cache cannot be created", () => {
      fs.writeFileSync(path.join(tmpDir, ".graph-it"), "not a directory");

      expect(open().save({ callGraph: new Uint8Array([1]) })).toBe(false);
    });

    it("is disabled when the resolver config points outside the workspace", () => {
      fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), '{"extends":"../outside.json"}');
      const cache = open();

      expect(cache.enabled).toBe(false);
      expect(cache.save({ callGraph: new Uint8Array([1]) })).toBe(false);
      expect(cache.isValid()).toBe(false);
      expect(fs.existsSync(cacheDir)).toBe(false);
    });

    it("clear() removes the cache, and is safe when there is none", () => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });

      open().clear();
      expect(fs.existsSync(cacheDir)).toBe(false);
      expect(() => open().clear()).not.toThrow();
    });

    it("clear() leaves another process's lock in place", () => {
      open().save({ reverseIndex: { data: "INDEX", options: OPTIONS } });
      writeLock({ pid: process.ppid, acquiredAt: Date.now() });

      open().clear();

      expect(fs.readdirSync(cacheDir)).toEqual(["index.lock"]);
    });
  });

  describe("lock", () => {
    it("is exclusive across processes", () => {
      writeLock({ pid: process.ppid, acquiredAt: Date.now() });

      expect(open().tryLock()).toBeNull();
    });

    // Only Windows spells one directory several ways (drive-letter case, "/" or "\\").
    it.runIf(process.platform === "win32")("is re-entrant across spellings of the same workspace root", () => {
      const drive = tmpDir[0];
      const otherCase = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
      const respelled = new IndexCache(otherCase + tmpDir.slice(1).replaceAll("\\", "/"), sourceFiles());
      expect(respelled.enabled).toBe(true);
      const release = open().tryLock();

      const nested = respelled.tryLock();

      expect(nested).not.toBeNull();
      nested?.();
      expect(fs.existsSync(lockPath)).toBe(true);
      release?.();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("is re-entrant within one process and removed by the last release", () => {
      const first = open().tryLock();
      const second = open().tryLock();
      expect(first && second).toBeTruthy();

      first?.();
      first?.(); // a second call of the same release is a no-op
      expect(fs.existsSync(lockPath)).toBe(true);
      second?.();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it.each([
      ["whose process is gone", () => ({ pid: deadPid(), acquiredAt: Date.now() })],
      ["older than the stale limit", () => ({ pid: process.ppid, acquiredAt: Date.now() - LOCK_STALE_MS - 1 })],
      ["left behind by an earlier run of this pid", () => ({ pid: process.pid, acquiredAt: Date.now() })],
    ])("takes over a lock %s", (_label, holder) => {
      writeLock(holder());

      const release = open().tryLock();

      expect(release).not.toBeNull();
      expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);
      release?.();
    });

    it("judges an unreadable lock by its age", () => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(lockPath, "");
      expect(open().tryLock()).toBeNull();

      const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
      fs.utimesSync(lockPath, old, old);
      const release = open().tryLock();
      expect(release).not.toBeNull();
      release?.();
    });

    it("never deletes a lock another process took over", () => {
      const release = open().tryLock();
      writeLock({ pid: process.ppid, acquiredAt: Date.now() });

      release?.();

      expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).toBe(process.ppid);
    });

    it("waits for the holder, then returns the lock", async () => {
      writeLock({ pid: process.ppid, acquiredAt: Date.now() });
      const onWait = vi.fn();
      setTimeout(() => fs.rmSync(lockPath), 300);

      const release = await open().lock(onWait);

      expect(onWait).toHaveBeenCalledExactlyOnceWith(process.ppid);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);
      release();
    });

    it("works without a lock when the cache directory cannot be created", () => {
      fs.writeFileSync(path.join(tmpDir, ".graph-it"), "not a directory");

      const release = open().tryLock();

      expect(release).toBeTypeOf("function");
      expect(() => release?.()).not.toThrow();
    });
  });

  describe("restoreOrBuildIndex", () => {
    const createSpider = (overrides: Partial<Record<keyof Spider, unknown>> = {}) => ({
      enableReverseIndex: vi.fn(() => true),
      validateReverseIndex: vi.fn(async () => ({ isValid: true, staleFiles: [], missingFiles: [], stalePercentage: 0 })),
      reindexStaleFiles: vi.fn(async (files: string[]) => files.length),
      handleFileDeleted: vi.fn(),
      clearCache: vi.fn(),
      getSerializedReverseIndex: vi.fn(() => "SERIALIZED"),
      getCacheStats: vi.fn(() => ({ reverseIndexStats: { indexedFiles: 3 } })),
      ...overrides,
    });
    const run = (spider: ReturnType<typeof createSpider>, cache: IndexCache | null, build = vi.fn(async () => ({ indexedFiles: 4, cancelled: false }))) =>
      restoreOrBuildIndex(spider as unknown as Spider, { cache, reverseIndexOptions: OPTIONS, buildFullIndex: build });

    it("builds from scratch and writes nothing without a cache", async () => {
      const spider = createSpider();
      const build = vi.fn(async () => ({ indexedFiles: 4, cancelled: false }));

      const outcome = await run(spider, null, build);

      expect(build).toHaveBeenCalledOnce();
      expect(spider.clearCache).toHaveBeenCalled();
      expect(outcome).toEqual({ filesIndexed: 3, filesFound: 4, filesAnalyzed: 4, fromCache: false, cancelled: false });
      expect(fs.existsSync(cacheDir)).toBe(false);
    });

    it("writes the built index, then releases the lock", async () => {
      await run(createSpider(), open());

      expect(open().readReverseIndex(OPTIONS)).toBe("SERIALIZED");
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("does not write a cancelled build", async () => {
      await run(createSpider(), open(), vi.fn(async () => ({ indexedFiles: 1, cancelled: true })));

      expect(open().isValid()).toBe(false);
    });

    it("restores without rewriting when nothing changed", async () => {
      open().save({ reverseIndex: { data: "CACHED", options: OPTIONS } });
      const savedAt = readMeta().savedAt;
      const spider = createSpider();
      const build = vi.fn();

      const outcome = await run(spider, open(), build);

      expect(spider.enableReverseIndex).toHaveBeenCalledWith("CACHED");
      expect(build).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ fromCache: true, filesAnalyzed: 0 });
      expect(readMeta().savedAt).toBe(savedAt);
    });

    it("re-indexes changed files, drops deleted ones and writes the result", async () => {
      open().save({ reverseIndex: { data: "CACHED", options: OPTIONS } });
      const spider = createSpider({
        validateReverseIndex: vi.fn(async () => ({ isValid: true, staleFiles: ["/w/a.ts"], missingFiles: ["/w/gone.ts"], stalePercentage: 0.1 })),
      });
      const onReindexStart = vi.fn();

      const outcome = await restoreOrBuildIndex(spider as unknown as Spider, {
        cache: open(),
        reverseIndexOptions: OPTIONS,
        sourceFiles: ["/w/a.ts", "/w/b.ts"],
        buildFullIndex: vi.fn(),
        onReindexStart,
      });

      expect(spider.handleFileDeleted).toHaveBeenCalledWith("/w/gone.ts");
      expect(onReindexStart).toHaveBeenCalledWith(1);
      expect(outcome).toMatchObject({ fromCache: true, filesAnalyzed: 1, filesFound: 2 });
      expect(open().readReverseIndex(OPTIONS)).toBe("SERIALIZED");
    });

    it("rebuilds when the restored index is too stale or rejected", async () => {
      open().save({ reverseIndex: { data: "CACHED", options: OPTIONS } });
      const stale = createSpider({ validateReverseIndex: vi.fn(async () => ({ isValid: false, staleFiles: [], missingFiles: [], stalePercentage: 1 })) });
      const rejected = createSpider({ enableReverseIndex: vi.fn(() => false) });

      expect((await run(stale, open())).fromCache).toBe(false);
      expect((await run(rejected, open())).fromCache).toBe(false);
    });

    it("releases the lock when the build throws", async () => {
      const failing = vi.fn(async () => { throw new Error("boom"); });

      await expect(run(createSpider(), open(), failing)).rejects.toThrow("boom");
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });
});
