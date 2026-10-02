/**
 * CLI Command: serve
 *
 * Launches the existing MCP stdio server as a child process.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import type { CliRuntime } from "../runtime";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export async function run(
  _args: string[],
  runtime: CliRuntime,
  _format: CliOutputFormat,
): Promise<string> {
  // __dirname is injected by the esbuild ESM banner shim
  const distDir = __dirname;
  const mcpServerPath = path.join(distDir, "mcpServer.mjs");

  const child = spawn(process.execPath, [mcpServerPath], {
    stdio: "inherit",
    // The MCP server reads its workspace from WORKSPACE_ROOT (cwd otherwise):
    // pass the one the CLI resolved from --workspace or auto-detection.
    env: { ...process.env, WORKSPACE_ROOT: runtime.workspaceRoot },
  });

  // Forward termination signals so a supervisor that stops the CLI also stops
  // the server. index.ts handles the same signals and sets the exit code.
  let forwarded = false;
  const forward = (signal: NodeJS.Signals): void => {
    forwarded = true;
    child.kill(signal);
  };
  const stopForwarding = (): void => {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);

  return new Promise<string>((resolve, reject) => {
    child.on("error", (err) => {
      stopForwarding();
      reject(
        new CliError(
          `Failed to start MCP server: ${err.message}`,
          ExitCode.GENERAL_ERROR,
        ),
      );
    });
    child.on("exit", (code) => {
      stopForwarding();
      // Windows has no catchable SIGTERM: kill() ends the child with code 1.
      if (code === 0 || forwarded) {
        resolve("");
      } else {
        reject(
          new CliError(
            `MCP server exited with code ${code}`,
            ExitCode.GENERAL_ERROR,
          ),
        );
      }
    });
  });
}
