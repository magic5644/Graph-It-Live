/**
 * The static architecture diagram of a workspace, end to end: architecture graph, units, optional
 * rules overlay, layout, markup. Shared by `graph-it diagram`, the export_architecture_diagram MCP
 * tool and its VS Code language model tool, so the three draw the same diagram.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph, type AnalyzeFile } from "../architecture/ArchitectureGraphBuilder";
import { checkWorkspaceArchitecture, loadDeclaredRoles, type ArchitectureRulesFileNames } from "../architecture/architectureRules";
import { assignUnits, buildArchitectureUnits } from "../architecture/architectureUnits";
import type { UnitSource } from "../architecture/architectureView";
import { architectureDiagramInput, layoutDiagram, type DiagramInputOptions } from "./architectureDiagram";
import { layoutMatrix } from "./diagramMatrix";
import type { DIAGRAM_FORMATS, DiagramTheme, DiagramView } from "./diagramStyle";
import { diagramSpec } from "./diagramSpec";
import { renderDiagramHtml, renderDiagramSvg } from "./diagramSvg";

export interface WorkspaceDiagramOptions {
  view: DiagramView;
  /** Unit or folder key whose groups are drawn; with view "matrix", the level of the matrix. */
  folder?: string;
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
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const source = { graph, units: buildArchitectureUnits(graph, workspaceRoot, assignment, await loadDeclaredRoles(workspaceRoot)), assignment };
  const violations = options.rules ? (await checkWorkspaceArchitecture(graph, workspaceRoot, options.rules)).violations : [];
  return renderSourceDiagram(source, workspaceRoot, { ...options, violations });
}

/**
 * The diagram of a path-mode build already made (the VS Code Architecture view's), with the
 * violations of its rules check and the view's filters: the same markup as the CLI for the same options.
 */
export async function renderSourceDiagram(
  source: UnitSource,
  workspaceRoot: string,
  options: Pick<WorkspaceDiagramOptions, "view" | "folder" | "format" | "theme"> & Omit<DiagramInputOptions, "folder">,
) {
  const input = architectureDiagramInput(source, workspaceRoot, options);
  if (options.format === "diagram-spec") {
    // The data alone: no layout, so no size cap and no geometry.
    const spec = diagramSpec(input);
    return { markup: `${JSON.stringify(spec, null, 2)}\n`, counts: spec.caption.counts, width: 0, height: 0 };
  }
  const layout = options.view === "matrix" ? layoutMatrix(input) : await layoutDiagram(input);
  const markup = options.format === "svg" ? renderDiagramSvg(layout, options.theme) : renderDiagramHtml(layout);
  return { markup, counts: layout.text.counts, width: layout.width, height: layout.height };
}
