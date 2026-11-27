import { execFileSync, spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { closeSession, startMcpSession } from "../../scripts/mcpSession.mts";

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

/** The #516 fixture: `lib.ts` is deleted on `b1` and moved on `b2`, `user1.ts` keeps importing it. */
async function createDeletedModuleRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-pr-e2e-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "Review PR E2E");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), '{ "name": "fx", "version": "0.0.0" }\n');
  await fs.writeFile(path.join(root, "src", "lib.ts"), "export function lib(a: number): number { return a + 1; }\n");
  await fs.writeFile(path.join(root, "src", "user1.ts"), 'import { lib } from "./lib";\nexport function user1(): number { return lib(1) * 2; }\n');
  git("add", "-A");
  git("commit", "-m", "base");
  git("checkout", "-b", "b1");
  git("rm", "src/lib.ts");
  git("commit", "-m", "delete lib");
  git("checkout", "main");
  git("checkout", "-b", "b2");
  git("mv", "src/lib.ts", "src/lib_new.ts");
  git("commit", "-m", "move lib");
  return root;
}

/** #443: a rule forbids frontend → backend; the working tree adds such an import. */
async function createArchitectureRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-pr-e2e-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "Review PR E2E");
  await fs.mkdir(path.join(root, "frontend"));
  await fs.mkdir(path.join(root, "backend"));
  await fs.writeFile(path.join(root, "graphit.architecture.json"), JSON.stringify({
    elements: { frontend: { path: "frontend/" }, backend: { path: "backend/" } },
    rules: [{ name: "frontend-not-backend", from: "frontend", forbid: "backend", reason: "UI talks to the API only." }],
  }));
  await fs.writeFile(path.join(root, "backend", "db.ts"), "export const db = 1;\n");
  await fs.writeFile(path.join(root, "frontend", "app.ts"), "export const app = 1;\n");
  git("add", "-A");
  git("commit", "-m", "base");
  await fs.writeFile(path.join(root, "frontend", "app.ts"), 'import { db } from "../backend/db";\nexport const app = db;\n');
  return root;
}

