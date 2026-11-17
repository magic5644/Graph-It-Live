import { normalizePath, type Dependency, type ILanguageAnalyzer, type ImportResolution } from "../types";
import { toReportableSpecifier } from "./workspaceBoundary";

export interface ResolvedFileImports {
  /** In-root dependencies, deduplicated by normalized target path */
  dependencies: Dependency[];
  /** Specifiers whose target lies outside the workspace root (reportable, deduplicated) */
  outOfRootImports: string[];
  /** Specifiers that resolved to nothing (not outside the root), so creating their target can re-resolve them (deduplicated) */
  unresolvedImports: string[];
}

/**
 * Resolve the parsed imports of one file, keeping in-root targets and counting
 * those the workspace-root boundary drops, so a narrow root can be reported
 * instead of looking complete. Shared by main-thread and worker indexing.
 */
export async function resolveFileImports(
  analyzer: ILanguageAnalyzer,
  filePath: string,
  parsedImports: readonly Dependency[],
  isWithinWorkspace: (resolvedPath: string) => boolean,
): Promise<ResolvedFileImports> {
  const dependencies: Dependency[] = [];
  const seenResolvedPaths = new Map<string, Dependency>();
  const outOfRootImports = new Set<string>();
  const unresolvedImports = new Set<string>();

  const resolutions = await Promise.all(
    parsedImports.map(async (imp): Promise<ImportResolution> =>
      analyzer.resolveImport
        ? analyzer.resolveImport(filePath, imp.module)
        : applyBoundary(await analyzer.resolvePath(filePath, imp.module), isWithinWorkspace),
    ),
  );

  for (const [index, imp] of parsedImports.entries()) {
    const { path: resolvedPath, outsideRoot } = resolutions[index];

    if (outsideRoot) {
      outOfRootImports.add(toReportableSpecifier(imp.module));
      continue;
    }
    if (!resolvedPath) {
      unresolvedImports.add(imp.module);
      continue;
    }

    const normalizedResolved = normalizePath(resolvedPath);
    const previous = seenResolvedPaths.get(normalizedResolved);
    if (previous) {
      mergeImport(previous, imp);
      continue;
    }

    const dependency: Dependency = {
      path: normalizedResolved,
      type: imp.type,
      line: imp.line,
      module: imp.module,
      ...(imp.typeOnly ? { typeOnly: true } : {}),
    };
    seenResolvedPaths.set(normalizedResolved, dependency);
    dependencies.push(dependency);
  }

  return { dependencies, outOfRootImports: [...outOfRootImports], unresolvedImports: [...unresolvedImports] };
}

/** What loading the target costs: type-only (erased) < dynamic `import()` (lazy) < static (#740, #741). */
function importStrength(imp: Pick<Dependency, "type" | "typeOnly">): number {
  if (imp.typeOnly) return 0;
  return imp.type === "dynamic" ? 1 : 2;
}

/**
 * Folds a second import of one target into the first: the strongest kind wins, so a target stays
 * type-only or lazy only while every import of it is; the first line and specifier stay.
 */
export function mergeImport(previous: Pick<Dependency, "type" | "typeOnly">, next: Pick<Dependency, "type" | "typeOnly">): void {
  if (importStrength(next) <= importStrength(previous)) return;
  // A static import replaces a lazy one; a lazy one replaces an `import type`, never an `export type`:
  // re-export lookups read `export` (SpiderSymbolService.directReexports), so that one stays runtime.
  if (previous.type === "dynamic" || (next.type === "dynamic" && previous.type === "import")) previous.type = next.type;
  delete previous.typeOnly;
}

/** Boundary check for analyzers without resolveImport(), which apply none themselves. */
function applyBoundary(
  resolvedPath: string | null,
  isWithinWorkspace: (resolvedPath: string) => boolean,
): ImportResolution {
  if (resolvedPath && !isWithinWorkspace(resolvedPath)) return { path: null, outsideRoot: true };
  return { path: resolvedPath, outsideRoot: false };
}
