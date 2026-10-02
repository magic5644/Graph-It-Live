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

  /** End the MCP session like a client does: close stdin, then wait for the process tree to exit. */
  const closeSession = async (child: ReturnType<typeof spawn>): Promise<number | null> => {
    if (child.exitCode !== null) return child.exitCode;
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.stdin?.end();
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000));
    const outcome = await Promise.race([exited, timeout]);
    if (outcome === "timeout") {
      child.kill();
      throw new Error("MCP server did not exit after stdin closed");
    }
    return outcome;
  };

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

  it("serve --workspace answers a tool call on a file of that workspace from another cwd", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY, "serve", "--workspace", tmpDir], {
      cwd: otherCwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      const responses = new Map<number, Record<string, unknown>>();
      let buffer = "";
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("{")) {
            const message = JSON.parse(line) as { id?: number };
            if (typeof message.id === "number") responses.set(message.id, message);
          }
          newline = buffer.indexOf("\n");
        }
      });
      const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const waitFor = async (id: number) => {
        const deadline = Date.now() + 45_000;
        while (!responses.has(id)) {
          if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no response ${id}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return responses.get(id)!;
      };

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
      });
      await waitFor(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "graphitlive_analyze_dependencies",
          arguments: { filePath: path.join(tmpDir, "src/a.ts"), response_format: "json" },
        },
      });

      const response = await waitFor(2);
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
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
