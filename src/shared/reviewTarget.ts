import path from "node:path";
import { normalizePath } from "./path";

export const REVIEW_CALL_GRAPH_MAX_DEPTH = 5;

export interface ReviewCallGraphTarget {
  file: string;
  symbol?: string;
  depth: number;
}

export function validateReviewCallGraphTarget(target: unknown): ReviewCallGraphTarget {
  if (!target || typeof target !== "object") throw new Error("Invalid review call graph target");
  const value = target as { file?: unknown; symbol?: unknown; depth?: unknown };
  if (typeof value.file !== "string" || value.file.length === 0 || path.isAbsolute(value.file) || path.win32.isAbsolute(value.file)) {
    throw new Error("Review target must contain a workspace-relative file path");
  }
  if (value.symbol !== undefined && (typeof value.symbol !== "string" || value.symbol.length === 0)) {
    throw new Error("Review target symbol must be a non-empty string");
  }
  const depth = value.depth ?? 3;
  if (typeof depth !== "number" || !Number.isFinite(depth) || !Number.isInteger(depth) || depth < 1 || depth > REVIEW_CALL_GRAPH_MAX_DEPTH) {
    throw new Error(`Review target depth must be an integer between 1 and ${REVIEW_CALL_GRAPH_MAX_DEPTH}`);
  }
  return { file: value.file, symbol: value.symbol, depth };
}

export function parseReviewCallGraphDepth(requested: string | null = "3"): number {
  requested ??= "3";
  if (!/^[1-5]$/.test(requested)) {
    throw new Error(`Review target depth must be an integer between 1 and ${REVIEW_CALL_GRAPH_MAX_DEPTH}`);
  }
  return Number(requested);
}

export function resolveReviewCallGraphPath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = normalizePath(path.resolve(workspaceRoot));
  const resolvedPath = normalizePath(path.resolve(workspaceRoot, normalizePath(relativePath)));
  if (resolvedPath === normalizedRoot || !resolvedPath.startsWith(`${normalizedRoot}/`)) {
    throw new Error("Review target resolves outside the workspace");
  }
  return resolvedPath;
}
