/**
 * Unit tests for `graph-it serve`: the MCP child process must analyze the
 * workspace the CLI resolved, not its own working directory (#226).
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { run } from "../../../src/cli/commands/serve.js";

const runtime = (workspaceRoot: string) => ({ workspaceRoot }) as never;

function fakeChild(): EventEmitter {
  const child = new EventEmitter();
  mocks.spawn.mockReturnValue(child);
  return child;
}

describe("serve command", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    (globalThis as { __dirname?: string }).__dirname = "/opt/graph-it/dist";
  });

  it("passes the resolved workspace to the MCP server as WORKSPACE_ROOT", async () => {
    const child = fakeChild();
    const done = run([], runtime("/work/project"), "text");
    child.emit("exit", 0);

    await expect(done).resolves.toBe("");
    const [, args, options] = mocks.spawn.mock.calls[0];
    expect(args[0]).toMatch(/mcpServer\.mjs$/);
    expect(options.env.WORKSPACE_ROOT).toBe("/work/project");
    expect(options.stdio).toBe("inherit");
  });

  it("overrides a WORKSPACE_ROOT inherited from the parent environment", async () => {
    vi.stubEnv("WORKSPACE_ROOT", "/somewhere/else");
    try {
      const child = fakeChild();
      const done = run([], runtime(String.raw`C:\work\project`), "text");
      child.emit("exit", 0);
      await done;
      expect(mocks.spawn.mock.calls[0][2].env.WORKSPACE_ROOT).toBe(String.raw`C:\work\project`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails when the server exits with a non-zero code", async () => {
    const child = fakeChild();
    const done = run([], runtime("/work/project"), "text");
    child.emit("exit", 3);
    await expect(done).rejects.toThrow("MCP server exited with code 3");
  });

  it("fails when the server cannot start", async () => {
    const child = fakeChild();
    const done = run([], runtime("/work/project"), "text");
    child.emit("error", new Error("ENOENT"));
    await expect(done).rejects.toThrow("Failed to start MCP server: ENOENT");
  });
});
