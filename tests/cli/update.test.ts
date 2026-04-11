/**
 * Tests for the `graph-it update` command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock — must appear before any dynamic import of the module under test
vi.mock("node:https", () => ({ get: vi.fn() }));

import * as https from "node:https";

const runtimeStub = {
  workspaceRoot: "/tmp",
} as unknown as import("../../src/cli/runtime").CliRuntime;

/** Helper: produce a fake https.get implementation returning a JSON body */
function mockRegistryResponse(statusCode: number, body: unknown): void {
  vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
    const rawBody = JSON.stringify(body);
    const res = {
      statusCode,
      on(event: string, handler: (data?: Buffer) => void) {
        if (event === "data") handler(Buffer.from(rawBody));
        if (event === "end") handler();
        return res;
      },
      resume: vi.fn(),
    };
    (cb as (r: typeof res) => void)(res);
    return { on: vi.fn(), setTimeout: vi.fn() } as unknown as ReturnType<typeof https.get>;
  });
}

describe("update command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env["CLI_VERSION"] = "1.0.0";
  });

  afterEach(() => {
    delete process.env["CLI_VERSION"];
  });

  it("reports already up to date when versions match", async () => {
    mockRegistryResponse(200, { version: "1.0.0" });

    const { run } = await import("../../src/cli/commands/update.js");
    const output = await run([], runtimeStub, "text");
    expect(output).toContain("Already up to date");
    expect(output).toContain("1.0.0");
  });

  it("throws CliError on network error", async () => {
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
      const req = {
        on(event: string, handler: (err: Error) => void) {
          if (event === "error") handler(new Error("ECONNREFUSED"));
          return req;
        },
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      };
      return req as unknown as ReturnType<typeof https.get>;
    });

    const { run } = await import("../../src/cli/commands/update.js");
    const { CliError } = await import("../../src/cli/errors.js");
    await expect(run([], runtimeStub, "text")).rejects.toBeInstanceOf(CliError);
  });

  it("throws CliError when registry returns non-200", async () => {
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const res = { statusCode: 404, on: vi.fn(), resume: vi.fn() };
      (cb as (r: typeof res) => void)(res);
      return { on: vi.fn(), setTimeout: vi.fn() } as unknown as ReturnType<typeof https.get>;
    });

    const { run } = await import("../../src/cli/commands/update.js");
    const { CliError } = await import("../../src/cli/errors.js");
    await expect(run([], runtimeStub, "text")).rejects.toBeInstanceOf(CliError);
  });

  it("rejects malformed version string from registry (injection guard)", async () => {
    mockRegistryResponse(200, { version: "1.0.0; echo injected" });

    const { run } = await import("../../src/cli/commands/update.js");
    const { CliError } = await import("../../src/cli/errors.js");
    await expect(run([], runtimeStub, "text")).rejects.toBeInstanceOf(CliError);
  });
});
