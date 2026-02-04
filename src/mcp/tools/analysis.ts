import * as fs from "node:fs/promises";
import { validateFileExists } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    AnalyzeDependenciesParams,
    AnalyzeDependenciesResult,
    ParseImportsParams,
    ParseImportsResult,
    VerifyDependencyUsageParams,
    VerifyDependencyUsageResult,
} from "../types";
import { enrichDependency } from "../types";

/**
 * Analyze dependencies of a single file
 */
export async function executeAnalyzeDependencies(
  params: AnalyzeDependenciesParams,
): Promise<AnalyzeDependenciesResult> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  // Validate file exists
  await validateFileExists(filePath);

  const dependencies = await spider.analyze(filePath);

  return {
    filePath,
    dependencyCount: dependencies.length,
    dependencies: dependencies.map((dep) =>
      enrichDependency(dep, config.rootDir),
    ),
  };
}

/**
 * Parse imports from a file without resolving paths
 */
export async function executeParseImports(
  params: ParseImportsParams,
): Promise<ParseImportsResult> {
  const { filePath } = params;
  const parser = workerState.getParser();

  // Validate file exists
  await validateFileExists(filePath);

  const content = await fs.readFile(filePath, "utf-8");
  const imports = parser.parse(content, filePath);

  return {
    filePath,
    importCount: imports.length,
    imports: imports.map((imp) => ({
      module: imp.module,
      type: imp.type,
      line: imp.line,
    })),
  };
}

/**
 * Verify if a dependency is actually used
 */
export async function executeVerifyDependencyUsage(
  params: VerifyDependencyUsageParams,
): Promise<VerifyDependencyUsageResult> {
  const { sourceFile, targetFile } = params;
  const spider = workerState.getSpider();

  // Validate file exists
  await validateFileExists(sourceFile);
  await validateFileExists(targetFile);

  const isUsed = await spider.verifyDependencyUsage(sourceFile, targetFile);

  return {
    sourceFile,
    targetFile,
    isUsed,
    usedSymbolCount: isUsed ? undefined : 0, // We don't have count yet, but if unused it's 0
  };
}
