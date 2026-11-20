/**
 * Auto-import declarations and the persisted call graph: a warm run with unchanged declarations re-extracts
 * nothing, a changed declaration re-extracts its project, an edited auto-imported file re-extracts its callers,
 * and a Nuxt project without `.nuxt/imports.d.ts` is reported once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { IndexCache } from "@/analyzer/cache/IndexCache";
import { ensureCallGraphReady, executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { workerState } from "@/mcp/shared/state";

const EXTENSION_PATH = path.resolve(__dirname, "..", "..");
const HAS_WASM = fs.existsSync(path.join(EXTENSION_PATH, "dist", "wasm", "sqljs.wasm"));
const DTS = "declare global {\n  const useX: typeof import('./composables/x')['useX']\n}\n";

describe.runIf(HAS_WASM)("call graph auto-imports", { timeout: 60_000 }, () => {
  let tmpDir: string;

  const write = (relPath: string, content: string): void => {
    const filePath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  const indexOnce = async (): Promise<void> => {
    workerState.callGraphIndexer = null;
    workerState.callGraphIndexedRoot = null;
    workerState.config = { rootDir: tmpDir, excludeNodeModules: true, maxDepth: 50, extensionPath: EXTENSION_PATH };
    workerState.indexCache = await IndexCache.open(tmpDir);
    await ensureCallGraphReady();
  };

  const extracted = async (): Promise<string[]> => {
    const extractFile = vi.spyOn(GraphExtractor.prototype, "extractFile");
    try {
      await indexOnce();
      return extractFile.mock.calls.map(([filePath]) => path.relative(tmpDir, filePath).replaceAll("\\", "/")).sort();
    } finally {
      extractFile.mockRestore();
    }
  };

  const callersOfUseX = async (): Promise<string[]> => {
    const result = await executeQueryCallGraph({ filePath: path.join(tmpDir, "src/composables/x.ts"), symbolName: "useX", direction: "callers", depth: 1 });
    return result.callers.map(caller => caller.sourceName).sort();
  };

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-auto-")));
    write("package.json", "{}");
    write("src/auto-imports.d.ts", DTS);
    write("src/composables/x.ts", "export function useX() { return 1; }\n");
    write("src/page.ts", "export function page() { return useX(); }\n");
    for (let i = 0; i < 12; i++) write(`src/f${i}.ts`, `export function f${i}() { return ${i}; }\n`);
  });

  afterEach(() => {
    workerState.reset();
    workerState.callGraphNotice = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("re-extracts nothing on a warm run with unchanged declarations", async () => {
    await indexOnce();
    expect(await callersOfUseX()).toEqual(["page"]);
    expect(workerState.callGraphAutoImports).toEqual({ projects: [{ project: ".", sources: ["src/auto-imports.d.ts"], entries: 1 }], missing: [] });

    expect(await extracted()).toEqual([]);
  });

  it("re-extracts every file of the project when its declarations change", async () => {
    await indexOnce();
    // Same length, mtime kept: only the declaration hash tells.
    const dtsPath = path.join(tmpDir, "src/auto-imports.d.ts");
    const { atime, mtime } = fs.statSync(dtsPath);
    fs.writeFileSync(dtsPath, DTS.replace("'./composables/x'", "'./composables/y'"));
    fs.utimesSync(dtsPath, atime, mtime);

    expect(await extracted()).toHaveLength(15);
    expect(await callersOfUseX()).toEqual([]);
  });

  it("re-extracts the project and drops its auto-import edges when the declarations are deleted", async () => {
    await indexOnce();
    fs.rmSync(path.join(tmpDir, "src/auto-imports.d.ts"));

    expect(await extracted()).toHaveLength(14);
    expect(await callersOfUseX()).toEqual([]);
  });

  it("re-extracts the auto-import callers of an edited file, keeping their edges", async () => {
    await indexOnce();
    // The declaration moves a line down: its node id changes and its incoming edges are dropped.
    write("src/composables/x.ts", "// moved\nexport function useX() { return 1; }\n");

    expect(await extracted()).toEqual(["src/composables/x.ts", "src/page.ts"]);
    expect(await callersOfUseX()).toEqual(["page"]);
  });

  it("reports a Nuxt project without .nuxt/imports.d.ts once", async () => {
    write("package.json", JSON.stringify({ devDependencies: { nuxt: "^3" } }));
    write("nuxt.config.ts", "export default {}\n");
    for (const app of ["b", "c", "d"]) {
      write(`apps/${app}/package.json`, JSON.stringify({ dependencies: { nuxt: "^3" } }));
      write(`apps/${app}/nuxt.config.ts`, "export default {}\n");
      write(`apps/${app}/app.ts`, "export function app() {}\n");
    }
    const notice = vi.fn();
    workerState.callGraphNotice = notice;
    await indexOnce();
    workerState.callGraphNotice = notice;
    await indexOnce();

    const hint = "run nuxi prepare (or nuxi dev) to generate it";
    expect(workerState.callGraphAutoImports?.missing).toEqual([
      { project: ".", source: ".nuxt/imports.d.ts", hint },
      ...["b", "c", "d"].map(app => ({ project: `apps/${app}`, source: ".nuxt/imports.d.ts", hint })),
    ]);
    expect(notice.mock.calls).toEqual([[`auto-imported names stay unresolved in the call graph; .nuxt/imports.d.ts is missing in ., apps/b, apps/c and 1 more: ${hint}.`]]);
  });
});
