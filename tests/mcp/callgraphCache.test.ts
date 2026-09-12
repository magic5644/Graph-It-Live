import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { ensureCallGraphReady } from "@/mcp/tools/callgraph";
import { workerState } from "@/mcp/shared/state";
import { normalizePath } from "@/shared/path";

/** Package root holding dist/wasm and dist/queries. */
const EXTENSION_PATH = path.resolve(__dirname, "..", "..");
const HAS_WASM = fs.existsSync(path.join(EXTENSION_PATH, "dist", "wasm", "sqljs.wasm"));

/**
 * The MCP worker leaves cacheDir undefined and rebuilds every start; the CLI
 * passes one so the SQLite call graph survives between processes.
 */
describe.runIf(HAS_WASM)("call graph cache", () => {
  let tmpDir: string;
  let cacheDir: string;

  const write = (relPath: string, content: string): void => {
    const filePath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  const configure = (withCache: boolean): void => {
    workerState.callGraphIndexer = null;
    workerState.callGraphIndexedRoot = null;
    workerState.config = {
      rootDir: tmpDir,
      excludeNodeModules: true,
      maxDepth: 50,
      extensionPath: EXTENSION_PATH,
      cacheDir: withCache ? cacheDir : undefined,
    };
  };

  /** One "process": index, persist the DB the way CliRuntime.dispose() does. */
  const indexOnce = async (withCache = true): Promise<void> => {
    configure(withCache);
    await ensureCallGraphReady();
    if (withCache) {
      fs.mkdirSync(cacheDir, { recursive: true });
      await workerState.callGraphIndexer?.saveToFile(path.join(cacheDir, "callgraph.db"));
    }
  };

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-cg-")));
    cacheDir = path.join(tmpDir, ".graph-it", "cache");
    write("package.json", "{}");
    write("src/b.ts", "export function b() { return 1; }\n");
    for (let i = 0; i < 12; i++) {
      write(`src/f${i}.ts`, `import { b } from "./b";\nexport function f${i}() { return b(); }\n`);
    }
  });

  afterEach(() => {
    workerState.reset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists a reloadable database", async () => {
    await indexOnce();

    expect(fs.existsSync(path.join(cacheDir, "callgraph.db"))).toBe(true);
    const before = workerState.callGraphIndexer?.getIndexSnapshot().files.length ?? 0;
    expect(before).toBe(13);

    await indexOnce();
    expect(workerState.callGraphIndexer?.getIndexSnapshot().files).toHaveLength(13);
  });

  it("re-extracts only what changed on a warm run", async () => {
    await indexOnce();

    const extractFile = vi.spyOn(GraphExtractor.prototype, "extractFile");
    try {
      await indexOnce();
      expect(extractFile).not.toHaveBeenCalled();

      extractFile.mockClear();
      write("src/f0.ts", 'import { b } from "./b";\nexport function f0() { return b() + 1; }\n');
      await indexOnce();
      // The changed file, plus any importer of it (none here).
      expect(extractFile).toHaveBeenCalledTimes(1);
    } finally {
      extractFile.mockRestore();
    }
  });

  it("also re-extracts importers of a changed file", async () => {
    await indexOnce();
    // Stand in for the warm Spider reverse index: f1.ts imports f0.ts.
    const importer = path.join(tmpDir, "src/f1.ts");
    workerState.spider = {
      findReferencingFiles: (target: string) =>
        Promise.resolve(
          target.endsWith("f0.ts")
            ? [{ path: importer, type: "import", line: 1, module: "./f0" }]
            : [],
        ),
    } as unknown as typeof workerState.spider;

    const extractFile = vi.spyOn(GraphExtractor.prototype, "extractFile");
    try {
      write("src/f0.ts", 'import { b } from "./b";\nexport function f0() { return b() + 1; }\n');
      await indexOnce();

      const extracted = extractFile.mock.calls.map(([filePath]) => filePath);
      expect(extracted).toHaveLength(2);
      // selectStaleJobs normalizes every path it takes from the reverse index.
      expect(extracted).toContain(normalizePath(importer));
    } finally {
      extractFile.mockRestore();
    }
  });

  it("drops a file deleted between runs", async () => {
    await indexOnce();
    fs.rmSync(path.join(tmpDir, "src/f0.ts"));

    await indexOnce();

    const files = workerState.callGraphIndexer?.getIndexSnapshot().files ?? [];
    expect(files).toHaveLength(12);
    expect(files.some((f) => f.path.endsWith("f0.ts"))).toBe(false);
  });

  it("rebuilds everything when churn passes the threshold", async () => {
    await indexOnce();
    for (let i = 0; i < 6; i++) {
      write(`src/extra${i}.ts`, `import { b } from "./b";\nexport function e${i}() { return b(); }\n`);
    }

    const extractFile = vi.spyOn(GraphExtractor.prototype, "extractFile");
    try {
      await indexOnce();
      expect(extractFile).toHaveBeenCalledTimes(19);
    } finally {
      extractFile.mockRestore();
    }
  });

  it("indexes from scratch when no cacheDir is configured", async () => {
    await indexOnce();

    const extractFile = vi.spyOn(GraphExtractor.prototype, "extractFile");
    try {
      await indexOnce(false);
      expect(extractFile).toHaveBeenCalledTimes(13);
    } finally {
      extractFile.mockRestore();
    }
  });

  it("rebuilds instead of throwing when the persisted database is corrupt", async () => {
    await indexOnce();
    fs.writeFileSync(path.join(cacheDir, "callgraph.db"), "not a database");

    await indexOnce();

    expect(workerState.callGraphIndexer?.getIndexSnapshot().files).toHaveLength(13);
  });
});
