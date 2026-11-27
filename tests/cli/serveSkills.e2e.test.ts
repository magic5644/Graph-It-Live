/**
 * The bundled agent skills over the built `graph-it serve` (#837): served by
 * default through the MCP Skills extension, not served with --no-skills.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeSession, startMcpSession } from "../../scripts/mcpSession.mts";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/skills"));
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** Raw JSON-RPC over `graph-it serve`: replies and notifications by arrival. */
function rawSession(cwd: string) {
  const child = spawn(process.execPath, [DIST_ENTRY, "serve"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  const messages: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    messages.push(...lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>));
  });
  const waitFor = (match: (message: Record<string, unknown>) => boolean) =>
    vi.waitUntil(() => messages.find(match), { timeout: 45_000, interval: 20 });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return waitFor((message) => message.id === id);
  };
  return { child, request, waitFor };
}

describe.skipIf(!distExists)("bundled skills over graph-it serve (E2E)", { timeout: 120_000 }, () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-skills-")));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("declares the Skills extension and serves the five skills", async () => {
    const { child, request, initialize } = await startMcpSession(DIST_ENTRY, tmpDir, tmpDir);
    try {
      const capabilities = (initialize.result as { capabilities: { extensions?: Record<string, unknown> } }).capabilities;
      expect(capabilities.extensions).toHaveProperty([SKILLS_EXTENSION]);
      const { skills } = (await request("skills/list", {})).result as { skills: { frontmatter: { name: string } }[] };
      expect(skills.map((skill) => skill.frontmatter.name)).toEqual([
        "dead-code-hunter",
        "graph-it-live",
        "graph-it-refactor",
        "onboarding-express",
        "pr-review",
      ]);
      const outside = await request("resources/read", { uri: "skill://pr-review/../../../package.json" });
      expect(outside.error).toBeDefined();
      expect(outside.result).toBeUndefined();
    } finally {
      await closeSession(child);
    }
  });

  it("serves the skills and change subscriptions on a 2026-07-28 connection", async () => {
    const { child, request, waitFor } = rawSession(tmpDir);
    try {
      const discover = await request("server/discover", { _meta: MODERN_META });
      expect(discover.result).toMatchObject({ capabilities: { extensions: { [SKILLS_EXTENSION]: {} } } });
      void request("subscriptions/listen", { _meta: MODERN_META, notifications: { toolsListChanged: true } });
      await waitFor((message) => message.method === "notifications/subscriptions/acknowledged");
      const list = await request("skills/list", { _meta: MODERN_META });
      expect((list.result as { skills: unknown[] }).skills).toHaveLength(5);
    } finally {
      child.kill();
    }
  });

  // Claude Code sends initialize when its 2026-07-28 probe times out on a slow start:
  // the server must still answer it with a working legacy session.
  it("answers initialize after a 2026-07-28 probe, with tools and skills", async () => {
    const { child, request } = rawSession(tmpDir);
    try {
      await request("server/discover", { _meta: MODERN_META });
      const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
      expect(init.error).toBeUndefined();
      expect(init.result).toMatchObject({ capabilities: { extensions: { [SKILLS_EXTENSION]: {} } } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const tools = await request("tools/list");
      expect((tools.result as { tools: unknown[] }).tools.length).toBeGreaterThan(20);
      const skills = await request("skills/list");
      expect((skills.result as { skills: unknown[] }).skills).toHaveLength(5);
    } finally {
      child.kill();
    }
  });

  it("serves no skills with --no-skills and keeps the tools", async () => {
    const { child, request, initialize } = await startMcpSession(DIST_ENTRY, tmpDir, tmpDir, process.env, ["--no-skills"]);
    try {
      const capabilities = (initialize.result as { capabilities: { extensions?: Record<string, unknown> } }).capabilities;
      expect(capabilities.extensions ?? {}).not.toHaveProperty([SKILLS_EXTENSION]);
      expect((await request("skills/list", {})).error).toMatchObject({ code: -32601 });
      const { tools } = (await request("tools/list", {})).result as { tools: unknown[] };
      expect(tools.length).toBeGreaterThan(20);
    } finally {
      await closeSession(child);
    }
  });
});
