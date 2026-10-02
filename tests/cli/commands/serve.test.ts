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

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
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

  it.each(["SIGTERM", "SIGINT"] as const)("forwards %s to the server and resolves once it exits (#241)", async (signal) => {
    const child = fakeChild();
    const before = process.listenerCount(signal);
    const done = run([], runtime("/work/project"), "text");
    expect(process.listenerCount(signal)).toBe(before + 1);

    process.listeners(signal).at(-1)?.(signal);
    expect(child.kill).toHaveBeenCalledWith(signal);
    // Windows: kill() terminates the child with code 1, which is not a failure here.
    child.emit("exit", 1, null);

    await expect(done).resolves.toBe("");
    expect(process.listenerCount(signal)).toBe(before);
  });

  it("stops forwarding signals when the server cannot start", async () => {
    const child = fakeChild();
    const before = process.listenerCount("SIGTERM");
    const done = run([], runtime("/work/project"), "text");
    child.emit("error", new Error("ENOENT"));

    await expect(done).rejects.toThrow("ENOENT");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("still reports a crash when no signal was forwarded", async () => {
    const child = fakeChild();
    const done = run([], runtime("/work/project"), "text");
    child.emit("exit", 1, null);

    await expect(done).rejects.toThrow("MCP server exited with code 1");
    expect(child.kill).not.toHaveBeenCalled();
  });
});
