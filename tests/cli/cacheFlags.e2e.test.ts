/**
 * E2E coverage for the index-cache global flags.
 *
 * The flags are wired in `main()` (`src/cli/index.ts`), which only runs when the
 * built bundle is the process entry point — importing the module under Vitest
 * never exercises that path. These tests drive the real binary against a
 * throwaway workspace, which is also the only way to observe the cache surviving
 * between two processes, the thing the cache exists for.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphContextResponse } from "@/shared/graph-context-types";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY);

const SUBPROCESS_TIMEOUT_MS = 60_000;

describe.skipIf(!distExists)("CLI index cache flags (E2E)", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  let tmpDir: string;
  let cacheDir: string;

  /** Run the built CLI and return its stdout. */
  const cli = (...args: string[]): string =>
    execFileSync(process.execPath, [DIST_ENTRY, "-w", tmpDir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

  /** Same, but capturing stderr (where progress and cache provenance are printed). */
  const cliStderr = (...args: string[]): string => {
    const errFile = path.join(tmpDir, "stderr.log");
    const fd = fs.openSync(errFile, "w");
    try {
      execFileSync(process.execPath, [DIST_ENTRY, "-w", tmpDir, ...args], {
        stdio: ["ignore", "ignore", fd],
      });
    } finally {
      fs.closeSync(fd);
    }
    // Progress rewrites the line with \r; normalize so assertions stay readable.
    return fs.readFileSync(errFile, "utf-8").replaceAll("\r", "\n");
  };

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-flags-")));
    cacheDir = path.join(tmpDir, ".graph-it", "cache");
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "src/b.ts"), "export const b = () => 1;\n");
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `src/f${i}.ts`),
        `import { b } from "./b";\nexport const f${i} = () => b();\n`,
      );
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a cache on the first run and reuses it on the second", () => {
    const first = cliStderr("summary");
    expect(first).toContain("Indexed");
    expect(first).not.toContain("from cache");
    expect(fs.existsSync(path.join(cacheDir, "reverse-index.json"))).toBe(true);

    const second = cliStderr("summary");
    expect(second).toContain("from cache");
  });

  it("produces the same analysis warm as with --no-cache", () => {
    cli("summary");

    // Provenance and timing fields (fromCache, filesAnalyzed, analysisTimeMs)
    // differ by design; compare the analysis payload itself instead of the raw
    // text, so the assertion cannot be tripped by a field that is meant to vary.
    const analysis = (...args: string[]) => {
      const parsed = JSON.parse(cli(...args, "-f", "json")) as {
        filePath: string;
        language: string;
        graph: unknown;
      };
      return { filePath: parsed.filePath, language: parsed.language, graph: parsed.graph };
    };

    const warm = analysis("explain", "src/b.ts");
    const cold = analysis("--no-cache", "explain", "src/b.ts");

    expect(warm).toEqual(cold);
    expect(warm.filePath).toContain("b.ts");
  });

  it("--no-cache writes no cache at all", () => {
    cli("--no-cache", "summary");

    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("drops deleted references when a warm workspace requires a full rebuild", () => {
    cli("summary");
    for (let i = 0; i < 6; i++) fs.rmSync(path.join(tmpDir, `src/f${i}.ts`));

    const result = JSON.parse(cli("path-in", "src/b.ts", "--format", "json")) as { referencingFiles: unknown[] };
    expect(result.referencingFiles).toHaveLength(6);
  });

  it("does not return symbols removed from a cached file", () => {
    const args = ["context", "--seeds", "src/f0.ts#f0", "--format", "json"];
    cli(...args);
    fs.writeFileSync(path.join(tmpDir, "src/f0.ts"), "// no symbols remain\n");

    const result = JSON.parse(cli(...args)) as GraphContextResponse;
    expect(result.nodes).toEqual([]);
  });

  it("re-resolves imports after an alias changes between processes", () => {
    const config = (target: string) => JSON.stringify({ compilerOptions: { paths: { "@dep": [target] } } });
    fs.writeFileSync(path.join(tmpDir, "src/other.ts"), "export const b = () => 2;\n");
    fs.writeFileSync(path.join(tmpDir, "src/f0.ts"), "import { b } from '@dep';\nexport const f0 = () => b();\n");
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), config("src/b.ts"));
    cli("summary");
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), config("src/other.ts"));

    const result = JSON.parse(cli("path-in", "src/other.ts", "--format", "json")) as { referencingFiles: unknown[] };
    expect(result.referencingFiles).toHaveLength(1);
  });

  it("continues a cursor in a new process using the cached graph", () => {
    const args = ["context", "--seeds", "src/b.ts#b", "--mode", "neighbors", "--max-nodes", "2", "--format", "json"];
    const first = JSON.parse(cli(...args)) as GraphContextResponse;
    expect(first.nextCursor).toBeTypeOf("string");

    const second = JSON.parse(cli(...args, "--cursor", first.nextCursor!)) as GraphContextResponse;
    expect(second.indexRevision).toBe(first.indexRevision);
    expect(second.nodes.length).toBeGreaterThan(0);
    expect(second.nodes.some(node => first.nodes.some(previous => previous.id === node.id))).toBe(false);
  });

  it("GRAPH_IT_NO_CACHE=1 writes no cache at all", () => {
    execFileSync(process.execPath, [DIST_ENTRY, "-w", tmpDir, "summary"], {
      stdio: "ignore",
      env: { ...process.env, GRAPH_IT_NO_CACHE: "1" },
    });

    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("--reindex discards the cache and rebuilds", () => {
    cli("summary");
    const before = fs.readFileSync(path.join(cacheDir, "meta.json"), "utf-8");

    const stderr = cliStderr("--reindex", "summary");

    expect(stderr).toContain("Indexed");
    expect(stderr).not.toContain("from cache");
    expect(fs.readFileSync(path.join(cacheDir, "meta.json"), "utf-8")).not.toBe(before);
  });

  it("lists the cache flags in --help", () => {
    const out = execFileSync(process.execPath, [DIST_ENTRY, "--help"], { encoding: "utf-8" });

    expect(out).toContain("--reindex");
    expect(out).toContain("--no-cache");
  });
});

describe.skipIf(!distExists)("CLI help completeness (E2E)", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  const help = (): string =>
    execFileSync(process.execPath, [DIST_ENTRY, "--help"], { encoding: "utf-8" });

  /** Command names the dispatcher actually accepts, read from the source. */
  const dispatchedCommands = (): string[] => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src/cli/index.ts"), "utf-8");
    const dispatch = src.slice(src.indexOf("async function dispatch("));
    const fromSwitch = [...dispatch.matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1]);
    // `context` is handled before the switch, so it never appears as a case.
    return [...new Set([...fromSwitch, "context"])];
  };

  it("lists every command the dispatcher accepts", () => {
    const out = help();
    const missing = dispatchedCommands().filter(
      (cmd) => !new RegExp(`^\\s{2}${cmd}[\\s<[]`, "m").test(out),
    );

    expect(missing).toEqual([]);
  });

  it("documents the no-argument REPL and per-command help", () => {
    const out = help();

    expect(out).toContain("interactive REPL");
    expect(out).toContain("<command> --help");
  });

  it("ends on the examples block, with no dangling command line after it", () => {
    const lines = help().trimEnd().split("\n");

    expect(lines.at(-1)).toMatch(/^ {2}graph-it /);
  });
});
