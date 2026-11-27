/**
 * The bundled agent skills over the built `graph-it serve` (#837): served by
 * default through the MCP Skills extension, not served with --no-skills.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSession, startMcpSession } from "../../scripts/mcpSession.mts";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/skills"));
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

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
