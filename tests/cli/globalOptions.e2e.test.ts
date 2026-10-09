/**
 * E2E coverage for global options and numeric option validation (#226, #230).
 *
 * Global flags are parsed in `main()` (`src/cli/index.ts`), which only runs when
 * the built bundle is the process entry point, so these tests drive the binary.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSession, startMcpSession } from "./mcpSession";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/mcpServer.mjs"));

const SUBPROCESS_TIMEOUT_MS = 60_000;

describe.skipIf(!distExists)("CLI global options (E2E)", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  let tmpDir: string;
  let otherCwd: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-globals-")));
    otherCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-cwd-")));
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "src/b.ts"), "export function helper() { return 1; }\n");
    fs.writeFileSync(
      path.join(tmpDir, "src/a.ts"),
      'import { helper } from "./b";\nexport function run() { return helper(); }\n',
    );
  });

  afterEach(() => {
    // Windows releases a dead process's cwd with a delay.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(otherCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Run the CLI from an unrelated cwd so only --workspace can point at tmpDir. */
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [DIST_ENTRY, ...args], { cwd: otherCwd, encoding: "utf-8" });

  it("keeps --workspace and its value out of the query question", () => {
    const result = cli("query", "what calls helper", "--workspace", tmpDir, "--format", "json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).question).toBe("what calls helper");
  });

  it("keeps -f out of the query question", () => {
    const result = cli("-w", tmpDir, "query", "what calls helper", "-f", "json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).question).toBe("what calls helper");
  });

  it.each([
    ["--format text", ["--format", "text"]],
    ["-f text", ["-f", "text"]],
    ["no --format", []],
  ])("query with %s prints text output (#244)", (_label, formatArgs) => {
    const result = cli("-w", tmpDir, "query", "what calls helper", ...formatArgs);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Question: what calls helper");
    expect(result.stdout).not.toMatch(/^nodes\[/m);
  });

  it("query -f toon prints the TOON subgraph", () => {
    const result = cli("-w", tmpDir, "query", "what calls helper", "-f", "toon");

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Question:");
  });

  it.each([
    ["json", (out: string) => expect(JSON.parse(out).articlesCount).toBeGreaterThan(0)],
    ["toon", (out: string) => expect(out).toContain("wiki articles=")],
    ["text", (out: string) => expect(out).toContain("# Wiki generated")],
  ] as const)("wiki honours the global %s format", (format, check) => {
    const result = cli("-w", tmpDir, "wiki", "--output", "out", "--format", format);

    expect(result.status).toBe(0);
    check(result.stdout);
  });

  it("accepts the global -f option after the context command", () => {
    const result = cli("context", "what calls helper", "-f", "json", "-w", tmpDir);

    expect(result.stderr).not.toContain("Invalid context option");
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("rejects a non-numeric trace --maxDepth with a usage error", () => {
    const result = cli("-w", tmpDir, "trace", "src/a.ts#run", "--maxDepth", "nope");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`--maxDepth must be an integer between 1 and 100, got "nope"`);
    expect(result.stdout).not.toContain("maxDepth");
  });

  it("still runs trace with a valid --maxDepth", () => {
    const result = cli("-w", tmpDir, "trace", "src/a.ts#run", "--maxDepth", "2", "-f", "json");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("helper");
  });

  const startSession = () => startMcpSession(DIST_ENTRY, tmpDir, otherCwd);

  it("serve --workspace answers a tool call on a file of that workspace from another cwd", async () => {
    const { child, callTool } = await startSession();
    try {
      const result = await callTool("graphitlive_analyze_dependencies", {
        filePath: path.join(tmpDir, "src/a.ts"),
        response_format: "json",
      });
      expect(result.isError).not.toBe(true);
      expect(result.content.map((c) => c.text).join("\n")).toContain("b.ts");
      expect(await closeSession(child)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  // Windows has no catchable SIGTERM/SIGINT for a spawned process: kill() ends
  // the CLI at once, so the forwarding path is covered by serve unit tests there.
  it.skipIf(process.platform === "win32").each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)("serve stops the server on %s with stdin still open (#241)", async (signal, exitCode) => {
    const child = spawn(process.execPath, [DIST_ENTRY, "serve", "--workspace", tmpDir], {
      cwd: otherCwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      const initialized = new Promise<void>((resolve) => {
        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          if (chunk.includes('"id":1')) resolve();
        });
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
        })}\n`,
      );
      await initialized;

      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.kill(signal);
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000));

      expect(await Promise.race([exited, timeout])).toBe(exitCode);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it.each(["toon", "json", "markdown"])("serve flags a failed %s tool call with isError and the error text (#238)", async (format) => {
    const { child, callTool } = await startSession();
    try {
      const result = await callTool("graphitlive_analyze_dependencies", {
        filePath: path.join(tmpDir, "src/missing.ts"),
        response_format: format,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found|does not exist|ENOENT/i);
      expect(await closeSession(child)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("set_workspace reports the indexed files after a cache restore (#243)", async () => {
    const { child, callTool } = await startSession();
    try {
      // The first call builds the index and saves the shared cache; the second
      // restarts the worker, which restores that cache instead of parsing.
      const select = async () => (await callTool("graphitlive_set_workspace", {
        workspacePath: tmpDir,
        response_format: "json",
      })).structuredContent?.data as { filesIndexed: number };
      expect((await select()).filesIndexed).toBe(2);
      expect((await select()).filesIndexed).toBe(2);
      expect(await closeSession(child)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("serve exits once the client closes stdin, without a signal", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY, "serve", "--workspace", tmpDir], {
      cwd: otherCwd,
      stdio: ["pipe", "ignore", "ignore"],
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(await closeSession(child)).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("reads tool --param value like --param=value, without \\r progress on piped stderr (#268)", () => {
    const file = path.join(tmpDir, "src/a.ts");
    const result = cli("tool", "generate_codemap", "-w", tmpDir, "--filePath", file, "--format", "json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).filePath).toBe(file);
    expect(result.stderr).not.toContain("\r");
  });

  it("rejects a stray tool argument with a usage error (#268)", () => {
    const result = cli("tool", "generate_codemap", "-w", tmpDir, path.join(tmpDir, "src/a.ts"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected argument");
  });

  it("lists a tool's parameters for tool <name> --help, generic help otherwise (#268)", () => {
    const toolHelp = cli("tool", "generate_codemap", "--help");
    expect(toolHelp.status).toBe(0);
    expect(toolHelp.stdout).toMatch(/--filePath <string>\s+required/);

    const generic = cli("tool", "nope", "--help");
    expect(generic.status).toBe(0);
    expect(generic.stdout).toContain("graph-it tool — Invoke any MCP tool directly");
  });
});

describe.skipIf(!distExists)("CLI numeric options (E2E)", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  it("fails wiki --top out of range before writing anything", () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-top-")));
    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "export const a = 1;\n");
      let status = 0;
      let stderr = "";
      try {
        execFileSync(process.execPath, [DIST_ENTRY, "-w", tmpDir, "wiki", "--top", "99"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const failure = error as { status: number; stderr: string };
        status = failure.status;
        stderr = failure.stderr;
      }
      expect(status).not.toBe(0);
      expect(stderr).toContain(`--top must be an integer between 1 and 50, got "99"`);
      expect(fs.existsSync(path.join(tmpDir, "wiki"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
