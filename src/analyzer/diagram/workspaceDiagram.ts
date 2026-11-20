/**
 * The static architecture diagram of a workspace, end to end: architecture graph, units, optional
 * rules overlay, layout, markup; and the flow diagram of one entry symbol. Shared by `graph-it diagram`,
 * the export_architecture_diagram MCP tool and its VS Code language model tool, so the three draw the same diagram.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph, type AnalyzeFile } from "../architecture/ArchitectureGraphBuilder";
import { ARCHITECTURE_CONFIG_FILE, type ArchitectureRulesFileNames } from "../architecture/architectureRules";
import { directoryFolderKey } from "../architecture/architectureUnits";
import { loadWorkspaceUnits, type UnitSource } from "../architecture/workspaceUnits";
import type { Database } from "sql.js";
import { architectureDiagramInput, layoutDiagram, workspaceName, type DiagramInputOptions, type DrawOptions } from "./architectureDiagram";
import { layoutMatrix } from "./diagramMatrix";
import type { DIAGRAM_FORMATS, DiagramTheme, DiagramView } from "./diagramStyle";
import { diagramSpec, flowSpec } from "./diagramSpec";
import { renderDiagramHtml, renderDiagramSvg } from "./diagramSvg";
import { layoutFlow } from "./flowDiagram";
import { buildFlowModel, type FlowModelRequest, type FlowModelSources } from "./flowModel";

export interface WorkspaceDiagramOptions {
  view: DiagramView;
  /** Unit or folder key whose groups are drawn; with view "matrix", the level of the matrix. */
  folder?: string;
  /** Workspace directory (relative, "/"-separated) drawn instead of `folder`: mapped to its unit or folder key. */
  directory?: string;
  format: (typeof DIAGRAM_FORMATS)[number];
  /** Colours of the SVG; the HTML page follows the reader's scheme, the spec has none. */
  theme: DiagramTheme;
  /** Rules files of the violations overlay, or undefined for no overlay. */
  rules?: ArchitectureRulesFileNames;
  indexedAt?: string;
  signal?: AbortSignal;
}

/** The markup of one diagram (or its JSON spec) and its counts line ("12 units, 30 edges, ..."). */
export async function renderWorkspaceDiagram(workspaceRoot: string, analyze: AnalyzeFile, options: WorkspaceDiagramOptions) {
  const graph = await buildArchitectureGraph(workspaceRoot, analyze, {
    communityMode: "path",
    indexedAt: options.indexedAt,
    signal: options.signal,
  });
  // The overlay names its config, so a missing one is an error; else the units read the default config when there is one.
  const files = options.rules === undefined ? {} : { config: options.rules.config ?? ARCHITECTURE_CONFIG_FILE, baseline: options.rules.baseline };
  const source = await loadWorkspaceUnits(graph, workspaceRoot, files);
  const violations = options.rules === undefined ? [] : source.check?.violations ?? [];
  const folder = options.directory === undefined ? options.folder : directoryFolderKey(source.assignment, options.directory);
  return renderSourceDiagram(source, workspaceRoot, { ...options, folder, violations });
}

/**
 * The diagram of a path-mode build already made (the VS Code Architecture view's), with the
 * violations of its rules check and the view's filters: the same markup as the CLI for the same options.
 */
export async function renderSourceDiagram(
  source: UnitSource,
  workspaceRoot: string,
  options: Pick<WorkspaceDiagramOptions, "view" | "folder" | "format" | "theme"> & Omit<DiagramInputOptions, "folder"> & { draw?: DrawOptions },
) {
  const input = architectureDiagramInput(source, workspaceRoot, options);
  if (options.format === "diagram-spec") {
    // The data alone: no layout, so no size cap and no geometry.
    const spec = diagramSpec(input);
    return { markup: `${JSON.stringify(spec, null, 2)}\n`, counts: spec.caption.counts, width: 0, height: 0 };
  }
  const layout = options.view === "matrix" ? layoutMatrix(input, options.draw) : await layoutDiagram(input, options.draw);
  const markup = options.format === "svg" ? renderDiagramSvg(layout, options.theme) : renderDiagramHtml(layout);
  return { markup, counts: layout.text.counts, width: layout.width, height: layout.height };
}

/** The flow diagram of one entry symbol from the call graph index `db`, or its spec, and its counts line ("4 steps · 5 calls"). */
export async function renderFlowDiagram(
  db: Database,
  sources: FlowModelSources,
  request: FlowModelRequest,
  options: Pick<WorkspaceDiagramOptions, "format" | "theme">,
) {
  const model = await buildFlowModel(db, request, sources);
  const layout = layoutFlow(model, sources.rootDir);
  if (options.format === "diagram-spec") {
    return { markup: `${JSON.stringify(flowSpec(model, workspaceName(sources.rootDir)), null, 2)}\n`, counts: layout.text.counts };
  }
  const markup = options.format === "svg" ? renderDiagramSvg(layout, options.theme) : renderDiagramHtml(layout);
  return { markup, counts: layout.text.counts };
}
