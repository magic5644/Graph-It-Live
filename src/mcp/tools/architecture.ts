/**
 * explore_architecture MCP tool: the analyzer's architecture graph and views,
 * analysed through the MCP/CLI Spider.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { Database } from "sql.js";
import { exploreArchitecture, exploreArchitectureCheck, exploreCoupling, exploreMatrix, exploreUnitEvidence, exploreUnits } from "../../analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile } from "../../analyzer/architecture/ArchitectureGraphBuilder";
import { architectureCoupling } from "../../analyzer/architecture/architectureCoupling";
import { groupLevel, unitLevel, type ArchitectureLevel } from "../../analyzer/architecture/architectureMatrix";
import { checkWorkspaceArchitecture } from "../../analyzer/architecture/architectureRules";
import { folderLevel } from "../../analyzer/architecture/architectureUnits";
import { loadWorkspaceUnits } from "../../analyzer/architecture/workspaceUnits";
import { defaultDiagramFile, diagramLevel } from "../../analyzer/diagram/diagramStyle";
import { readDiagramSpec, specFlowRequest, specLevel, type LoadedSpec } from "../../analyzer/diagram/diagramSpecImport";
import type { FlowModelSources } from "../../analyzer/diagram/flowModel";
import { renderFlowDiagram, renderWorkspaceDiagram } from "../../analyzer/diagram/workspaceDiagram";
import { getRelativePath, normalizePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { workerState } from "../shared/state";
import { ensureCallGraphReady } from "./callgraph";
import type { CheckArchitectureParams, ExploreArchitectureParams, ExportArchitectureDiagramParams } from "../types";

/**
 * Progressive exploration of the grouped architecture: a bounded summary, one group with
 * its boundary, the file pairs behind one group edge, the units with their layers or the file
 * pairs behind one unit edge; with `folder`, the same views one level below a unit or folder;
 * with `view: "matrix"`, the level's dependency structure matrix; with `view: "coupling"`, its most
 * coupled pairs and bridging files.
 */
export async function executeExploreArchitecture(
  params: ExploreArchitectureParams,
  signal?: AbortSignal,
) {
  // ponytail: rebuilds the graph on every call (Spider caches each file's analysis); cache by index revision if paging gets slow.
  const graph = await buildArchitectureGraph(
    workerState.getConfig().rootDir,
    (filePath) => workerState.getSpider().analyzeFromIndex(filePath),
    { maxFiles: params.maxFiles, communityMode: params.communityMode, signal },
  );
  const { rootDir } = workerState.getConfig();
  if (params.level === "units") {
    const { units, assignment } = await loadWorkspaceUnits(graph, rootDir);
    if (params.view !== undefined) return exploreLevel(unitLevel(graph, units, assignment.unitOf), params.view, { ...params, units: true });
    if (params.from !== undefined && params.to !== undefined) {
      return exploreUnitEvidence(graph, units, assignment.unitOf, { ...params, from: String(params.from), to: String(params.to) });
    }
    // Where the units come from and the config's verdicts, as graph-it architecture --level units --format json reports them.
    const { unitsFrom, configFile, baselineFile, configWarnings, rules } = units;
    return { ...exploreUnits(units, params), unitsFrom, configFile, baselineFile, configWarnings, rules };
  }
  if (params.folder !== undefined) {
    const { graph: level, nestedGroups } = folderLevel(await loadWorkspaceUnits(graph, rootDir), params.folder);
    if (params.view !== undefined) return { folder: params.folder, nestedGroups, ...exploreLevel(groupLevel(level), params.view, params) };
    return { folder: params.folder, nestedGroups, ...exploreArchitecture(level, params) };
  }
  if (params.view !== undefined) return exploreLevel(groupLevel(graph), params.view, params);
  return exploreArchitecture(graph, params);
}

/** The matrix or coupling view of one level (units, a folder's groups or the groups), paged. */
function exploreLevel(
  level: ArchitectureLevel,
  view: NonNullable<ExploreArchitectureParams["view"]>,
  options: Parameters<typeof exploreMatrix>[2],
) {
  return view === "matrix"
    ? exploreMatrix(level.matrix, level.context, options)
    : exploreCoupling(architectureCoupling(level.matrix.rows, level.edges, level.rowOf), level.context, options);
}

/** The declared architecture rules checked against every import pair, violations paged. */
export async function executeCheckArchitecture(params: CheckArchitectureParams, signal?: AbortSignal) {
  const { rootDir } = workerState.getConfig();
  const graph = await buildArchitectureGraph(rootDir, (filePath) => workerState.getSpider().analyzeFromIndex(filePath), { signal });
  const check = await checkWorkspaceArchitecture(graph, rootDir, { config: params.config, baseline: params.baseline });
  return exploreArchitectureCheck(check, params);
}

/** Markup returned inline up to this many characters (about 15k tokens); a larger diagram is written to a file. */
export const INLINE_DIAGRAM_MAX_CHARS = 60_000;

