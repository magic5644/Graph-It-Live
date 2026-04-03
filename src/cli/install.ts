/**
 * CLI opt-in install command
 *
 * Installs the CLI binary to a user-chosen location on the system PATH.
 * On macOS/Linux: creates a symlink in /usr/local/bin or ~/bin.
 * On Windows: creates a .cmd wrapper in %USERPROFILE%\AppData\Local\Microsoft\WindowsApps.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { CliError, ExitCode } from "./errors";
import type { CliOutputFormat } from "./formatter";
import type { CliRuntime } from "./runtime";

export async function run(
  _args: string[],
  _runtime: CliRuntime,
  _format: CliOutputFormat,
): Promise<string> {
  // __dirname is injected by the esbuild ESM banner shim
  const distDir = __dirname;
  const cliSrc = path.join(distDir, "graph-it.mjs");

  if (!fs.existsSync(cliSrc)) {
    throw new CliError(
      `CLI binary not found at: ${cliSrc}\nRun "npm run build:cli" first.`,
      ExitCode.GENERAL_ERROR,
    );
  }

  const platform = os.platform();
  const target = await promptInstallTarget(platform);

  if (!target) {
    return "Installation cancelled.";
  }

  if (platform === "win32") {
    return installWindows(cliSrc, target);
  } else {
    return installUnix(cliSrc, target);
  }
}

function promptInstallTarget(platform: string): Promise<string | null> {
  const homeDir = os.homedir();
  const defaultTarget =
    platform === "win32"
      ? path.join(homeDir, "AppData", "Local", "Microsoft", "WindowsApps", "graph-it.cmd")
      : tryFindWritableUnixTarget() ?? path.join(homeDir, "bin", "graph-it");

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      `Install graph-it to [${defaultTarget}] (leave blank to use default, type "cancel" to abort): `,
      (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (trimmed.toLowerCase() === "cancel") {
          resolve(null);
        } else if (trimmed === "") {
          resolve(defaultTarget);
        } else {
          resolve(trimmed);
        }
      },
    );
  });
}

function tryFindWritableUnixTarget(): string | null {
  const candidates = ["/usr/local/bin/graph-it", "/usr/bin/graph-it"];
  for (const candidate of candidates) {
    try {
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      return candidate;
    } catch {
      // not writable
    }
  }
  return null;
}

function installUnix(cliSrc: string, target: string): string {
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });

  // Remove existing symlink/file
  try {
    fs.unlinkSync(target);
  } catch {
    // ignore if not found
  }

  fs.symlinkSync(cliSrc, target);
  fs.chmodSync(cliSrc, 0o755);

  return `✓ graph-it installed to ${target}\n  Add ${targetDir} to your PATH if needed.`;
}

function installWindows(cliSrc: string, target: string): string {
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });

  // Write a .cmd wrapper
  const cmdContent = `@echo off\nnode "${cliSrc}" %*\n`;
  const cmdPath = target.endsWith(".cmd") ? target : target + ".cmd";
  fs.writeFileSync(cmdPath, cmdContent, "utf-8");

  return `✓ graph-it installed to ${cmdPath}\n  Ensure ${targetDir} is in your PATH.`;
}
