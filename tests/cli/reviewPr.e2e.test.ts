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

/** The #261 fixture: a new required parameter, six tested consumers, none updated. */
async function createUntouchedTestedConsumersRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-pr-e2e-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "Review PR E2E");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), '{ "name": "fx", "version": "0.0.0" }\n');
  await fs.writeFile(path.join(root, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
  await fs.writeFile(path.join(root, "src", "api.ts"), "export function api(a: number): number {\n  return a + 1;\n}\n");
  for (let i = 1; i <= 6; i += 1) {
    await fs.writeFile(
      path.join(root, "src", `c${i}.ts`),
      `import { api } from "./api";\nexport function use${i}(): number {\n  return api(${i});\n}\n`,
    );
    await fs.writeFile(
      path.join(root, "src", `c${i}.test.ts`),
      `import { use${i} } from "./c${i}";\nif (use${i}() !== ${i + 1}) throw new Error("c${i}");\n`,
    );
  }
  git("add", "-A");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  await fs.writeFile(path.join(root, "src", "api.ts"), "export function api(a: number, b: string): number {\n  return a + b.length;\n}\n");
  git("commit", "-am", "api: add required parameter b");
  return root;
}

const runCli = (...args: string[]): string =>
  execFileSync(process.execPath, [cliEntry, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe.skipIf(!fsSync.existsSync(cliEntry))("review-pr CLI E2E", { timeout: 15_000 }, () => {
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

  it("does not rate a required-parameter change low when tested consumers are left untouched (#261)", async () => {
    const root = await createUntouchedTestedConsumersRepository();
    try {
      runCli("scan", "--workspace", root);
      const result = JSON.parse(runCli("review-pr", "--workspace", root, "--base", "main", "--format", "json")) as {
        risk: string;
        symbols: Array<{
          name: string;
          risk: string;
          consumers: { updated: string[]; covered: string[]; unverified: string[] };
          scoreFactors: { unverifiedConsumers: number };
          evidence: Array<{ kind: string; detail: string }>;
        }>;
      };
      const api = result.symbols.find((symbol) => symbol.name === "api");
      expect(result.risk).not.toBe("low");
      expect(api?.risk).toBe("high");
      expect(api?.consumers.updated).toEqual([]);
      expect(api?.consumers.covered).toHaveLength(6);
      expect(api?.scoreFactors.unverifiedConsumers).toBe(30);
      expect(api?.evidence.find((item) => item.kind === "consumers")?.detail)
        .toContain("0 updated in this diff, 6 must be updated (6 with tests that will fail, 0 unverified)");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
