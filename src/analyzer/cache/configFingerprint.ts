import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "../../shared/logger";
import { normalizePath } from "../../shared/path";
import { isPathWithinRootCanonical } from "../../shared/pathSecurity";
import { parseTsConfig, resolveExtendsTargets } from "../utils/tsconfig";

const log = getLogger("configFingerprint");

/**
 * Fingerprint resolver inputs, including configs inherited from outside the workspace.
 * Returns undefined (cache disabled, reason logged) for external sources or unreadable configs.
 */
export function configFingerprint(workspaceRoot: string, sourceFiles: readonly string[]): string | undefined {
  try {
    const contents = readConfigContents(findSourceDirectories(workspaceRoot, sourceFiles));
    return createHash("sha256").update(JSON.stringify([...contents].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  } catch (error) {
    log.info(`Index cache disabled: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function findSourceDirectories(workspaceRoot: string, sourceFiles: readonly string[]): Set<string> {
  const directories = new Set<string>([normalizePath(workspaceRoot)]);
  for (const file of sourceFiles) {
    let directory = normalizePath(path.dirname(file));
    while (!directories.has(directory)) {
      if (!isPathWithinRootCanonical(directory, workspaceRoot)) {
        throw new Error(`source file outside the workspace: ${normalizePath(file)}`);
      }
      directories.add(directory);
      directory = normalizePath(path.dirname(directory));
    }
  }
  return directories;
}

function readConfigContents(directories: Set<string>): Map<string, string> {
  const pending = [...directories].flatMap(directory => [
    path.join(directory, "tsconfig.json"),
    path.join(directory, "package.json"),
  ]);
  const visited = new Set<string>();
  const contents = new Map<string, string>();
  for (let file = pending.shift(); file; file = pending.shift()) {
    const key = normalizePath(file);
    if (visited.has(key) || !fs.existsSync(file)) continue;
    visited.add(key);
    const content = readConfig(file);
    contents.set(key, content);
    // Inherited configs are hashed wherever they live; only their contents enter the digest.
    // Invalid JSONC is also fingerprinted; the resolver ignores it until repaired.
    pending.push(...resolveExtendsTargets(file, parseTsConfig(file, content)?.extends));
  }
  return contents;
}

function readConfig(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read resolver config ${normalizePath(file)}: ${reason}`, { cause: error });
  }
}
