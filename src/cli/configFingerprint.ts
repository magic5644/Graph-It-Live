import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePath } from "../shared/path";
import { isPathWithinRootCanonical } from "../shared/pathSecurity";

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
    const extendedConfig = getExtendedConfig(file, content, workspaceRoot);
    if (extendedConfig === undefined) return undefined;
    if (extendedConfig) pending.push(extendedConfig);
  }
  return contents;
}

function readConfig(file: string, workspaceRoot: string): string | undefined {
  if (!isPathWithinRootCanonical(file, workspaceRoot) || !fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf-8");
}

function getExtendedConfig(file: string, content: string, workspaceRoot: string): string | null | undefined {
  // Invalid JSON is also fingerprinted; the resolver ignores it until repaired.
  let config: { extends?: unknown } | null;
  try { config = JSON.parse(content) as typeof config; } catch { return null; }
  if (typeof config?.extends !== "string") return null;
  const base = path.resolve(path.dirname(file), config.extends);
  if (!isPathWithinRootCanonical(base, workspaceRoot)) return undefined;
  const json = base.endsWith(".json") ? base : `${base}.json`;
  return fs.existsSync(json) ? json : base;
}
