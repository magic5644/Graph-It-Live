/**
 * CLI Command: summary
 *
 * Renders a workspace overview (files, import edges, most imported files, largest folders),
 * or the index status and codemap of one file.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import { unresolvedImportsField } from "../../analyzer/utils/unresolvedImports.js";
import { workerState } from "../../mcp/shared/state";
import { executeGetIndexStatus, executeGenerateCodemap } from "../../mcp/tools";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";
import { parseTargetRef } from "../symbols";

const TOP = 8;

/** The `TOP` largest entries of `counts`, largest first, then by key. */
function largest(counts: Map<string, number>): Array<[string, number]> {
  return [...counts].sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey)).slice(0, TOP);
}

/** What the workspace holds, without a file argument: the overview `summary` promises, not the index status. */
async function workspaceOverview(runtime: CliRuntime) {
  const { nodes, edges, scannedFiles, failedFiles } = await runtime.progress.phase("Analyzing workspace", (onProgress) =>
    buildArchitectureGraph(runtime.workspaceRoot, (filePath) => workerState.getSpider().analyzeFromIndex(filePath), {
      indexedAt: runtime.loadState()?.lastScanTimestamp,
      onProgress,
    }));
  const extensions = new Map<string, number>();
  const folders = new Map<string, number>();
  for (const node of nodes) {
    extensions.set(node.extension, (extensions.get(node.extension) ?? 0) + 1);
    if (node.communityKey) folders.set(node.communityKey, (folders.get(node.communityKey) ?? 0) + 1);
  }
  const mostImported = [...nodes]
    .filter((node) => node.dependentCount > 0)
    .sort((left, right) => right.dependentCount - left.dependentCount || left.relativePath.localeCompare(right.relativePath))
    .slice(0, TOP)
    .map((node) => ({ file: node.relativePath, importedBy: node.dependentCount, imports: node.dependencyCount }));
  return {
    files: scannedFiles,
    failedFiles: failedFiles.length,
    importEdges: edges.length,
    ...unresolvedImportsField(await workerState.getSpider().getUnresolvedImports(), runtime.workspaceRoot),
    extensions: Object.fromEntries(largest(extensions)),
    mostImported,
    largestFolders: largest(folders).map(([folder, files]) => ({ folder, files })),
    next: "graph-it summary <file> shows one file's codemap; graph-it architecture --level units shows the units and their layers.",
  };
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  await runtime.ensureIndexed();

  if (args.length === 0) return formatOutput(await workspaceOverview(runtime), format, "summary");

  const ref = parseTargetRef(args[0], runtime.workspaceRoot);
  const status = await executeGetIndexStatus();
  const codemap = await executeGenerateCodemap({ filePath: ref.filePath });
  return formatOutput({ indexStatus: status, codemap }, format, "summary");
}
