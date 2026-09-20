import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(__dirname, "../..");
const cliEntry = path.join(repositoryRoot, "dist", "graph-it.js");

async function createRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-pr-e2e-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Review PR E2E"], { cwd: root });
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "api.ts"), "export function greet(name: string): string { return name; }\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root });
  await fs.writeFile(path.join(root, "src", "api.ts"), "export function greet(name: string, formal: boolean): string { return name; }\n");
  return root;
}

describe.skipIf(!fsSync.existsSync(cliEntry))("review-pr CLI E2E", () => {
  it("runs the built entry point against a real working-tree diff", async () => {
    const root = await createRepository();
    try {
      const output = execFileSync(process.execPath, [
        cliEntry,
        "review-pr",
        "--workspace",
        root,
        "--base",
        "main",
        "--format",
        "json",
      ], { encoding: "utf8" });
      const result = JSON.parse(output) as { changedFiles: string[]; symbols: Array<{ breakingChanges: unknown[] }> };
      expect(result.changedFiles).toContain("src/api.ts");
      expect(result.symbols.some((symbol) => symbol.breakingChanges.length > 0)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
