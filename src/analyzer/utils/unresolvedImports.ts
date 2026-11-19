import * as fs from "node:fs";
import * as path from "node:path";
import { getRelativePath } from "../../shared/path";
import { normalizePath } from "../types";
import { findProjectRoot } from "./workspaceBoundary";

/** How many unresolved imports a report names */
const EXAMPLES = 5;

/** What to do about imports resolving to no file, the same words on every surface (#774). */
export const UNRESOLVED_IMPORTS_NEXT =
  "Run the build or codegen that emits the missing files, or add the importing files to .graphitignore.";

/** What to do about imports whose letter case differs from the file's. */
export const CASE_MISMATCH_NEXT = "Write each import with the file's letter case: it breaks on case-sensitive file systems (Linux).";

/** What to do about imports of files the analysis leaves out. */
export const EXCLUDED_IMPORTS_NEXT =
  "Re-include an excluded file with a !<path> line in .graphitignore, or exclude its importers too.";

/**
 * An import of a workspace file the analysis cannot follow (#774): its target does not exist (a generated file not
 * built yet), or `excluded`, it exists but .gitignore, .graphitignore or a default exclusion leaves it out, so the
 * imports it holds are never seen.
 */
export interface UnresolvedImport {
  /** The importing file, absolute and normalized */
  importer: string;
  specifier: string;
  /**
   * The folder the target's imports are looked for in, normalized: the nearest existing folder of a missing target,
   * the folder of an excluded one. Absent when no dead-file verdict hinges on the import: the target holds no code
   * (data, asset) or that folder lies above the importing file's project folder (`../../vitest.config`).
   */
  reach?: string;
  /** Indexed files below `reach`: what the import may hide, the order of the report's examples */
  reachFiles?: number;
  excluded?: boolean;
  /** The existing file whose name differs from the import's only in letter case, normalized */
  caseOf?: string;
  /** The existing file the import names, which the analysis does not read (`settings.json`), normalized */
  notAnalyzed?: string;
}

/** An import the analysis cannot follow, before locate: its target, absolute (missing, or `excluded`). */
export interface UnfollowedImport {
  importer: string;
  specifier: string;
  target: string;
  excluded?: boolean;
  caseOf?: string;
  notAnalyzed?: string;
}

/** Data and asset files: a missing one holds no import, so it never makes a dead-file verdict doubtful. */
const NON_CODE_EXTENSIONS = new Set([
  ".json", ".css", ".scss", ".sass", ".less", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".md", ".mdx", ".txt", ".html", ".htm", ".yml", ".yaml", ".toml", ".xml", ".csv", ".graphql", ".gql", ".wasm",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".webm", ".wav", ".pdf",
]);

/**
 * A folder's project folder: its nearest project marker, `root` when none lies inside it. Keys and results are
 * normalized (Windows separators and drive case), and each folder is looked up once.
 */
export function projectFolders(root: string, findProject: (dir: string) => string | null = findProjectRoot): (dir: string) => string {
  const normalizedRoot = normalizePath(root);
  const projects = new Map<string, string>();
  return (dir) => {
    const key = normalizePath(dir);
    let project = projects.get(key);
    if (project === undefined) {
      // String compare of normalized paths: path.resolve() would read `d:/x` as relative on POSIX.
      const found = normalizePath(findProject(dir) ?? "");
      project = found === normalizedRoot || found.startsWith(`${normalizedRoot}/`) ? found : normalizedRoot;
      projects.set(key, project);
    }
    return project;
  };
}

/**
 * The reach of each import and the indexed files below it (#774). `projectOf` gives a folder's project folder
 * (nearest project marker, never above the workspace root); a reach above the importer's is dropped.
 */
export function locateUnfollowedImports(
  imports: readonly UnfollowedImport[],
  rootDir: string,
  indexedFiles: readonly string[],
  projectOf: (dir: string) => string,
): UnresolvedImport[] {
  const below = new Map<string, number>();
  const filesBelow = (reach: string) => {
    let count = below.get(reach);
    if (count === undefined) {
      count = indexedFiles.filter((file) => file.startsWith(`${reach}/`)).length;
      below.set(reach, count);
    }
    return count;
  };
  return imports.map(({ importer, specifier, target, excluded, caseOf, notAnalyzed }) => {
    const base = { importer, specifier, ...(excluded ? { excluded } : {}), ...(caseOf ? { caseOf } : {}), ...(notAnalyzed ? { notAnalyzed } : {}) };
    if (notAnalyzed || NON_CODE_EXTENSIONS.has(path.extname(target).toLowerCase())) return base;
    const reach = excluded ? normalizePath(path.dirname(target)) : nearestExistingDir(target, rootDir);
    const project = normalizePath(projectOf(path.dirname(importer)));
    if (reach !== project && !reach.startsWith(`${project}/`)) return base;
    return { ...base, reach, reachFiles: filesBelow(reach) };
  });
}


