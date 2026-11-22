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
import { architectureDiagramInput, layoutDiagram, workspaceName, type DiagramInput, type DiagramInputOptions, type DrawOptions } from "./architectureDiagram";
import { layoutMatrix } from "./diagramMatrix";
import type { DIAGRAM_FORMATS, DiagramTheme, DiagramView } from "./diagramStyle";
import { diagramSpec, flowSpec, sequenceSpec } from "./diagramSpec";
import { annotateSpec, type LoadedSpec } from "./diagramSpecImport";
import { renderDiagramHtml, renderDiagramSvg } from "./diagramSvg";
import { layoutFlow } from "./flowDiagram";
import { buildFlowModel, type FlowModel, type FlowModelRequest, type FlowModelSources } from "./flowModel";
import { layoutSequence, sequenceMermaid } from "./sequenceDiagram";
import { buildSequenceModel, type SequenceModel, type SequenceModelRequest } from "./sequenceModel";

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
  /** An annotated spec of the same level (#794): its texts are drawn, anything else must match the index. */
  spec?: LoadedSpec;
}

/** The level's input with the annotated node labels and caption of `spec`, refused when it differs otherwise. */
function annotateLevel(spec: LoadedSpec, input: DiagramInput): { input: DiagramInput; cut: string[] } {
  const { spec: annotated, cut } = annotateSpec(spec, diagramSpec(input));
  const labels = new Map(annotated.nodes.map((node) => [node.key, node.label]));
  const { title, caption } = annotated.caption;
  return { input: { ...input, caption: { title, caption }, nodes: input.nodes.map((node) => ({ ...node, label: labels.get(node.key) ?? node.label })) }, cut };
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
  options: Pick<WorkspaceDiagramOptions, "view" | "folder" | "format" | "theme" | "spec"> & Omit<DiagramInputOptions, "folder"> & { draw?: DrawOptions },
) {
  if (options.format === "mermaid") throw new Error(MERMAID_SEQUENCE_ONLY);
  const level = architectureDiagramInput(source, workspaceRoot, options);
  const { input, cut } = options.spec === undefined ? { input: level, cut: [] } : annotateLevel(options.spec, level);
  if (options.format === "diagram-spec") {
    // The data alone: no layout, so no size cap and no geometry.
    const spec = diagramSpec(input);
    return { markup: `${JSON.stringify(spec, null, 2)}\n`, counts: spec.caption.counts, width: 0, height: 0, cut };
  }
  const layout = options.view === "matrix" ? layoutMatrix(input, options.draw) : await layoutDiagram(input, options.draw);
  const markup = options.format === "svg" ? renderDiagramSvg(layout, options.theme) : renderDiagramHtml(layout);
  return { markup, counts: layout.text.counts, width: layout.width, height: layout.height, cut };
}

/**
 * The flow diagram of one entry symbol from the call graph index `db`, or its spec, and its counts line ("4 steps · 5 calls"),
 * with the layout it drew and the model it laid out (the annotated one with `options.spec`): `layout.nodes[i]` is
 * `model.nodes[i]`, `layout.edges[j]` is `model.edges[layout.edges[j].edge]`.
 */
export async function renderFlowDiagram(
  db: Database,
  sources: FlowModelSources,
  request: FlowModelRequest,
  options: Pick<WorkspaceDiagramOptions, "format" | "theme" | "spec">,
) {
  const { spec } = options;
  const workspace = workspaceName(sources.rootDir);
  const built = await buildFlowModel(db, request, sources).catch(staleSpec(spec));
  // An annotated spec is a model too: the same steps and calls, with its texts.
  const { spec: model, cut }: { spec: FlowModel; cut: string[] } = spec === undefined ? { spec: built, cut: [] } : annotateSpec(spec, flowSpec(built, workspace));
  const layout = layoutFlow(model, sources.rootDir);
  if (options.format === "diagram-spec") {
    return { markup: `${JSON.stringify(flowSpec(model, workspace), null, 2)}\n`, counts: layout.text.counts, cut, layout, model };
  }
  if (options.format === "mermaid") throw new Error(MERMAID_SEQUENCE_ONLY);
  const markup = options.format === "svg" ? renderDiagramSvg(layout, options.theme) : renderDiagramHtml(layout);
  return { markup, counts: layout.text.counts, cut, layout, model };
}

/** The one-line refusal of format mermaid for a diagram that is not a sequence. */
export const MERMAID_SEQUENCE_ONLY = "format mermaid writes a sequence diagram only: use view sequence, or format svg, html or diagram-spec.";

/** A model the spec names that the index no longer builds: the spec is stale. */
const staleSpec = (spec: LoadedSpec | undefined) => (error: unknown): never => {
  if (spec === undefined || !(error instanceof Error)) throw error;
  throw new Error(`${spec.file} is stale: ${error.message} Export the spec again in format diagram-spec.`, { cause: error });
};

/**
 * The sequence diagram of one entry symbol from the call graph index `db` (SVG, HTML, Mermaid text or its spec) and
 * its counts line ("4 lifelines · 9 calls · …"), with the layout it drew and the model it laid out (the annotated one
 * with `options.spec`): `layout.messages[i]` is `model.messages[i]`.
 */
export async function renderSequenceDiagram(
  db: Database,
  sources: FlowModelSources,
  request: SequenceModelRequest,
  options: Pick<WorkspaceDiagramOptions, "format" | "theme" | "spec">,
) {
  const { spec } = options;
  const workspace = workspaceName(sources.rootDir);
  const built = await buildSequenceModel(db, request, sources).catch(staleSpec(spec));
  // An annotated spec is a model too: the same lifelines, messages and fragments, with its texts.
  const { spec: model, cut }: { spec: SequenceModel; cut: string[] } =
    spec === undefined ? { spec: built, cut: [] } : annotateSpec(spec, sequenceSpec(built, workspace));
  const layout = layoutSequence(model, sources.rootDir);
  const counts = layout.text.counts;
  if (options.format === "diagram-spec") return { markup: `${JSON.stringify(sequenceSpec(model, workspace), null, 2)}\n`, counts, cut, layout, model };
  if (options.format === "mermaid") return { markup: sequenceMermaid(model, sources.rootDir), counts, cut, layout, model };
  const markup = options.format === "svg" ? renderDiagramSvg(layout, options.theme) : renderDiagramHtml(layout);
  return { markup, counts, cut, layout, model };
}