const runCli = (...args: string[]): string =>
  execFileSync(process.execPath, [cliEntry, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** #345: `src/a` is renamed to `src/z` on `rename`; `bad` carries an invalid graphit.architecture.json. */
async function createFolderRenameRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-pr-e2e-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--initial-branch=main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "Review PR E2E");
  await fs.mkdir(path.join(root, "src", "a"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "b"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{ "name": "fx", "version": "0.0.0" }\n');
  for (let i = 1; i <= 3; i += 1) {
    await fs.writeFile(path.join(root, "src", "a", `f${i}.ts`), `export const f${i} = ${i};\n`);
  }
  await fs.writeFile(path.join(root, "src", "b", "user.ts"), 'import { f1 } from "../a/f1";\nexport const u = f1;\n');
  git("add", "-A");
  git("commit", "-m", "base");
  git("checkout", "-b", "rename");
  git("mv", "src/a", "src/z");
  await fs.writeFile(path.join(root, "src", "b", "user.ts"), 'import { f1 } from "../z/f1";\nexport const u = f1;\n');
  git("add", "-A");
  git("commit", "-m", "rename a to z");
  git("checkout", "-b", "bad", "main");
  await fs.writeFile(path.join(root, "graphit.architecture.json"), "{ nope");
  git("add", "-A");
  git("commit", "-m", "bad config");
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
  }, 60_000);

  it("reports a new architecture violation in every format, through the CLI and MCP alike (#443)", async () => {
    const root = await createArchitectureRepository();
    try {
      runCli("scan", "--workspace", root);
      const review = (format: string) => runCli("review-pr", "--workspace", root, "--base", "main", "--format", format);
      const cli = JSON.parse(review("json")) as { risk: string; architecture: { verdict: string; newErrors: number; rules: Array<{ name: string; newViolations: Array<{ source: string; target: string; line: number }> }> } };
      expect(cli.risk).toBe("high");
      expect(cli.architecture).toMatchObject({ verdict: "degraded", newErrors: 1 });
      expect(cli.architecture.rules[0].newViolations).toMatchObject([{ source: "frontend/app.ts", target: "backend/db.ts", line: 1 }]);

      const sarif = JSON.parse(review("sarif")) as { runs: Array<{ tool: { driver: { name: string } }; results: Array<{ ruleId: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }> }> }> };
      expect(sarif.runs[0].tool.driver.name).toBe("graph-it review-pr");
      expect(sarif.runs[0].results.map((result) => [result.ruleId, result.locations[0].physicalLocation.artifactLocation.uri, result.locations[0].physicalLocation.region.startLine]))
        .toEqual([["frontend-not-backend", "frontend/app.ts", 1]]);
      expect(review("markdown")).toContain("### Architecture rules: DEGRADED");
      expect(review("toon")).toContain("degraded");
      expect(review("text")).toContain("frontend-not-backend");

      const session = await startMcpSession(cliEntry, root, root);
      try {
        const mcp = JSON.parse((await session.callTool("graphitlive_review_pr", { baseRef: "main", response_format: "json" })).content[0].text);
        expect(mcp.data.architecture).toEqual(cli.architecture);
      } finally {
        await closeSession(session.child);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);

  // Two CLI runs plus an MCP session: Windows and macOS runners can take well over 15 s.
  it.each(["b1", "b2"])("reports the importer of a deleted or moved module, through the CLI and MCP alike (#516, %s)", async (head) => {
    const root = await createDeletedModuleRepository();
    try {
      runCli("scan", "--workspace", root);
      const cli = JSON.parse(runCli("review-pr", "--workspace", root, "--base", "main", "--head", head, "--format", "json")) as {
        risk: string;
        symbols: Array<{ name: string; consumers: { unverified: string[] } }>;
      };
      expect(cli.risk).toBe("high");
      expect(cli.symbols.find((symbol) => symbol.name === "lib")?.consumers.unverified).toEqual(["src/user1.ts"]);

      const session = await startMcpSession(cliEntry, root, root);
      try {
        const mcp = JSON.parse((await session.callTool("graphitlive_review_pr", { baseRef: "main", headRef: head, response_format: "json" })).content[0].text);
        expect(mcp.data).toEqual(cli);
      } finally {
        await closeSession(session.child);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
  it("reports the structure diff of a folder rename in every format, the CLI and MCP alike (#345)", async () => {
    const root = await createFolderRenameRepository();
    try {
      runCli("scan", "--workspace", root);
      const review = (format: string, head = "rename") => runCli("review-pr", "--workspace", root, "--base", "main", "--head", head, "--format", format);
      const cli = JSON.parse(review("json")) as { structure: { verdict: string; groups: { items: Array<{ status: string; key: string; previousKey?: string }> } } };
      expect(cli.structure.verdict).toBe("changed");
      expect(cli.structure.groups.items).toMatchObject([{ status: "RENAMED", previousKey: expect.stringContaining("a") }]);

      const toon = review("toon");
      expect(toon).toContain("structure.verdict=changed");
      expect(toon).toContain("structure.groups.items(");
      expect(toon).toContain("RENAMED");
      expect(review("markdown")).toContain("src/a -> src/z (3 files)");

      const session = await startMcpSession(cliEntry, root, root);
      try {
        const mcp = JSON.parse((await session.callTool("graphitlive_review_pr", { baseRef: "main", headRef: "rename", response_format: "json" })).content[0].text);
        expect(mcp.data.structure).toEqual(cli.structure);
        const mcpToon = (await session.callTool("graphitlive_review_pr", { baseRef: "main", headRef: "rename", response_format: "toon" })).content[0].text as string;
        expect(mcpToon).toContain("structure.groups.items(");
      } finally {
        await closeSession(session.child);
      }

      for (const format of ["json", "toon", "markdown"]) {
        const unknown = spawnSync(process.execPath, [cliEntry, "review-pr", "--workspace", root, "--base", "nope", "--format", format], { encoding: "utf8" });
        expect(unknown.status, format).not.toBe(0);
        expect(unknown.stderr).toContain('Unknown Git ref "nope"');
        const invalid = spawnSync(process.execPath, [cliEntry, "review-pr", "--workspace", root, "--base", "main", "--head", "bad", "--format", format], { encoding: "utf8" });
        expect(invalid.status, format).not.toBe(0);
        expect(invalid.stderr).toContain("graphit.architecture.json");
        expect(invalid.stdout).toBe("");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 120_000);
});
