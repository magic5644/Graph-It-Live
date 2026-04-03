/**
 * CLI Command: serve
 *
 * Launches the existing MCP stdio server as a child process.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import type { CliRuntime } from "../runtime";

export async function run(
  _args: string[],
  _runtime: CliRuntime,
  _format: CliOutputFormat,
): Promise<string> {
  // Locate mcpServer.mjs relative to this CLI bundle
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = path.dirname(thisFile);
  const mcpServerPath = path.join(distDir, "mcpServer.mjs");

  const child = spawn(process.execPath, [mcpServerPath], {
    stdio: "inherit",
    env: { ...process.env },
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
