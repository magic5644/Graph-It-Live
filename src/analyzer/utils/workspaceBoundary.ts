/**
 * Workspace-root selection and the out-of-root import report shared by the
 * CLI, the MCP server and the VS Code extension.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Language } from "../LanguageService";

/** Imports that resolved to a file outside the workspace root and were skipped. */
export interface OutOfRootImports {
  /** Skipped (source file, module specifier) pairs. */
  count: number;
  /** A few of the skipped module specifiers — never absolute paths. */
  examples: string[];
}

/** Files that mark a directory as a monorepo or repository root. */
const MONOREPO_MARKERS = ["pnpm-workspace.yaml", "lerna.json", ".git"];

/**
 * Files that mark a directory as the root of a project in a supported language;
 * `*.ext` matches any file with that extension. Keyed by Language so that adding
 * a language fails to compile until its markers are listed here (TypeScript also
 * covers JavaScript and Vue).
 */
export const PROJECT_MARKERS: Readonly<Record<Exclude<`${Language}`, "unknown">, readonly string[]>> = {
  typescript: ["package.json", "tsconfig.json", "jsconfig.json", "deno.json", "deno.jsonc"],
  python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
  rust: ["Cargo.toml"],
  csharp: ["*.csproj", "*.sln", "*.slnx", "Directory.Build.props"],
  go: ["go.mod", "go.work"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
};

const MARKER_FILES = new Set(Object.values(PROJECT_MARKERS).flat().filter((marker) => !marker.startsWith("*")));
const MARKER_EXTENSIONS = Object.values(PROJECT_MARKERS)
  .flat()
  .filter((marker) => marker.startsWith("*"))
  .map((marker) => marker.slice(1));

/**
 * Whether dir directly holds a project marker of a supported language.
 * shortcut: an unreadable dir counts as holding none, so the climb passes it; upgrade if users hit it.
 */
export function hasProjectMarker(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some(
    (entry) => MARKER_FILES.has(entry) || MARKER_EXTENSIONS.some((extension) => entry.endsWith(extension)),
  );
}

/**
 * Root used when none was given explicitly: the nearest directory, starting at
 * startDir and going up, that holds a project marker (see PROJECT_MARKERS).
 * Falls back to startDir. An explicit root (--workspace, WORKSPACE_ROOT,
 * set_workspace, the VS Code folder) is used as given and never goes through this.
 */
export function findWorkspaceRoot(startDir: string): string {
  const start = path.resolve(startDir);
  let dir = start;
  // The filesystem root is checked too: a project may sit at / or C:\.
  while (!hasProjectMarker(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
  return dir;
}

function declaresWorkspaces(dir: string): boolean {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null && "workspaces" in manifest;
  } catch {
    return false;
  }
}

/**
 * The closest ancestor strictly above workspaceRoot that is a monorepo root
 * (package.json `workspaces`, pnpm-workspace.yaml, lerna.json) or a repository
 * root (.git), or null when there is none.
 */
export function findMonorepoRoot(workspaceRoot: string): string | null {
  let dir = path.resolve(workspaceRoot);
  for (let parent = path.dirname(dir); parent !== dir; parent = path.dirname(dir)) {
    dir = parent;
    if (MONOREPO_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker))) || declaresWorkspaces(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * A module specifier safe to report: an absolute specifier (POSIX or Windows)
 * is reduced to its last segment so no host path leaves the process.
 */
export function toReportableSpecifier(specifier: string): string {
  if (!path.posix.isAbsolute(specifier) && !path.win32.isAbsolute(specifier)) {
    return specifier;
  }
  return `[external:${specifier.split(/[\\/]/).pop() ?? ""}]`;
}

/**
 * `to` relative to `from`, with forward slashes, for display. Returns null when
 * no relative path exists (another Windows drive). `pathApi` lets tests pick
 * path.win32 or path.posix.
 */
export function toDisplayPath(
  from: string,
  to: string,
  pathApi: typeof path.posix = path,
): string | null {
  const relative = pathApi.relative(from, to);
  if (pathApi.isAbsolute(relative)) return null;
  return relative === "" ? "." : relative.replaceAll("\\", "/");
}

/**
 * The warning every surface shows when imports were skipped, or null when none
 * were. `monorepoRoot` is a display path (never absolute); each surface appends
 * its own remedy.
 */
export function describeOutOfRootImports(
  summary: OutOfRootImports,
  monorepoRoot: string | null,
): string | null {
  if (summary.count === 0) return null;
  const plural = summary.count !== 1;
  const examples = summary.examples.length > 0 ? ` (e.g. ${summary.examples.join(", ")})` : "";
  const detected = monorepoRoot ? ` Monorepo root detected (${monorepoRoot}).` : "";
  return (
    `${summary.count} import${plural ? "s" : ""} resolve${plural ? "" : "s"} outside the workspace root ` +
    `and ${plural ? "were" : "was"} skipped${examples}; dependents, impact and dead-code results cover this root only.` +
    detected
  );
}

/** The out-of-root fields every index-status answer (MCP, CLI tool, VS Code LM tool) carries. */
export interface OutOfRootReport {
  /**
   * Imports skipped because they resolve outside the workspace root; absent when
   * unknown (no reverse index), never a misleading 0
   */
  outOfRootImports?: number;
  /** A few skipped module specifiers (only when outOfRootImports > 0) */
  outOfRootImportExamples?: string[];
  /** Monorepo root above the workspace root, relative to it (e.g. "../..") */
  monorepoRoot?: string;
  /** Why results may be incomplete and how to widen the root (only when outOfRootImports > 0) */
  warning?: string;
}

/**
 * Builds the out-of-root report for a workspace root; `summary` is null when it
 * was not tracked. Never contains an absolute path.
 */
export function reportOutOfRootImports(
  summary: OutOfRootImports | null,
  workspaceRoot: string,
): OutOfRootReport {
  if (!summary) {
    return {
      warning:
        "Imports resolving outside the workspace root are not counted while the reverse index is off; " +
        "results may miss files outside this root (VS Code: enable graph-it-live.enableBackgroundIndexing).",
    };
  }
  if (summary.count === 0) return { outOfRootImports: 0 };
  const monorepoRoot = findMonorepoRoot(workspaceRoot);
  const label = monorepoRoot ? toDisplayPath(workspaceRoot, monorepoRoot) : null;
  return {
    outOfRootImports: summary.count,
    outOfRootImportExamples: summary.examples,
    ...(label ? { monorepoRoot: label } : {}),
    warning:
      `${describeOutOfRootImports(summary, label)} Re-index from the monorepo root to include them ` +
      "(CLI --workspace, MCP graphitlive_set_workspace, VS Code: open it as the workspace folder).",
  };
}
