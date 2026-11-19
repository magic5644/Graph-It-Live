import * as fs from "node:fs";
import * as path from "node:path";
import { getRelativePath } from "../../shared/path";
import { normalizePath } from "../types";

/** How many unresolved imports a report names */
const EXAMPLES = 5;

/** What to do about imports resolving to no file, the same words on every surface (#774). */
export const UNRESOLVED_IMPORTS_NEXT =
  "Run the build or codegen that emits the missing files, or add the importing files to .graphitignore.";

/** A relative or alias import of a workspace file that resolves to no file (a generated file not built yet). */
export interface UnresolvedImport {
  /** The importing file, absolute and normalized */
  importer: string;
  specifier: string;
  /** The nearest existing folder of the missing target, normalized: the files it would import are looked for there */
  reach: string;
}

/** The count, a few examples with their importing file, and what to do; `next` only when the count is above 0. */
export interface UnresolvedImportsReport {
  count: number;
  examples: Array<{ file: string; specifier: string }>;
  next?: string;
}

/** The nearest existing folder of `target`, never above `rootDir`. */
export function nearestExistingDir(target: string, rootDir: string): string {
  const root = path.resolve(rootDir);
  let dir = path.dirname(path.resolve(target));
  while (dir.length > root.length && !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    dir = path.dirname(dir);
  }
  return normalizePath(dir.length > root.length ? dir : root);
}

/** Workspace-relative report of the unresolved imports, examples sorted by file then specifier. */
export function reportUnresolvedImports(imports: readonly UnresolvedImport[], rootDir: string): UnresolvedImportsReport {
  if (imports.length === 0) return { count: 0, examples: [] };
  const examples = imports
    .map(({ importer, specifier }) => ({ file: getRelativePath(importer, rootDir), specifier }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier))
    .slice(0, EXAMPLES);
  return { count: imports.length, examples, next: UNRESOLVED_IMPORTS_NEXT };
}

/** The `unresolvedImports` field of a result; none when the reverse index does not track them (null). */
export function unresolvedImportsField(imports: readonly UnresolvedImport[] | null, rootDir: string): { unresolvedImports?: UnresolvedImportsReport } {
  return imports ? { unresolvedImports: reportUnresolvedImports(imports, rootDir) } : {};
}

/** One line for a terminal or a log, or null when every import resolves. */
export function describeUnresolvedImports(report: UnresolvedImportsReport): string | null {
  if (report.count === 0) return null;
  const plural = report.count !== 1;
  const examples = report.examples.map(({ file, specifier }) => `${file} imports ${specifier}`).join(", ");
  return (
    `${report.count} import${plural ? "s" : ""} of workspace files resolve${plural ? "" : "s"} to no file (e.g. ${examples}); ` +
    `dead-file and unused-export results may list files ${plural ? "they" : "it"} would import. ${UNRESOLVED_IMPORTS_NEXT}`
  );
}

/** The unresolved imports that may import `filePath`: those whose missing target's folder holds it, the file's own aside. */
export function unresolvedImportsReaching(filePath: string, imports: readonly UnresolvedImport[]): UnresolvedImport[] {
  const file = normalizePath(filePath);
  return imports.filter(({ importer, reach }) => importer !== file && file.startsWith(`${reach}/`));
}
