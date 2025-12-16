/**
 * Webview-safe path normalization (no Node.js deps).
 * Must match backend canonicalization for node/edge ids.
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return filePath;
  let p = filePath.replaceAll('\\', '/');
  p = p.replaceAll(/\/+/g, '/');
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }
  if (p.length > 1 && p.endsWith('/') && !/^[a-zA-Z]:\/$/.test(p)) {
    p = p.slice(0, -1);
  }
  return p;
}

