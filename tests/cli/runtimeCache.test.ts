import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Spider } from "@/analyzer/Spider";
import { CliRuntime, type IndexOutcome } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";

/**
 * The CLI process dies between commands, so both the reverse index and the call
 * graph are rebuilt from scratch every invocation unless they are persisted.
 * These tests cover the persistence round-trip and every invalidation path.
 */
describe("CliRuntime index cache", () => {
  let tmpDir: string;
  let cacheDir: string;
  const runtimes: CliRuntime[] = [];

  const write = (relPath: string, content: string): string => {
    const filePath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  /** Full init → index → dispose cycle, like one `graph-it <command>` run. */
  const run = async (options?: { cache?: boolean }): Promise<{ callers: number }> => {
    const runtime = new CliRuntime(tmpDir, options);
    runtimes.push(runtime);
    await runtime.init();
    await runtime.ensureIndexed({ silent: true });
    const callers = workerState.spider?.getCallerCount(path.join(tmpDir, "src/b.ts")) ?? -1;
    await runtime.dispose();
    return { callers };
  };

  /** Same cycle, but not silent: returns what the user would see on stderr. */
  const runVerbose = async (): Promise<{ stderr: string; outcome: IndexOutcome }> => {
    const runtime = new CliRuntime(tmpDir);
    runtimes.push(runtime);
    let stderr = "";
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        return true;
      });
    try {
      await runtime.init();
      const outcome = await runtime.ensureIndexed();
      await runtime.dispose();
      return { stderr, outcome };
    } finally {
      write.mockRestore();
    }
  };

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-cache-")));
    cacheDir = path.join(tmpDir, ".graph-it", "cache");
    write("package.json", "{}");
    write("src/b.ts", "export const b = () => 1;\n");
    for (let i = 0; i < 12; i++) {
      write(`src/f${i}.ts`, `import { b } from "./b";\nexport const f${i} = () => b();\n`);
    }
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.dispose().catch(() => {/* already disposed */});
    }
    delete process.env.GRAPH_IT_NO_CACHE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the reverse index and its guard on a cold run", async () => {
    const { callers } = await run();

    expect(callers).toBe(12);
    expect(fs.existsSync(path.join(cacheDir, "reverse-index.json"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf-8"));
    expect(meta.workspaceRoot).toBe(tmpDir);
    expect(meta.schema).toBe(1);
  });

  it("restores the cached index on the next run", async () => {
    await run();
    expect(await run()).toEqual({ callers: 12 });
  });

  it("skips the full rebuild on a warm run, and performs one on a cold run", async () => {
    const buildFullIndex = vi.spyOn(Spider.prototype, "buildFullIndex");
    try {
      await run();
      expect(buildFullIndex).toHaveBeenCalledTimes(1);

      buildFullIndex.mockClear();
      await run();
      expect(buildFullIndex).not.toHaveBeenCalled();
    } finally {
      buildFullIndex.mockRestore();
    }
  });

  it("falls back to a full rebuild when churn passes the threshold", async () => {
    await run();
    for (let i = 0; i < 6; i++) {
      write(`src/extra${i}.ts`, 'import { b } from "./b";\nexport const e = () => b();\n');
    }

    const buildFullIndex = vi.spyOn(Spider.prototype, "buildFullIndex");
    try {
      expect((await run()).callers).toBe(18);
      expect(buildFullIndex).toHaveBeenCalledTimes(1);
    } finally {
      buildFullIndex.mockRestore();
    }
  });

  it("picks up a file created between two runs", async () => {
    await run();
    write("src/new.ts", 'import { b } from "./b";\nexport const n = () => b();\n');

    expect((await run()).callers).toBe(13);
  });

  it("drops a file deleted between two runs", async () => {
    await run();
    fs.rmSync(path.join(tmpDir, "src/f0.ts"));

    expect((await run()).callers).toBe(11);
  });

  it("follows a file renamed between two runs", async () => {
    await run();
    fs.renameSync(path.join(tmpDir, "src/f0.ts"), path.join(tmpDir, "src/moved.ts"));

    expect((await run()).callers).toBe(12);
  });

  it("rebuilds when the guard records a different CLI version", async () => {
    await run();
    const metaPath = path.join(cacheDir, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, cliVersion: "999.0.0" }));

    expect((await run()).callers).toBe(12);
  });

  it("rebuilds when the guard records a different workspace root", async () => {
    await run();
    const metaPath = path.join(cacheDir, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, workspaceRoot: "/somewhere/else" }));

    expect((await run()).callers).toBe(12);
  });

  it("rebuilds instead of throwing when the cached index is corrupt", async () => {
    await run();
    fs.writeFileSync(path.join(cacheDir, "reverse-index.json"), "{ not json");

    expect((await run()).callers).toBe(12);
  });

  it("rebuilds when the cached index is gone but the guard remains", async () => {
    await run();
    fs.rmSync(path.join(cacheDir, "reverse-index.json"));

    expect((await run()).callers).toBe(12);
  });

  it("writes nothing when caching is turned off per run", async () => {
    await run({ cache: false });

    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("writes nothing when GRAPH_IT_NO_CACHE is set", async () => {
    process.env.GRAPH_IT_NO_CACHE = "1";
    await run();

    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("clearCache() removes the cache and is safe when there is none", async () => {
    await run();
    expect(fs.existsSync(cacheDir)).toBe(true);

    const runtime = new CliRuntime(tmpDir);
    runtime.clearCache();
    expect(fs.existsSync(cacheDir)).toBe(false);

    expect(() => runtime.clearCache()).not.toThrow();
  });

  it("reports a cold run as an index, not as a cache hit", async () => {
    const { stderr, outcome } = await runVerbose();

    expect(outcome).toMatchObject({ fromCache: false, filesAnalyzed: outcome.filesFound });
    expect(stderr).toContain(`Indexed ${outcome.filesIndexed}/${outcome.filesFound} files`);
    expect(stderr).not.toContain("from cache");
  });

  it("says the answer came from cache when nothing changed", async () => {
    await run();

    const { stderr, outcome } = await runVerbose();

    expect(outcome).toMatchObject({ fromCache: true, filesAnalyzed: 0 });
    expect(stderr).toContain(`Loaded ${outcome.filesIndexed} files from cache (nothing changed)`);
  });

  it("names the cache and the re-indexed count when files changed", async () => {
    await run();
    fs.writeFileSync(path.join(tmpDir, "src/f0.ts"), 'import { b } from "./b";\nexport const f0 = () => b() + 1;\n');

    const { stderr, outcome } = await runVerbose();

    expect(outcome).toMatchObject({ fromCache: true, filesAnalyzed: 1 });
    expect(stderr).toContain("from cache, re-indexed 1 changed");
  });

  it("never prints a 0/0 progress line", async () => {
    await run();

    const { stderr } = await runVerbose();

    expect(stderr).not.toContain("0/0");
  });

  it("reports counts from the second ensureIndexed() call of the same process", async () => {
    const runtime = new CliRuntime(tmpDir);
    runtimes.push(runtime);
    await runtime.init();

    const first = await runtime.ensureIndexed({ silent: true });
    const second = await runtime.ensureIndexed({ silent: true });
    await runtime.dispose();

    expect(second.filesIndexed).toBe(first.filesIndexed);
    expect(second.filesFound).toBe(first.filesFound);
    expect(second.fromCache).toBe(first.fromCache);
  });

  it("persists the call graph database alongside the reverse index", async () => {
    const runtime = new CliRuntime(tmpDir);
    runtimes.push(runtime);
    await runtime.init();
    await runtime.ensureIndexed({ silent: true });
    // Stand in for a command that built a call graph (query / context / wiki).
    workerState.callGraphIndexer = {
      exportDb: () => new Uint8Array([1, 2, 3]),
      dispose: vi.fn(),
    } as unknown as typeof workerState.callGraphIndexer;

    await runtime.dispose();

    expect(fs.readFileSync(path.join(cacheDir, "callgraph.db"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("does not fail the command when the cache cannot be written", async () => {
    const runtime = new CliRuntime(tmpDir);
    runtimes.push(runtime);
    await runtime.init();
    await runtime.ensureIndexed({ silent: true });
    // A read-only cache directory must degrade to "no cache", never to a crash.
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.chmodSync(cacheDir, 0o500);

    try {
      await expect(runtime.dispose()).resolves.not.toThrow();
    } finally {
      fs.chmodSync(cacheDir, 0o700);
    }
  });

  it("leaves no temp file behind after writing the cache", async () => {
    await run();

    const leftovers = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
