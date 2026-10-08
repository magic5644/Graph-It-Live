import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePath } from "../../shared/path";
import { isPathWithinRootCanonical } from "../../shared/pathSecurity";
import { parseTsConfig, resolveExtendsTargets } from "../utils/tsconfig";

/** Fingerprint resolver inputs; unavailable or external configs disable cache reuse. */
export function configFingerprint(workspaceRoot: string, sourceFiles: readonly string[]): string | undefined {
  try {
    const directories = findSourceDirectories(workspaceRoot, sourceFiles);
    if (!directories) return undefined;
    const contents = readConfigContents(workspaceRoot, directories);
    if (!contents) return undefined;
    return createHash("sha256").update(JSON.stringify([...contents].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  } catch {
    return undefined;
  }
}

function findSourceDirectories(workspaceRoot: string, sourceFiles: readonly string[]): Set<string> | undefined {
  const directories = new Set<string>([normalizePath(workspaceRoot)]);
  for (const file of sourceFiles) {
    let directory = normalizePath(path.dirname(file));
    while (!directories.has(directory)) {
      if (!isPathWithinRootCanonical(directory, workspaceRoot)) return undefined;
      directories.add(directory);
      directory = normalizePath(path.dirname(directory));
    }
  }
  return directories;
}

function readConfigContents(workspaceRoot: string, directories: Set<string>): Map<string, string> | undefined {
  const pending = [...directories].flatMap(directory => [
    path.join(directory, "tsconfig.json"),
    path.join(directory, "package.json"),
  ]);
  const visited = new Set<string>();
  const contents = new Map<string, string>();
  for (let file = pending.shift(); file; file = pending.shift()) {
    const key = normalizePath(file);
    if (visited.has(key)) continue;
    visited.add(key);
    const content = readConfig(file, workspaceRoot);
    if (content === undefined) continue;
    contents.set(key, content);
    const extendedConfigs = getExtendedConfigs(file, content, workspaceRoot);
    if (!extendedConfigs) return undefined;
    pending.push(...extendedConfigs);
  }
  return contents;
}

function readConfig(file: string, workspaceRoot: string): string | undefined {
  if (!isPathWithinRootCanonical(file, workspaceRoot) || !fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf-8");
}

function getExtendedConfigs(file: string, content: string, workspaceRoot: string): string[] | undefined {
  // Invalid JSONC is also fingerprinted; the resolver ignores it until repaired.
  const targets = resolveExtendsTargets(file, parseTsConfig(file, content)?.extends);
  return targets.every(target => isPathWithinRootCanonical(target, workspaceRoot)) ? targets : undefined;
}
