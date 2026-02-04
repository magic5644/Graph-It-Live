import { getRelativePath, validateFileExists } from "../shared/helpers";
import { workerState } from "../shared/state";
import type { ResolveModulePathParams, ResolveModulePathResult } from "../types";

/**
 * Resolve a module specifier to an absolute path
 */
export async function executeResolveModulePath(
  params: ResolveModulePathParams,
): Promise<ResolveModulePathResult> {
  const { fromFile, moduleSpecifier } = params;
  const resolver = workerState.getResolver();
  const config = workerState.getConfig();

  // Validate source file exists
  await validateFileExists(fromFile);

  try {
    const resolvedPath = await resolver.resolve(fromFile, moduleSpecifier);

    if (resolvedPath) {
      return {
        fromFile,
        moduleSpecifier,
        resolved: true,
        resolvedPath,
        resolvedRelativePath: getRelativePath(resolvedPath, config.rootDir),
      };
    }

    return {
      fromFile,
      moduleSpecifier,
      resolved: false,
      resolvedPath: null,
      resolvedRelativePath: null,
      failureReason:
        "Module could not be resolved (may be a node_module or non-existent file)",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      fromFile,
      moduleSpecifier,
      resolved: false,
      resolvedPath: null,
      resolvedRelativePath: null,
      failureReason: errorMessage,
    };
  }
}
