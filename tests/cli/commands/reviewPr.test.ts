import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import { CliError } from "../../../src/cli/errors";
import { run } from "../../../src/cli/commands/reviewPr";
import type { CliRuntime } from "../../../src/cli/runtime";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-pr-cli-"));
  temporaryDirectories.push(workspace);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "api.ts"), "export function greet(name: string): string { return name; }\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "base"], { cwd: workspace });
  await fs.writeFile(path.join(workspace, "src", "api.ts"), "export function greet(name: string, formal: boolean): string { return name; }\n");
  return workspace;
}

afterEach(async () => {
  workerState.reset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("review-pr command", () => {
  it("indexes first and renders the review as Markdown", async () => {
    const workspace = await createWorkspace();
    const ensureIndexed = async (): Promise<{ filesIndexed: number; durationMs: number }> => ({ filesIndexed: 1, durationMs: 1 });
    const runtime = { workspaceRoot: workspace, ensureIndexed } as CliRuntime;
    workerState.spider = { getSymbolDependents: async () => [], getSymbolGraph: async () => ({ symbols: [], dependencies: [] }), findUnusedSymbols: async () => [] } as never;
    workerState.parser = {} as never;
    workerState.resolver = {} as never;
    workerState.config = { rootDir: workspace, excludeNodeModules: true, maxDepth: 3 };
    workerState.isReady = true;

    await expect(run(["--base", "main"], runtime, "markdown")).resolves.toContain("Graph-It Review Gate");
  });

  it("rejects missing and non-integer review options", async () => {
    const runtime = {} as CliRuntime;
    await expect(run([], runtime, "json")).rejects.toBeInstanceOf(CliError);
    await expect(run(["--base", "main", "--depth", "2.5"], runtime, "json")).rejects.toThrow("--depth must be an integer");
    await expect(run(["--base", "main", "--max-files", "bad"], runtime, "json")).rejects.toThrow("--max-files must be an integer");
  });
});