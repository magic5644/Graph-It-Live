/**
 * Guarded writes of the files a CLI command produces in the workspace (graph-it init, the
 * baseline of check-architecture --update-baseline).
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateWorkspacePath } from "../shared/pathSecurity";
import { CliError, ExitCode } from "./errors";

async function lstatOrUndefined(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The absolute path of a workspace file, refused (exit 5) outside the workspace or through a link out of it. */
function resolveInWorkspace(workspaceRoot: string, file: string): string {
  try {
    return validateWorkspacePath(path.resolve(workspaceRoot, file), workspaceRoot);
  } catch (error) {
    throw new CliError(`Refusing to write ${file}: ${(error as Error).message}`, ExitCode.SECURITY_VIOLATION);
  }
}

/**
 * Writes a workspace file (relative to the root), creating its folders: never outside the
 * workspace, through a symbolic or hard link, or over a directory or special file.
 */
export async function writeWorkspaceFile(workspaceRoot: string, file: string, content: string): Promise<void> {
  const target = resolveInWorkspace(workspaceRoot, file);
  const stats = await lstatOrUndefined(target);
  // A hard link shares its content with a file that may live outside the workspace.
  if (stats !== undefined && (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1)) {
    throw new CliError(`Refusing to write ${file}: it is a symbolic link, a hard link or not a regular file.`, ExitCode.SECURITY_VIOLATION);
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, content);
}

/** Writes `content` to `<file>.bak`, or `.bak.2`, `.bak.3`... so an earlier copy is never replaced; returns its name. */
export async function writeBackup(workspaceRoot: string, file: string, content: string): Promise<string> {
  const taken = (name: string) => fs.lstatSync(resolveInWorkspace(workspaceRoot, name), { throwIfNoEntry: false }) !== undefined;
  let backup = `${file}.bak`;
  let n = 1;
  while (taken(backup)) {
    n += 1;
    backup = `${file}.bak.${n}`;
  }
  await writeWorkspaceFile(workspaceRoot, backup, content);
  return backup;
}
