/**
 * graph-it update — self-update via npm
 *
 * Checks the npm registry for the latest version of @magic5644/graph-it-live
 * and runs `npm install -g @magic5644/graph-it-live@latest` if an update is available.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { execFileSync } from "node:child_process";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import type { CliRuntime } from "../runtime";
import { fetchLatestVersion } from "../versionCheck";

const NPM_PACKAGE = "@magic5644/graph-it-live";

function runGlobalInstall(version: string): void {
  const args = ["install", "--global", `${NPM_PACKAGE}@${version}`] as const;

  try {
    execFileSync("npm", args, {
      stdio: "inherit",
      // shell: false (default) — args are passed directly to the OS, no shell injection risk
    });
    return;
  } catch (err) {
    const isNpmMissing =
      (err as { code?: string })?.code === "ENOENT" ||
      (err instanceof Error && err.message.includes("spawnSync npm ENOENT"));

    if (!isNpmMissing) {
      throw err;
    }
  }

  // Windows frequently resolves npm via npm.cmd in PATH, retry explicitly.
  execFileSync("npm.cmd", args, {
    stdio: "inherit",
  });
}

export async function run(
  _args: string[],
  _runtime: CliRuntime,
  _format: CliOutputFormat,
): Promise<string> {
  const currentVersion = process.env["CLI_VERSION"] ?? "0.0.0-dev";
  process.stdout.write(`Current version : v${currentVersion}\n`);
  process.stdout.write(`Checking npm registry for ${NPM_PACKAGE}…\n`);

  let latestVersion: string;
  try {
    latestVersion = await fetchLatestVersion(10_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(message, ExitCode.GENERAL_ERROR);
  }

  if (latestVersion === currentVersion) {
    return `✓ Already up to date (v${currentVersion})`;
  }

  process.stdout.write(`Latest version  : v${latestVersion}\nInstalling update…\n`);

  try {
    runGlobalInstall(latestVersion);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`npm install failed: ${msg}`, ExitCode.GENERAL_ERROR);
  }

  return `✓ Updated graph-it-live to v${latestVersion}`;
}
