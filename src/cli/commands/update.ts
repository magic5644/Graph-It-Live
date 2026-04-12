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
import * as https from "node:https";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import type { CliRuntime } from "../runtime";

const NPM_PACKAGE = "@magic5644/graph-it-live";
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;

/** Basic semver validation — rejects any string that could be used for injection. */
function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v);
}

/** Fetch latest version string from the npm registry. */
function fetchLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(REGISTRY_URL, { headers: { Accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new CliError(`npm registry returned HTTP ${res.statusCode}`, ExitCode.GENERAL_ERROR));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
          const version = body["version"];
          if (typeof version !== "string" || !isValidVersion(version)) {
            reject(new CliError("Unexpected or invalid version from npm registry", ExitCode.GENERAL_ERROR));
          } else {
            resolve(version);
          }
        } catch {
          reject(new CliError("Failed to parse npm registry response", ExitCode.GENERAL_ERROR));
        }
      });
    });
    req.on("error", (err) => {
      reject(new CliError(`Network error: ${err.message}`, ExitCode.GENERAL_ERROR));
    });
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new CliError("Registry request timed out after 10 s", ExitCode.GENERAL_ERROR));
    });
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

  const latestVersion = await fetchLatestVersion();

  if (latestVersion === currentVersion) {
    return `✓ Already up to date (v${currentVersion})`;
  }

  process.stdout.write(`Latest version  : v${latestVersion}\nInstalling update…\n`);

  try {
    execFileSync("npm", ["install", "--global", `${NPM_PACKAGE}@${latestVersion}`], {
      stdio: "inherit",
      // shell: false (default) — args are passed directly to the OS, no shell injection risk
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`npm install failed: ${msg}`, ExitCode.GENERAL_ERROR);
  }

  return `✓ Updated graph-it-live to v${latestVersion}`;
}