/** What a flow diagram reads: the call graph index and a parser of the steps' files. */
export interface FlowSources {
  db: Database;
  extractor: FlowModelSources["extractor"];
}

/**
 * The static architecture diagram (or with view flow, one entry symbol's flow), inline when it fits
 * the cap and no output is asked for, else written under the workspace and returned as a
 * workspace-relative path. Shared by the MCP tool, the CLI and the VS Code language model tool;
 * `flow` opens the call graph only when view flow asks for it.
 */
export async function exportArchitectureDiagram(
  rootDir: string,
  analyze: AnalyzeFile,
  params: ExportArchitectureDiagramParams,
  signal?: AbortSignal,
  flow?: () => Promise<FlowSources>,
) {
  const format = params.diagramFormat ?? "svg";
  // Refused before any work (CWE-22): the output stays in the workspace, as the rules files do.
  // The raw value, so a refusal names the given path and not the workspace's absolute location.
  const target = params.output === undefined ? undefined : validateWorkspacePath(params.output, rootDir);
  const spec = params.spec === undefined ? undefined : await readDiagramSpec(rootDir, params.spec);
  if (spec !== undefined && target !== undefined && normalizePath(target) === normalizePath(spec.absolute)) {
    throw new Error(`output ${params.output} would replace the spec it reads: pass another file.`);
  }
  const { markup, counts, cut = [] } = await renderDiagram(rootDir, analyze, params, signal, flow, spec);
  // The annotated texts cut to fit their box, by JSON path.
  const notes = cut.length > 0 ? { cut } : {};
  if (target === undefined && markup.length <= INLINE_DIAGRAM_MAX_CHARS) return { format, counts, markup, ...notes };

  // Validated too: a symbolic link at the default name must not lead outside the workspace.
  let view = params.view;
  if (spec !== undefined) view = spec.kind === "flow" ? "flow" : undefined;
  const file = target ?? validateWorkspacePath(defaultDiagramFile(format, view), rootDir);
  await fs.promises.mkdir(nodePath.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, markup);
  return { format, counts, path: getRelativePath(file, rootDir), characters: markup.length, ...notes };
}

async function renderDiagram(
  rootDir: string,
  analyze: AnalyzeFile,
  params: ExportArchitectureDiagramParams,
  signal?: AbortSignal,
  flow?: () => Promise<FlowSources>,
  spec?: LoadedSpec,
) {
  const format = params.diagramFormat ?? "svg";
  const theme = params.theme ?? "light";
  if (spec?.kind === "flow") {
    const rulesParam = (["rules", "config", "baseline"] as const).find((key) => params[key] !== undefined);
    if (rulesParam !== undefined) throw new Error(`${rulesParam} applies to an architecture spec, not a flow spec.`);
    if (flow === undefined) throw new Error("a flow spec needs the call graph index");
    const { db, extractor } = await flow();
    return renderFlowDiagram(db, { rootDir, extractor }, specFlowRequest(spec, rootDir), { format, theme, spec });
  }
  if (params.view === "flow") {
    const { filePath, symbolName, startLine, maxSteps } = params;
    if (filePath === undefined || symbolName === undefined) throw new Error("view flow draws one symbol's flow: pass filePath and symbolName");
    if (flow === undefined) throw new Error("view flow needs the call graph index");
    // Resolved against the workspace and refused outside it (CWE-22), whichever surface called.
    const request = { filePath: validateWorkspacePath(filePath, rootDir), symbolName, startLine, maxSteps };
    const { db, extractor } = await flow();
    return renderFlowDiagram(db, { rootDir, extractor }, request, { format, theme });
  }
  return renderWorkspaceDiagram(rootDir, analyze, {
    ...(spec === undefined ? diagramLevel(params.view, params.folder) : specLevel(spec)),
    spec,
    format,
    theme,
    rules: params.rules ? { config: params.config, baseline: params.baseline } : undefined,
    // The analyses are current at the call (the watchers keep them so): date the diagram today.
    indexedAt: new Date().toISOString(),
    signal,
  });
}

/** The call graph of the MCP worker or the CLI, indexed on first use (restored from the cache when warm). */
export async function workerFlowSources(): Promise<FlowSources> {
  await ensureCallGraphReady();
  const { callGraphIndexer, graphExtractor } = workerState;
  if (!callGraphIndexer || !graphExtractor) throw new Error("Call graph indexer not initialized");
  return { db: callGraphIndexer.getDb(), extractor: graphExtractor };
}

export function executeExportArchitectureDiagram(params: ExportArchitectureDiagramParams, signal?: AbortSignal) {
  return exportArchitectureDiagram(
    workerState.getConfig().rootDir,
    (filePath) => workerState.getSpider().analyzeFromIndex(filePath),
    params,
    signal,
    workerFlowSources,
  );
}
