import * as nodePath from 'node:path';

/**
 * Normalize a file path to use forward slashes consistently across all platforms.
 * This is the canonical representation for storing/comparing paths in the index.
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return filePath;
  // Convert backslashes to forward slashes
  let p = filePath.replaceAll('\\', '/');
  // Collapse multiple slashes
  p = p.replaceAll(/\/+/g, '/');
  // Remove trailing slash for non-root paths
  if (p.length > 1 && p.endsWith('/') && !/^[a-zA-Z]:\/$/.test(p)) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Normalize path for comparison semantics: lowercases drive letter on Windows
 * and removes trailing slashes (keeps root like 'c:/'). Use this for strict
 * equality checks and validation.
 */
export function normalizePathForComparison(filePath: string): string {
  if (!filePath) return filePath;
  let p = normalizePath(filePath);

  // Lowercase Windows drive letter if present
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }

  // Keep single-roots like '/' or 'c:/' as-is. Otherwise strip trailing slash
  if (p.length > 1 && p.endsWith('/') && !/^[a-zA-Z]:\/$/.test(p)) {
    p = p.slice(0, -1);
  }

  return p;
}

/**
 * Convert an absolute path to a path relative to a root. Returns the original
 * absolute path if it resolves outside the root. The returned relative path
 * always uses forward slashes (POSIX-style) for consistency.
 */
export function getRelativePath(absolutePath: string, workspaceRoot: string): string {
  const rel = nodePath.relative(workspaceRoot, absolutePath);
  // If outside workspace, return absolute
  if (rel.startsWith('..') || nodePath.isAbsolute(rel)) return absolutePath;
  return normalizePath(rel);
}
