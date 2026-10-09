import { normalizePath, type Dependency, type ILanguageAnalyzer, type ImportResolution } from "../types";
import { toReportableSpecifier } from "./workspaceBoundary";

export interface ResolvedFileImports {
  /** In-root dependencies, deduplicated by normalized target path */
  dependencies: Dependency[];
  /** Specifiers whose target lies outside the workspace root (reportable, deduplicated) */
  outOfRootImports: string[];
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
  const seenResolvedPaths = new Set<string>();
  const outOfRootImports = new Set<string>();

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
    if (!resolvedPath) continue;

    const normalizedResolved = normalizePath(resolvedPath);
    if (seenResolvedPaths.has(normalizedResolved)) continue;
    seenResolvedPaths.add(normalizedResolved);

    dependencies.push({
      path: normalizedResolved,
      type: imp.type,
      line: imp.line,
      module: imp.module,
    });
  }

  return { dependencies, outOfRootImports: [...outOfRootImports] };
}

/** Boundary check for analyzers without resolveImport(), which apply none themselves. */
function applyBoundary(
  resolvedPath: string | null,
  isWithinWorkspace: (resolvedPath: string) => boolean,
): ImportResolution {
  if (resolvedPath && !isWithinWorkspace(resolvedPath)) return { path: null, outsideRoot: true };
  return { path: resolvedPath, outsideRoot: false };
}
