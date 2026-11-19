import * as nodePath from 'node:path';

/**
 * Normalize a file path to use forward slashes consistently across all platforms.
 * This is the canonical representation for storing/comparing paths in the index.
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return filePath;
  // Convert backslashes to forward slashes
  let p = filePath.replaceAll('\\', '/');
  // Preserve the double leading slash used by UNC paths.
  const isUncPath = p.startsWith('//');
  p = isUncPath
    ? `//${p.slice(2).replaceAll(/\/+/g, '/')}`
    : p.replaceAll(/\/+/g, '/');
  // Lowercase Windows drive letter if present to keep a stable canonical form
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }
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

  // Windows paths are case-insensitive, including UNC server/share paths.
  if (process.platform === 'win32') {
    p = p.toLowerCase();
  }

  return p;
}

/**
 * Normalize the `fsPath` of a VS Code URI to use forward slashes consistently.
 * Use this instead of `uri.fsPath` directly when the path will be stored,
 * compared, or looked up in the reverse index.
 */
export function getNormalizedFsPath(uri: { fsPath: string }): string {
  return normalizePath(uri.fsPath);
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

/**
 * Strip the workspace root from every absolute path in a rendered output string.
 *
 * Symbol ids carry their file's absolute path (`<absPath>:<symbol>`), so a
 * result with N rows repeats the workspace root N times — on this repo that is
 * roughly a quarter of the bytes of a TOON payload, all of it machine-specific
 * noise that an LLM cannot use.
 *
 * Applied to every rendered output (CLI json and toon, MCP responses and
 * messages): paths are workspace-relative on every surface (#769).
 */
export function relativizeWorkspacePaths(output: string, workspaceRoot: string): string {
  const normalizedRoot = normalizePath(workspaceRoot).replace(/\/+$/, "");
  // A filesystem root ("/", "c:/") would turn every absolute path, or every "/", into noise.
  if (/^(?:[a-z]:)?$/i.test(normalizedRoot)) {
    return output;
  }

  // Paths come normalized from the index (c:/repo/a.ts), native from a resolved parameter or a
  // message (C:\repo\a.ts), and JSON-escaped (C:\\repo\\a.ts): match the root in each form, and
  // turn the separators of the path segments after it into "/". Windows paths ignore case.
  const separator = String.raw`(?:\\\\|\\|/)`;
  const root = normalizedRoot
    .split("/")
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join(separator);
  const segment = String.raw`[^\s"'\x60<>|*?:,;\\/]+`;
  const flags = /^[a-z]:/i.test(normalizedRoot) ? "gi" : "g";
  // Without a following segment, the root itself becomes "." unless more path characters follow
  // it, so a sibling like "/repo-backup" does not match "/repo".
  const pattern = new RegExp(String.raw`${root}((?:${separator}${segment})+)|${root}(?![\w.\\/-])`, flags);
  return output.replaceAll(pattern, (_match, tail: string | undefined) =>
    tail === undefined ? "." : tail.replace(new RegExp(`^${separator}`), "").replaceAll(new RegExp(separator, "g"), "/"),
  );
}
