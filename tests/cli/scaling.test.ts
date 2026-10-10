import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { LanguageService } from "@/analyzer/LanguageService";
import { ReverseIndex } from "@/analyzer/ReverseIndex";
import { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { ensureCallGraphReady, executeQueryCallGraph } from "@/mcp/tools/callgraph";
import { executeFindReferencingFiles } from "@/mcp/tools/graph";
import { normalizePath } from "@/shared/path";
import { jsonToToon } from "@/shared/toon";
import { REPO_ROOT, wasmBuilt } from "../mcp/tools/callGraphWorkspace";

// Every path-keyed Set/Map access must go through normalizePath() (project rule),
// so its call count tracks path lookups: a linear lookup inside a per-file loop
// shows up as a quadratic number of calls.
vi.mock("@/shared/path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/path")>();
  return { ...actual, normalizePath: vi.fn(actual.normalizePath) };
});

/**
 * Issue #292: an accidental O(n²) only shows on large workspaces. Run the same
 * operations on a generated workspace of n and 4n files and assert the work
 * counters grow linearly. Counters, not timings, so the ratio is the same on
 * every machine and OS: linear work gives ≤ 4, n·log n about 5, n² about 16.
 */
const SMALL = 250;
const LARGE = 4 * SMALL;
const MAX_RATIO = 6;

type Counters = Record<string, number>;

/**
 * Neutral workspace of n files: every module imports the hub, one module through
 * a relative path and one through the `@/` alias, so fan-in and fan-out vary.
 * Deterministic: the same n always produces the same files.
 */
function generateWorkspace(n: number): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-scaling-")));
  const write = (relPath: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root, relPath), content);
  };
  write("package.json", "{}");
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  write("src/hub.ts", "export function hub() { return 0; }\n");
  const modules = n - 1;
  for (let i = 0; i < modules; i++) {
    const rel = (i * 7 + 1) % modules;
    const alias = (i * 13 + 5) % modules;
    write(`src/m${i}.ts`, [
      'import { hub } from "./hub";',
      `import { m${rel} as a } from "./m${rel}";`,
      `import { m${alias} as b } from "@/m${alias}";`,
      `export function m${i}() { return hub() + a() + b(); }`,
      "",
    ].join("\n"));
  }
  return root;
}

/** Work done by one `graph-it` process, per phase: index, then hub queries. */
async function runProcess(workspace: string, modules: number): Promise<{ index: Counters; queries: Counters }> {
  const normalizeCalls = vi.mocked(normalizePath);
  const spies = {
    diskHashes: vi.spyOn(ReverseIndex, "getFileHashFromDisk"),
    parsed: vi.spyOn(GraphExtractor.prototype, "extractFile"),
  };
  const take = (): Counters => {
    const counters: Counters = { paths: normalizeCalls.mock.calls.length };
    for (const [name, spy] of Object.entries(spies)) counters[name] = spy.mock.calls.length;
    normalizeCalls.mockClear();
    for (const spy of Object.values(spies)) spy.mockClear();
    return counters;
  };

  LanguageService.reset();
  const runtime = new CliRuntime(workspace);
  try {
    take();
    await runtime.init();
    // Under Vitest the runtime derives its package root from src/, not dist/.
    workerState.config = { ...workerState.getConfig(), extensionPath: REPO_ROOT };
    // Reverse index (full build or cache restore + validation), then call graph (build + exportDb).
    await runtime.ensureIndexed({ silent: true });
    await ensureCallGraphReady();
    const index = take();

    const db = workerState.callGraphIndexer!.getDb();
    const sql = [vi.spyOn(db, "exec"), vi.spyOn(db, "prepare")];
    const hub = path.join(workspace, "src", "hub.ts");
    const references = await executeFindReferencingFiles({ targetPath: hub });
    const callers = await executeQueryCallGraph({ filePath: hub, symbolName: "hub", direction: "callers", depth: 1 });
    // Guard the fixture: the hub must really be the fan-in of every module.
    expect(references.referencingFileCount).toBe(modules);
    expect(callers.totalCallers).toBe(modules);
    const queries = { ...take(), sql: sql.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
    return { index, queries };
  } finally {
    vi.restoreAllMocks();
    await runtime.dispose();
  }
}

/** Measure a cold process (full builds) and a warm one (cache restore + validation). */
async function measure(n: number) {
  const workspace = generateWorkspace(n);
  try {
    const cold = await runProcess(workspace, n - 1);
    const warm = await runProcess(workspace, n - 1);
    return { cold, warm };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/** Every counter of the 4n run stays within MAX_RATIO times the n run. */
function expectLinear(small: Counters, large: Counters): void {
  for (const [name, count] of Object.entries(small)) {
    expect(large[name], `${name}: ${count} at n, ${large[name]} at 4n`).toBeLessThanOrEqual(MAX_RATIO * count);
  }
}

describe.runIf(wasmBuilt)("scaling n vs 4n", () => {
  let small: Awaited<ReturnType<typeof measure>>;
  let large: Awaited<ReturnType<typeof measure>>;

  beforeAll(async () => {
    small = await measure(SMALL);
    large = await measure(LARGE);
  }, 120_000);

  it("builds the reverse index and the call graph in linear work", () => {
    expect(small.cold.index.parsed).toBe(SMALL);
    expectLinear(small.cold.index, large.cold.index);
  });

  it("restores and validates the caches in linear work", () => {
    expect(small.warm.index).toMatchObject({ diskHashes: SMALL, parsed: 0 });
    expectLinear(small.warm.index, large.warm.index);
  });

  it("answers hub queries in linear work", () => {
    expect(small.cold.queries.sql).toBeGreaterThan(0);
    expectLinear(small.cold.queries, large.cold.queries);
    expectLinear(small.warm.queries, large.warm.queries);
  });
});

describe("jsonToToon scaling n vs 4n", () => {
  /** Property and index reads jsonToToon makes on n rows, counted through proxies. */
  const readsFor = (n: number): number => {
    let reads = 0;
    const count = <T extends object>(target: T): T => new Proxy(target, {
      get(obj, key, receiver) {
        reads++;
        return Reflect.get(obj, key, receiver);
      },
    });
    const rows = Array.from({ length: n }, (_, i) =>
      count({ id: `n${i}`, path: `src/m${i}.ts`, line: i, ...(i % 2 ? { exported: true } : {}) }));
    expect(jsonToToon(count(rows), { objectName: "nodes" }).split("\n")).toHaveLength(n + 1);
    return reads;
  };

  it("encodes 4n rows in linear work", () => {
    const small = readsFor(1_000);
    expect(readsFor(4_000)).toBeLessThanOrEqual(MAX_RATIO * small);
  });
});
