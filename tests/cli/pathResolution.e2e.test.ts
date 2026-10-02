/**
 * Relative file paths must be read from the workspace they were validated
 * against, never from the process cwd (GHSA-2pv3-2vx4-vf28, CWE-22).
 *
 * Two directories hold a different `probe.ts`; the CLI and the MCP server run
 * from `outside/` with `--workspace workspace/`.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/mcpServer.mjs"));

const WORKSPACE_PROBE = 'import { w } from "./workspace-only";\nexport function kept() { return w; }\n';
const OUTSIDE_PROBE = 'import { o } from "./outside-only";\nexport function other() { return o; }\n';

describe.skipIf(!distExists)("relative file paths resolve against the workspace (E2E)", { timeout: 60_000 }, () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-paths-")));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside");
    for (const [dir, probe] of [[workspace, WORKSPACE_PROBE], [outside, OUTSIDE_PROBE]]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      fs.writeFileSync(path.join(dir, "probe.ts"), probe);
    }
  });

  afterEach(() => {
    // Windows releases a dead process's cwd with a delay.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [DIST_ENTRY, "-w", workspace, ...args], { cwd: outside, encoding: "utf-8" });

  it("tool parse_imports reads the workspace file", () => {
    const result = cli("tool", "parse_imports", "--filePath=probe.ts", "--format", "json");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("./workspace-only");
    expect(result.stdout).not.toContain("./outside-only");
  });

  it("tool analyze_breaking_changes compares against the workspace file", () => {
    const result = cli("tool", "analyze_breaking_changes", "--filePath=probe.ts", `--oldContent=${WORKSPACE_PROBE}`, "--format", "json");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).breakingChangeCount).toBe(0);
  });

  it("serve analyze_breaking_changes compares against the workspace file", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY, "serve", "--workspace", workspace], {
      cwd: outside,
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      let buffer = "";
      const response = (id: number) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const onData = () => {
            for (const line of buffer.split("\n")) {
              if (!line.startsWith("{")) continue;
              const message = JSON.parse(line) as { id?: number };
              if (message.id === id) {
                child.stdout.off("data", onData);
                resolve(message);
                return;
              }
            }
          };
          child.stdout.on("data", (chunk: string) => { buffer += chunk; });
          child.stdout.on("data", onData);
        });
      child.stdout.setEncoding("utf-8");
      const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
      });
      await response(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "graphitlive_analyze_breaking_changes",
          arguments: { filePath: "probe.ts", oldContent: WORKSPACE_PROBE, response_format: "json" },
        },
      });
      const result = (await response(2)).result as { structuredContent: { data: { breakingChangeCount: number } } };

      expect(result.structuredContent.data.breakingChangeCount).toBe(0);
    } finally {
      // Let the server finish writing its cache before afterEach removes the workspace.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      if (child.exitCode === null) child.kill();
    }
  });
});
