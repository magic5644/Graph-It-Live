/** Minimal MCP stdio client over `graph-it serve`, shared by the CLI E2E tests and the E2E benchmark. */

import { spawn } from "node:child_process";

export interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
}

/** End the MCP session like a client does: close stdin, then wait for the process tree to exit. */
export async function closeSession(child: ReturnType<typeof spawn>): Promise<number | null> {
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
}

/** Start `graph-it serve --workspace <workspace>` from `cwd` and complete the MCP handshake. */
export async function startMcpSession(distEntry: string, workspace: string, cwd: string) {
  const child = spawn(process.execPath, [distEntry, "serve", "--workspace", workspace], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const responses = new Map<number, Record<string, unknown>>();
  const waiters = new Map<number, () => void>();
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
        if (typeof message.id === "number") {
          responses.set(message.id, message);
          waiters.get(message.id)?.();
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
  // Resolves on the response line itself, not on a poll: benchmarks time these calls.
  const waitFor = async (id: number) => {
    if (!responses.has(id)) {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new Error(`no response ${id}`));
        const timer = setTimeout(fail, 45_000);
        const done = (settle: () => void) => () => {
          clearTimeout(timer);
          child.off("exit", onExit);
          waiters.delete(id);
          settle();
        };
        const onExit = done(fail);
        waiters.set(id, done(resolve));
        child.once("exit", onExit);
      });
    }
    return responses.get(id)!;
  };
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return waitFor(id);
  };
  const initialize = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const callTool = async (name: string, args: Record<string, unknown>) =>
    (await request("tools/call", { name, arguments: args })).result as ToolResult;
  return { child, request, callTool, initialize };
}
