import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathForComparison } from "./path";

function resolveExistingAncestor(filePath: string): string {
  let currentPath = filePath;

  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return filePath;
    currentPath = parentPath;
  }

  return fs.realpathSync.native(currentPath);
}

export function isPathWithinRoot(filePath: string, rootDir: string): boolean {
  const resolvedPath = normalizePathForComparison(path.resolve(rootDir, filePath));
  const resolvedRoot = normalizePathForComparison(path.resolve(rootDir));
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

export function isPathWithinRootCanonical(
  filePath: string,
  rootDir: string,
): boolean {
  if (!isPathWithinRoot(filePath, rootDir)) return false;

  const resolvedRoot = path.resolve(rootDir);
  if (!fs.existsSync(resolvedRoot)) return true;

  const resolvedPath = path.resolve(rootDir, filePath);
  const canonicalRoot = normalizePathForComparison(fs.realpathSync.native(resolvedRoot));
  const canonicalPath = normalizePathForComparison(resolveExistingAncestor(resolvedPath));
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}/`);
}

export function validateWorkspacePath(filePath: string, rootDir: string): void {
  if (filePath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }
  if (!isPathWithinRoot(filePath, rootDir)) {
    throw new Error(`File path is outside workspace: ${filePath}`);
  }
  if (!isPathWithinRootCanonical(filePath, rootDir)) {
    throw new Error(`File path escapes workspace through a symbolic link: ${filePath}`);
  }
}

export function toWorkspaceRelativePath(
  absolutePath: string,
  workspaceRoot: string,
): string {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return `[external:${path.basename(absolutePath)}]`;
  }
  return relativePath.replaceAll("\\", "/");
}
