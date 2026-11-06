/**
 * A failed worker init must reject McpWorkerHost.start() at once, not after the
 * warmup timeout: tool calls of a server started outside a project would hang.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpWorkerHost } from "../../src/mcp/McpWorkerHost";

const workerPath = path.resolve(__dirname, "../../dist/mcpWorker.js");

describe.skipIf(!fs.existsSync(workerPath))("McpWorker init error (real worker)", () => {
  let host: McpWorkerHost | undefined;

  afterEach(async () => {
    await host?.dispose();
  });

  it("rejects start() with the worker's init error, well before the warmup timeout", async () => {
    host = new McpWorkerHost({ workerPath, warmupTimeout: 60_000, invokeTimeout: 5_000 });
    const startedAt = Date.now();

    await expect(
      host.start({ rootDir: "", excludeNodeModules: true, maxDepth: 50, extensionPath: process.cwd() }),
    ).rejects.toThrow("rootDir is required");

    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(host.ready()).toBe(false);
  }, 60_000);
});
