/**
 * invalidate_files and rebuild_index must refresh the call graph, not only the
 * dependency index (#227). Uses a real CliRuntime (Spider + call graph WASM)
 * on a throwaway workspace.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageService } from "@/analyzer/LanguageService";
import { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { executeInvalidateFiles, executeRebuildIndex } from "@/mcp/tools/workspace";
import { normalizePath } from "@/shared/path";

const WITH_CALL = 'import { helper } from "./b";\nexport function run() { return helper(); }\n';
// Same length as WITH_CALL, so neither size nor mtime betrays the edit.
const WITHOUT_CALL = 'import { helper } from "./b";\nexport function run() { return 42 + 1 ; }\n';

// The call graph parsers load from dist/wasm (built before the tests in CI).
const REPO_ROOT = path.resolve(__dirname, "../../..");
const wasmBuilt = fs.existsSync(path.join(REPO_ROOT, "dist/wasm/sqljs.wasm"));

// Cold indexing with the WASM parsers is slow on the Windows runner.
describe.skipIf(!wasmBuilt)("call graph refresh on invalidate_files / rebuild_index", { timeout: 30_000 }, () => {
  let tmpDir: string;
  let runtime: CliRuntime;
  let fileA: string;
  let fileB: string;

  /** Rewrite a file without moving its mtime: only an explicit invalidation can notice. */
  const rewriteKeepingMtime = (filePath: string, content: string): void => {
    const { atime, mtime } = fs.statSync(filePath);
    fs.writeFileSync(filePath, content);
    fs.utimesSync(filePath, atime, mtime);
  };

  const callersOfHelper = async (): Promise<string[]> => {
    const result = await executeQueryCallGraph({
      filePath: fileB,
      symbolName: "helper",
      direction: "callers",
      depth: 1,
    });
    return result.callers.map((c) => c.sourceName);
  };

  beforeEach(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "callgraph-refresh-")));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fileA = normalizePath(path.join(tmpDir, "src/a.ts"));
    fileB = normalizePath(path.join(tmpDir, "src/b.ts"));
    fs.writeFileSync(fileB, "export function helper() { return 1; }\n");
    fs.writeFileSync(fileA, WITH_CALL);

    LanguageService.reset();
    runtime = new CliRuntime(tmpDir);
    await runtime.init();
    // Under Vitest the runtime derives its package root from src/, not dist/.
    workerState.config = { ...workerState.getConfig(), extensionPath: REPO_ROOT };
    await runtime.ensureIndexed({ silent: true });
    expect(await callersOfHelper()).toEqual(["run"]);
  });

  afterEach(async () => {
    await runtime.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drops a removed call after invalidate_files", async () => {
    rewriteKeepingMtime(fileA, WITHOUT_CALL);

    executeInvalidateFiles({ filePaths: [fileA] });

    expect(await callersOfHelper()).toEqual([]);
    expect(workerState.callGraphPendingFiles.size).toBe(0);
  });

  it("keeps the old edge until something invalidates the file (mtime unchanged)", async () => {
    rewriteKeepingMtime(fileA, WITHOUT_CALL);

    expect(await callersOfHelper()).toEqual(["run"]);
  });

  it("drops a removed call after rebuild_index and reports the call graph", async () => {
    rewriteKeepingMtime(fileA, WITHOUT_CALL);

    const result = await executeRebuildIndex(() => {});

    expect(result.callGraph).toMatchObject({ rebuilt: true, indexedFiles: 2 });
    expect(workerState.callGraphFullRebuild).toBe(false);
    expect(await callersOfHelper()).toEqual([]);
  });

  it("picks up a call added to another file after invalidate_files", async () => {
    const fileC = path.join(tmpDir, "src/c.ts");
    fs.writeFileSync(fileC, 'import { helper } from "./b";\nexport function other() { return helper(); }\n');

    executeInvalidateFiles({ filePaths: [fileC] });

    expect((await callersOfHelper()).sort()).toEqual(["other", "run"]);
  });

  it("drops the edges of a deleted file after invalidate_files", async () => {
    fs.rmSync(fileA);

    executeInvalidateFiles({ filePaths: [fileA] });

    expect(await callersOfHelper()).toEqual([]);
  });
});
