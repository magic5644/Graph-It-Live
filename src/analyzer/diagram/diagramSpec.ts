/**
 * The diagram spec: the exact data of one architecture diagram level as a small JSON document
 * (schemas/diagram-spec.schema.json), for an agent diagram skill that draws a hand-crafted or
 * branded diagram. The same level, filters and violations as the SVG, but every node: the size
 * cap is a drawing concern, left to the skill.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { byCodeUnit } from "../architecture/architectureUnits";
import { brokenRules, cyclesOf, diagramHeader, sanitizeText, type DiagramEdge, type DiagramInput, type DiagramNode } from "./architectureDiagram";

export const DIAGRAM_SPEC_SCHEMA = "https://raw.githubusercontent.com/magic5644/Graph-It-Live/main/schemas/diagram-spec.schema.json";

/** Bumped when a field changes meaning or goes away; new optional fields keep it. */
export const DIAGRAM_SPEC_VERSION = 1;

export interface DiagramSpec {
  $schema: string;
  version: number;
  /** Workspace folder name, never its absolute path. */
  workspace: string;
  /** What a node is: "units" (packages, else top-level folders) or "groups" (the folders of one unit or folder). */
  level: string;
  /** "units", or the entered unit or folder key. */
  scope: string;
  revision: string;
  date?: string;
  filters?: string[];
  /** The header lines the generated diagram draws. */
  caption: { title: string; caption: string; counts: string };
  counts: { nodes: number; layers: number; cycles: number; edges: number; violations: number };
  /** Layer 0 depends on no other node of the level: draw it at the bottom. */
  layers: { layer: number; nodes: string[] }[];
  nodes: (Omit<DiagramNode, "internalEdgeCount"> & { internalEdgeCount: number })[];
  edges: (Omit<DiagramEdge, "accepted"> & { accepted: boolean })[];
  /** Nodes of one dependency cycle, two or more each. */
  cycles: string[][];
  /** Rule-breaking file pairs between two nodes, those the baseline accepts, and the broken rules' names. */
  violations: { count: number; accepted: number; rules: string[] };
}

/** The spec of one level: every node and edge, sorted by key, so one index revision gives one document. */
export function diagramSpec(input: DiagramInput): DiagramSpec {
  const { counts, text } = diagramHeader(input, 0, input.nodes.length);
  const nodes = input.nodes.toSorted((left, right) => byCodeUnit(left.key, right.key));
  const edges = input.edges.toSorted((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to));
  const layers = [...new Set(nodes.map((node) => node.layer))].sort((left, right) => left - right);
  return {
    $schema: DIAGRAM_SPEC_SCHEMA,
    version: DIAGRAM_SPEC_VERSION,
    workspace: sanitizeText(input.workspace),
    level: input.noun,
    scope: input.scope,
    revision: input.revision,
    ...(input.date === undefined ? {} : { date: input.date }),
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    caption: { title: text.title, caption: text.caption, counts: text.counts },
    counts: { ...counts, edges: edges.length },
    layers: layers.map((layer) => ({ layer, nodes: nodes.filter((node) => node.layer === layer).map((node) => node.key) })),
    nodes: nodes.map((node) => ({ ...node, label: sanitizeText(node.label), internalEdgeCount: node.internalEdgeCount ?? 0 })),
    edges: edges.map((edge) => ({ ...edge, accepted: edge.accepted === true })),
    cycles: cyclesOf(nodes.map((node) => node.key), edges),
    violations: { count: input.violations, accepted: input.acceptedViolations ?? 0, rules: brokenRules(edges) },
  };
}
