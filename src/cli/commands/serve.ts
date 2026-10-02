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

  return new Promise<string>((resolve, reject) => {
    child.on("error", (err) => {
      reject(
        new CliError(
          `Failed to start MCP server: ${err.message}`,
          ExitCode.GENERAL_ERROR,
        ),
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
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
