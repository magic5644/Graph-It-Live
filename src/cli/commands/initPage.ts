/**
 * The explorable page `graph-it init --output` writes next to report.md (#718): the units of
 * graphit.architecture.json as groups, cycle / upward edges and violations in the SVG colours,
 * dead files marked, and the findings of report.md. With `--focus`, the units of the focus and
 * their direct neighbours, as units.svg draws them; the page opens on the focus boundary.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureViolation } from "../../analyzer/architecture/architectureRules.js";
import type { UnitSource } from "../../analyzer/architecture/architectureView.js";
import { workspaceName } from "../../analyzer/diagram/architectureDiagram.js";
import type { HtmlEdgeKind, HtmlPageConfig } from "../../analyzer/export/HtmlExporter";
import type { GraphNodeMetadata } from "../../shared/graph-types";
import { reportSections, type InitResult } from "./initReport";

/** Files of the page a finding names: tokens of its subject and details, `file`, `file:` or `file:line`. */
// shortcut: a path holding a space or a comma is never matched; its finding then centres on its units.
function namedFiles(texts: readonly string[], files: ReadonlySet<string>): string[] {
  const tokens = texts.flatMap((text) => text.split(/[\s,]+/)).map((token) => token.replace(/:\d*$/, ""));
  return [...new Set(tokens.filter((token) => files.has(token)))];
}

/** `focus`: the files of `--focus` and the units of the page (its units and their direct neighbours). */
export function initPage(
  { graph, units, assignment }: UnitSource,
  workspaceRoot: string,
  violations: readonly ArchitectureViolation[],
  result: InitResult,
  focus?: { files: ReadonlySet<string>; units: ReadonlySet<string> },
): HtmlPageConfig {
  // Group id = unit index + 1, group label = unit key: the page groups by unit, nothing else.
  const ids = new Map(units.units.filter((unit) => focus === undefined || focus.units.has(unit.key)).map((unit, index) => [unit.key, index + 1]));
  const unitOf = (file: string) => assignment.unitOf.get(file) ?? "";
  const nodes = graph.nodes.filter((node) => ids.has(unitOf(node.relativePath)));
  const relative = new Map(nodes.map((node) => [node.path, node.relativePath]));
  const files = new Set(relative.values());
  const nodeMetadata: Record<string, GraphNodeMetadata> = Object.fromEntries(nodes.map((node) => {
    const { hubScore = 0, framework } = graph.graphData.nodeMetadata?.[node.path] ?? {};
    const unit = unitOf(node.relativePath);
    return [node.relativePath, { hubScore, ...(framework === undefined ? {} : { framework }), communityId: ids.get(unit), communityKey: unit }];
  }));
  // Workspace-relative ids: the page may be committed, it holds no absolute path.
  const edges = graph.edges.flatMap((edge) => {
    const source = relative.get(edge.source);
    const target = relative.get(edge.target);
    return source === undefined || target === undefined ? [] : [{ source, target }];
  });

  const unitKind = new Map(units.unitEdges.map((edge) => [`${edge.from}\0${edge.to}`, edge.kind]));
  const violating = new Set(violations.map(({ source, target }) => `${source}\0${target}`));
  const edgeKinds = edges.flatMap(({ source, target }): [string, string, HtmlEdgeKind][] => {
    const kind = violating.has(`${source}\0${target}`) ? "violation" : unitKind.get(`${unitOf(source)}\0${unitOf(target)}`);
    return kind === undefined || kind === "down" ? [] : [[source, target, kind]];
  });

  return {
    graphData: { nodes: [...files], edges, nodeMetadata },
    context: {
      scope: result.focus === undefined ? "workspace" : `${result.focus} and its direct neighbours`,
      revision: graph.context.revision,
      communityMode: "architecture units",
      failedFiles: graph.context.failedFiles,
    },
    workspaceName: workspaceName(workspaceRoot),
    overlay: {
      edgeKinds,
      deadFiles: result.assessment.deadFiles.flatMap((group) => group.files.map((file) => file.relativePath)).filter((file) => files.has(file)),
      findings: reportSections(result.assessment).map((section) => ({
        ...section,
        items: section.items.map((item) => ({ ...item, files: namedFiles([item.subject, ...item.details], files) })),
      })),
      ...(result.focus === undefined || focus === undefined ? {} : { focus: { label: result.focus, files: [...focus.files].filter((file) => files.has(file)) } }),
    },
  };
}
