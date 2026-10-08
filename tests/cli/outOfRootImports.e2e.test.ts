/**
 * E2E regression for #264: a scan from a monorepo sub-package used to drop the
 * imports resolving into sibling packages silently, so dependents, impact and
 * dead-code answers looked complete when they were not. Drives the real binary
 * (CLI and `graph-it serve`) against the two-package fixture from the issue.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSession, startMcpSession } from "./mcpSession";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/mcpServer.mjs"));

interface IndexStatus {
  outOfRootImports: number;
  outOfRootImportExamples?: string[];
  monorepoRoot?: string;
  warning?: string;
}

describe.skipIf(!distExists)("out-of-root imports (E2E)", { timeout: 180_000 }, () => {
  let tmp: string;
  let mono: string;
  let worker: string;

  const write = (relative: string, content: string) => {
    const file = path.join(mono, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  /** Run the CLI from `cwd`; returns stdout, stderr (progress \r normalized) and the exit code. */
  const cli = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [DIST_ENTRY, ...args], { cwd, encoding: "utf-8" });
    return { stdout: result.stdout, stderr: result.stderr.replaceAll("\r", "\n"), status: result.status };
  };
  const json = <T>(cwd: string, ...args: string[]): T =>
    JSON.parse(execFileSync(process.execPath, [DIST_ENTRY, ...args, "--format", "json"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })) as T;

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-264-")));
    mono = path.join(tmp, "mono");
    worker = path.join(mono, "apps", "worker");
    write("package.json", '{ "name": "mono", "private": true, "workspaces": ["core", "apps/*"] }');
    write("tsconfig.json", '{ "compilerOptions": { "strict": true, "baseUrl": "." } }');
    write("core/package.json", '{ "name": "core", "version": "1.0.0" }');
    write("core/src/x.ts", "export const x = 1;\n");
    write("core/src/index.ts", 'export const load = () => import("../../apps/worker/src/a");\n');
    write("apps/worker/package.json", '{ "name": "worker", "version": "1.0.0" }');
    write(
      "apps/worker/tsconfig.json",
      '{ "extends": "../../tsconfig.json", "compilerOptions": { "baseUrl": ".", "paths": { "@core/*": ["../../core/src/*"] } } }',
    );
    write("apps/worker/src/a.ts", 'import { x } from "@core/x";\nimport { y } from "./y";\nexport const a = () => x + y;\n');
    write("apps/worker/src/y.ts", "export const y = 2;\n");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("a sub-package scan warns on stderr with the --workspace to rerun with, and status counts the drop", () => {
    const scan = cli(worker, "scan");
    expect(scan.status).toBe(0);
    expect(scan.stderr).toContain(
      "Warning: 1 import resolves outside the workspace root and was skipped (e.g. @core/x)",
    );
    expect(scan.stderr).toContain("Rerun with --workspace ../.. to include them.");

    // A warm cache hit (nothing re-analyzed) still knows about the drop.
    expect(cli(worker, "scan").stderr).toContain("Rerun with --workspace ../..");

    const status = json<IndexStatus>(worker, "tool", "get_index_status");
    expect(status).toMatchObject({ outOfRootImports: 1, outOfRootImportExamples: ["@core/x"], monorepoRoot: "../.." });
    expect(JSON.stringify(status)).not.toContain(tmp);
  });

  it("the narrow scan misses the cross-package consumer that the root scan finds", () => {
    const narrow = json<{ referencingFileCount: number }>(
      worker, "tool", "find_referencing_files", "--args", '{"targetPath":"src/a.ts"}',
    );
    expect(narrow.referencingFileCount).toBe(0);

    const rootScan = cli(mono, "scan");
    expect(rootScan.status).toBe(0);
    expect(rootScan.stderr).not.toContain("Warning:");
    expect(json<IndexStatus>(mono, "tool", "get_index_status").outOfRootImports).toBe(0);

    const wide = json<{ referencingFiles: Array<{ relativePath: string }> }>(
      mono, "tool", "find_referencing_files", "--args", '{"targetPath":"apps/worker/src/a.ts"}',
    );
    expect(wide.referencingFiles.map((file) => file.relativePath)).toEqual(["core/src/index.ts"]);
  });

  it("takes an explicit --workspace as given instead of climbing to a package root", () => {
    const nopkg = path.join(mono, "core", "nopkg");
    fs.mkdirSync(nopkg, { recursive: true });
    fs.writeFileSync(path.join(nopkg, "z.ts"), "export const z = 1;\n");

    const scan = cli(tmp, "-w", nopkg, "scan");
    expect(scan.status).toBe(0);
    expect(scan.stderr).toContain("Indexed 1/1 files");
    expect(fs.existsSync(path.join(nopkg, ".graph-it"))).toBe(true);

    const missing = cli(tmp, "-w", "missing", "scan");
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain("Workspace directory not found: missing");
  });

  it("MCP reports the drop and names the root set_workspace switched to, without absolute paths", async () => {
    const { child, callTool } = await startMcpSession(DIST_ENTRY, worker, worker);
    const data = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await callTool(name, { ...args, response_format: "json" });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(tmp);
      return (result.structuredContent as { data: Record<string, unknown> }).data;
    };
    try {
      expect(await data("graphitlive_get_index_status")).toMatchObject({ outOfRootImports: 1, monorepoRoot: "../.." });

      const switched = await data("graphitlive_set_workspace", { workspacePath: mono });
      expect(switched).toMatchObject({ workspaceName: "mono", previousWorkspace: "apps/worker" });
      expect(switched.message).toMatch(/^Workspace set to mono\./);

      expect((await data("graphitlive_get_index_status")).outOfRootImports).toBe(0);
    } finally {
      await closeSession(child);
    }
  });
});
