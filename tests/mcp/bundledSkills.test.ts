import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachBundledSkills } from "@/mcp/bundledSkills";

const SKILLS_ROOT = path.resolve(__dirname, "../../plugins/graph-it-live/skills");
const SKILL_NAMES = ["dead-code-hunter", "graph-it-live", "graph-it-refactor", "onboarding-express", "pr-review"];

interface Reply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Connects `server` to an in-memory client and returns a raw JSON-RPC request function. */
async function connect(server: McpServer) {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Reply) => void>();
  client.onmessage = (message) => {
    const { id } = message as { id?: number };
    if (typeof id === "number") pending.get(id)?.(message as Reply);
  };
  await server.connect(transport);
  await client.start();
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
    void client.send({ jsonrpc: "2.0", id, method, params });
    return reply;
  };
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, capabilities: init.result?.capabilities as Record<string, unknown> };
}

const newServer = () => new McpServer({ name: "test", version: "1" });

describe("attachBundledSkills (#837)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves the five plugin skills with their frontmatter and a complete file manifest", async () => {
    const server = newServer();
    const warn = vi.fn();
    expect(await attachBundledSkills(server, SKILLS_ROOT, warn)).toBe(5);
    expect(warn).not.toHaveBeenCalled();
    const { request, capabilities } = await connect(server);

    expect(capabilities.extensions).toHaveProperty(["io.modelcontextprotocol/skills"]);
    const { skills } = (await request("skills/list")).result as {
      skills: { uri: string; frontmatter: { name: string; description: string }; resources: { uri: string; digest: string }[] }[];
    };
    expect(skills.map((skill) => skill.frontmatter.name)).toEqual(SKILL_NAMES);
    for (const skill of skills) {
      const dir = path.join(SKILLS_ROOT, skill.frontmatter.name);
      const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
      expect(skill.resources.map(({ uri }) => uri).sort((a, b) => a.localeCompare(b))).toEqual(
        files.map((entry) => `skill://${skill.frontmatter.name}/${path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`).sort((a, b) => a.localeCompare(b)),
      );
      expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain(`name: ${skill.frontmatter.name}`);
      expect(skill.frontmatter.description.length).toBeGreaterThan(50);
    }
  });

  it.each(SKILL_NAMES)("returns every file of %s byte for byte through skills/get and resources/read", async (name) => {
    const server = newServer();
    await attachBundledSkills(server, SKILLS_ROOT, vi.fn());
    const { request } = await connect(server);

    const { skill } = (await request("skills/get", { uri: `skill://${name}/SKILL.md` })).result as {
      skill: { resources: { uri: string; digest: string }[] };
    };
    for (const { uri, digest } of skill.resources) {
      const onDisk = fs.readFileSync(path.join(SKILLS_ROOT, uri.slice("skill://".length)));
      const { contents } = (await request("resources/read", { uri })).result as { contents: { text: string }[] };
      expect(Buffer.from(contents[0].text, "utf8").equals(onDisk)).toBe(true);
      expect(digest).toBe(`sha256:${createHash("sha256").update(onDisk).digest("hex")}`);
    }
  });

  it.each([
    "skill://pr-review/../../../package.json",
    "skill://pr-review/%2e%2e/%2e%2e/package.json",
    "skill://unknown/SKILL.md",
    "skill://pr-review/references/missing.md",
    String.raw`skill://pr-review/..\..\..\package.json`,
    "skill://C:/Windows/win.ini",
    "skill:///etc/passwd",
    `file://${path.join(SKILLS_ROOT, "pr-review", "SKILL.md").replaceAll("\\", "/")}`,
  ])("answers %s with an MCP error, never a file", async (uri) => {
    const server = newServer();
    await attachBundledSkills(server, SKILLS_ROOT, vi.fn());
    const { request } = await connect(server);

    const reply = await request("resources/read", { uri });
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toMatch(/not found|invalid/i);
  });

  it("starts without skills and warns once when the skills folder is missing", async () => {
    const server = newServer();
    const warn = vi.fn();
    expect(await attachBundledSkills(server, path.join(os.tmpdir(), "graph-it-no-such-skills"), warn)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/skills folder not found: .*serving tools only/);
    const { request, capabilities } = await connect(server);

    expect(capabilities.extensions ?? {}).not.toHaveProperty(["io.modelcontextprotocol/skills"]);
    expect((await request("skills/list")).error?.code).toBe(-32601);
  });

  it("starts without skills and warns once when the folder holds no skill", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-skills-"));
    tmpDirs.push(empty);
    const server = newServer();
    const warn = vi.fn();
    expect(await attachBundledSkills(server, empty, warn)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[McpServer\] WARNING: no skills served from .*no skills found.*serving tools only$/);
    const { capabilities } = await connect(server);
    expect(capabilities.extensions ?? {}).not.toHaveProperty(["io.modelcontextprotocol/skills"]);
  });

  it("starts without skills and warns on one line when the skills path cannot be listed", async () => {
    const warn = vi.fn();
    expect(await attachBundledSkills(newServer(), path.join(SKILLS_ROOT, "pr-review", "SKILL.md"), warn)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[McpServer\] WARNING: no skills served from .*serving tools only$/);
    expect(warn.mock.calls[0][0]).not.toContain("\n");
  });

  it("skips a skill that contains a symlink and serves the others", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-skills-"));
    tmpDirs.push(root);
    fs.cpSync(path.join(SKILLS_ROOT, "pr-review"), path.join(root, "pr-review"), { recursive: true });
    fs.cpSync(path.join(SKILLS_ROOT, "graph-it-live"), path.join(root, "linked"), { recursive: true });
    fs.writeFileSync(path.join(root, "linked", "SKILL.md"), "---\nname: linked\ndescription: A skill whose references folder links outside the catalog.\n---\n");
    fs.rmSync(path.join(root, "linked", "references"), { recursive: true });
    // A junction needs no privilege on Windows.
    fs.symlinkSync(os.tmpdir(), path.join(root, "linked", "references"), "junction");
    const warn = vi.fn();
    expect(await attachBundledSkills(newServer(), root, warn)).toBe(1);
    expect(warn.mock.calls.map(([message]) => message).join("\n")).toMatch(/skill skipped, linked/);
  });

  it("forwards a per-skill problem as a warning and still serves the valid skills", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-skills-"));
    tmpDirs.push(root);
    fs.cpSync(path.join(SKILLS_ROOT, "pr-review"), path.join(root, "pr-review"), { recursive: true });
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "SKILL.md"), "no frontmatter\n");
    const warn = vi.fn();
    expect(await attachBundledSkills(newServer(), root, warn)).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/^\[McpServer\] WARNING: skill skipped, broken/);
  });
});