type Example = { file: string; specifier: string; existing?: string };

/**
 * The imports resolving to no file (`count`) and those resolving to an excluded file (`excludedCount`), a few
 * examples of each with their importing file, and what to do (`next`, only when one count is above 0).
 */
export interface UnresolvedImportsReport {
  count: number;
  examples: Example[];
  excludedCount: number;
  excludedExamples: Example[];
  /** Imports of an existing file written with another letter case: `existing` names the file */
  caseMismatchCount: number;
  caseMismatchExamples: Example[];
  /** Imports of an existing file the analysis does not read (`./settings` with settings.json): `existing` names it */
  notAnalyzedCount: number;
  notAnalyzedExamples: Example[];
  next?: string;
}

/** Whether `dir` is a readable folder; any stat error (ENOENT, ENOTDIR, EACCES) means no. */
function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The files of `target`'s folder named `target` or `target` plus an extension, compared by `same`. */
function filesNamed(target: string, same: (name: string, base: string) => boolean): string[] {
  const base = path.basename(target);
  try {
    return fs.readdirSync(path.dirname(target), { withFileTypes: true })
      .filter((entry) => entry.isFile() && (same(entry.name, base) || same(entry.name.slice(0, base.length), base) && entry.name[base.length] === "."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The existing file an unresolved import names with the same letter case: `target` itself, or `target` plus an
 * extension the analysis does not read (`./settings` with only `settings.json`: no edge on any OS). Null when none.
 */
export function sameCaseFileOf(target: string): string | null {
  const [found] = filesNamed(target, (name, base) => name === base).sort((a, b) => a.localeCompare(b));
  return found === undefined ? null : normalizePath(path.join(path.dirname(target), found));
}

/**
 * The file `target` names when only its letter case differs (`./Users` or `Users.ts` with `users.ts`), else null.
 * macOS and Windows resolve such an import to a path the index does not hold; Linux resolves nothing; at run time
 * it breaks on Linux. Reported the same on all three (#774).
 */
export function caseVariantOf(target: string): string | null {
  if (sameCaseFileOf(target)) return null;
  const [found] = filesNamed(target, (name, base) => name.toLowerCase() === base.toLowerCase());
  return found === undefined ? null : normalizePath(path.join(path.dirname(target), found));
}

/** What a result says when the reverse index is off: unresolved imports are recorded only while it is built. */
export interface UntrackedImportsReport {
  tracked: false;
  warning: string;
}

export const UNTRACKED_IMPORTS: UntrackedImportsReport = {
  tracked: false,
  warning:
    "Imports resolving to no file are not counted while the reverse index is off; dead-file results may miss them " +
    "(VS Code: enable graph-it-live.enableBackgroundIndexing; CLI and MCP index on demand).",
};

/** The `unresolvedImports` field: the report, or why there is none. */
export type UnresolvedImportsField = UnresolvedImportsReport | UntrackedImportsReport;

/** The nearest existing folder of `target`, never above `rootDir`. */
export function nearestExistingDir(target: string, rootDir: string): string {
  const root = path.resolve(rootDir);
  let dir = path.dirname(path.resolve(target));
  while (dir.length > root.length && !isDirectory(dir)) {
    dir = path.dirname(dir);
  }
  return normalizePath(dir.length > root.length ? dir : root);
}

/** Up to EXAMPLES workspace-relative examples: those that may hide the most files first, then by file and specifier. */
function examplesOf(imports: readonly UnresolvedImport[], rootDir: string): Example[] {
  return imports
    .map(({ importer, specifier, reachFiles, caseOf, notAnalyzed }) => ({
      file: getRelativePath(importer, rootDir),
      specifier,
      ...(caseOf ?? notAnalyzed ? { existing: getRelativePath((caseOf ?? notAnalyzed)!, rootDir) } : {}),
      weight: reachFiles ?? 0,
    }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier))
    .slice(0, EXAMPLES)
    .map(({ weight: _weight, ...example }) => example);
}

/** Workspace-relative report of the imports the analysis cannot follow. */
export function reportUnresolvedImports(imports: readonly UnresolvedImport[], rootDir: string): UnresolvedImportsReport {
  const missing = imports.filter((item) => !item.excluded && !item.caseOf && !item.notAnalyzed);
  const notAnalyzed = imports.filter((item) => item.notAnalyzed);
  const excluded = imports.filter((item) => item.excluded);
  const cases = imports.filter((item) => item.caseOf);
  const next = [
    missing.length > 0 ? UNRESOLVED_IMPORTS_NEXT : "",
    excluded.length > 0 ? EXCLUDED_IMPORTS_NEXT : "",
    cases.length > 0 ? CASE_MISMATCH_NEXT : "",
  ].filter(Boolean).join(" ");
  return {
    count: missing.length,
    examples: examplesOf(missing, rootDir),
    excludedCount: excluded.length,
    excludedExamples: examplesOf(excluded, rootDir),
    caseMismatchCount: cases.length,
    caseMismatchExamples: examplesOf(cases, rootDir),
    notAnalyzedCount: notAnalyzed.length,
    notAnalyzedExamples: examplesOf(notAnalyzed, rootDir),
    ...(next ? { next } : {}),
  };
}

/** The `unresolvedImports` field of a result; says it is not tracked when the reverse index is off (null), never absent. */
export function unresolvedImportsField(imports: readonly UnresolvedImport[] | null, rootDir: string): { unresolvedImports: UnresolvedImportsField } {
  return { unresolvedImports: imports ? reportUnresolvedImports(imports, rootDir) : UNTRACKED_IMPORTS };
}

const listed = (examples: readonly Example[]) => examples.map(({ file, specifier }) => `${file} imports ${specifier}`).join(", ");

/** "1 import resolves" / "2 imports resolve": the count with the singular or plural wording. */
const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** One line for a terminal or a log, or null when every import is followed. */
export function describeUnresolvedImports(field: UnresolvedImportsField): string | null {
  if ("tracked" in field) return field.warning;
  const report = field;
  // `?? 0` / `?? []`: a report written before excluded, case and not-analyzed files were counted.
  const cases = (report.caseMismatchExamples ?? []).map(({ file, specifier, existing }) => `${file} imports ${specifier}, which differs only in letter case from ${existing}`).join("; ");
  const notAnalyzed = (report.notAnalyzedExamples ?? []).map(({ file, specifier, existing }) => `${file} imports ${specifier}, which matches ${existing}, which is not analyzed`).join("; ");
  const parts: [number, string][] = [
    [report.count, `${counted(report.count, "import of workspace files resolves", "imports of workspace files resolve")} to no file (e.g. ${listed(report.examples)}).`],
    [report.excludedCount ?? 0, `${counted(report.excludedCount ?? 0, "import resolves", "imports resolve")} to a file excluded from the analysis (.gitignore, .graphitignore or a default exclusion), whose own imports are not followed (e.g. ${listed(report.excludedExamples ?? [])}).`],
    [report.caseMismatchCount ?? 0, `${counted(report.caseMismatchCount ?? 0, "import differs", "imports differ")} only in letter case from an existing file (e.g. ${cases}).`],
    [report.notAnalyzedCount ?? 0, `${counted(report.notAnalyzedCount ?? 0, "import matches", "imports match")} only a file the analysis does not read (e.g. ${notAnalyzed}).`],
  ];
  const shown = parts.filter(([count]) => count > 0).map(([, text]) => text);
  if (shown.length === 0) return null;
  return `${shown.join(" ")} Dead-file and unused-export results may list files they would import. ${report.next ?? ""}`.trimEnd();
}

/** The unresolved imports that may import `filePath`: those whose missing target's folder holds it, the file's own aside. */
export function unresolvedImportsReaching(filePath: string, imports: readonly UnresolvedImport[]): UnresolvedImport[] {
  const file = normalizePath(filePath);
  return imports.filter(({ importer, reach }) => reach !== undefined && importer !== file && file.startsWith(`${reach}/`));
}
