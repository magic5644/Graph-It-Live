/**
 * ArchitectureGraph — the sidebar's Architecture view mode: collapsed groups and the
 * group edges between them, rendered with Cytoscape: ELK layered (in a worker) for units and
 * their groups, fcose for Louvain groups. A group expands into its files, and any edge lists
 * the file pairs behind it.
 *
 * Mounted only in architecture mode. On mount it posts `architectureMounted`, and the
 * extension answers with the cached summary or a build, so no message can arrive early.
 */

import cytoscape from "cytoscape";
import type { ElkNode } from "elkjs/lib/elk-api";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MatrixCell, MatrixRow } from "../../../analyzer/architecture/architectureMatrix";
import type { ArchitectureRuleSummary } from "../../../analyzer/architecture/architectureRules";
import type { UnitRole } from "../../../analyzer/architecture/unitRoles";
import {
  MAX_RENDERED_GROUPS,
  type ArchitectureControlsMessage,
  type ArchitectureEvidencePageMessage,
  type ArchitectureExtensionMessage,
  type ArchitectureFolderLevelMessage,
  type ArchitectureFoundMessage,
  type ArchitectureGroupDetailMessage,
  type ArchitectureMatrixMessage,
  type ArchitectureRulesView,
  type ArchitectureStateMessage,
  type ArchitectureSummaryMessage,
  type ArchitectureWebviewCommand,
} from "../../../shared/architecture-types";
import { buildArchitectureStylesheet } from "../cytoscape/CytoscapeTheme";
import {
  applyMinImports,
  applyRoleFilter,
  ARCHITECTURE_FCOSE_LAYOUT,
  bandLabel,
  describeNode,
  type Direction,
  type Expansions,
  FILE_CAP_MESSAGE,
  findGroups,
  fitReadable,
  hiddenUnitEdgeCount,
  focusGroup,
  highlightFocus,
  type LayerBand,
  layerBands,
  type LayoutBox,
  levelSummary,
  markNodes,
  maxEdgeImports,
  plural,
  measureInteraction,
  measureIsolated,
  measureUnitLevel,
  mergeGroupDetail,
  nearestNode,
  countRendered,
  linkedElements,
  packIsolatedGroups,
  placeNewFiles,
  roleBadge,
  separateOverlaps,
  toLevelElements,
  unitColor,
} from "./architectureElements";
import { ArchitectureMatrix, type MatrixPaint } from "./ArchitectureMatrix";
import { applyElkLayout, applyRoutes, type EdgeRoute, toElkGraph } from "./elkLayout";
import { createElk, type ElkRunner } from "./elkWorker";
import { parseColor, type Rgba, themeKindOf } from "./unitColors";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fcose = require("cytoscape-fcose") as cytoscape.Ext;

cytoscape.use(fcose);

/**
 * Last position and size per group key, kept for the webview's lifetime (remounts
 * included), so Refresh or a communityMode round trip redraws the same picture.
 */
const savedLayout = new Map<string, LayoutBox>();
/** Position per file node of the rendered revision, so a page or a collapse leaves the other files in place. */
const filePositions = new Map<string, cytoscape.Position>();
const NO_EXPANSION: Expansions = new Map();
/** ELK route per edge key: drawn again while both ends are where ELK put them. */
const savedRoutes = new Map<string, EdgeRoute>();

const BODY_BOX = { includeLabels: false, includeOverlays: false };
const LABEL_BOX = { includeNodes: false, includeEdges: false, includeOverlays: false };

/** E2E observability: overlapping group pairs, labels drawn outside their node, and the positions. */
function measureLayout(nodes: cytoscape.NodeCollection) {
  const bodies = nodes.map((node) => node.boundingBox(BODY_BOX));
  let overlappingGroups = 0;
  for (const [i, a] of bodies.entries()) {
    overlappingGroups += bodies.slice(i + 1).filter((b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2).length;
  }
  const overflowingLabels = nodes.filter((node, i) => {
    const label = node.boundingBox(LABEL_BOX);
    const body = bodies[i];
    return label.x1 < body.x1 || label.x2 > body.x2 || label.y1 < body.y1 || label.y2 > body.y2;
  }).length;
  const positions = nodes
    .map((node) => `${node.data("key")}@${Math.round(node.position("x"))},${Math.round(node.position("y"))}`)
    .sort((a, b) => a.localeCompare(b))
    .join(";");
  return { overlappingGroups, overflowingLabels, positions };
}

/** Group and unit nodes: neither a file, a "+N more" node nor a cycle block. */
const groupNodes = (cy: cytoscape.Core) => cy.nodes().filter((node) => !node.data("file") && !node.data("more") && !node.data("cycle"));

/** The colour behind the canvas: the first opaque background up from it, else the editor's. */
function canvasBackground(element: HTMLElement | null): Rgba | undefined {
  for (let current = element; current; current = current.parentElement) {
    const color = parseColor(getComputedStyle(current).backgroundColor);
    if (color && color.a > 0) return color;
  }
  return parseColor(cssVar("--vscode-editor-background", "#1e1e1e"));
}

/** What sits above the canvas, and the legend overlay, as laid out (E2E observability). */
export interface ViewChrome {
  headerHeightPx: number;
  viewHeightPx: number;
  legendOverflowing: boolean;
  legendScrolls: boolean;
}

/** What a render drew (E2E observability); the units level adds its own measures. */
function renderedReport(
  cy: cytoscape.Core,
  summary: ArchitectureSummaryMessage,
  drawn: ArchitectureSummaryMessage,
  unit: string | null,
  folder: string | undefined,
  chrome?: ViewChrome,
): ArchitectureWebviewCommand {
  const unitsLevel = summary.units !== undefined && unit === null;
  const groups = groupNodes(cy);
  return {
    command: "architectureRendered",
    revision: summary.revision,
    renderedGroups: groups.length,
    renderedGroupEdges: cy.edges().length,
    communityMode: summary.context.communityMode,
    stale: summary.stale,
    ...measureLayout(groups),
    unit: unit ?? undefined,
    folder,
    ...chrome,
    zoom: Math.round(cy.zoom() * 1000) / 1000,
    unitLevel: unitsLevel ? measureUnitLevel(cy, canvasBackground(cy.container())) : undefined,
    groupLevel: unitsLevel ? undefined : {
      shownGroups: drawn.groups.length,
      totalGroups: drawn.totalGroups,
      hiddenGroups: drawn.hiddenGroups,
      hiddenGroupEdges: drawn.hiddenGroupEdges,
      isolatedGroups: drawn.isolatedGroups?.length ?? 0,
      ...measureIsolated(cy),
    },
    violationEdges: cy.edges().filter((edge) => edge.data("violation") === true && edge.style("display") !== "none").length,
    // The Rules panel as the DOM shows it: `name=count` per rule.
    rules: Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Architecture rules"] button[data-rule]'),
      (button) => `${button.dataset.rule}=${button.dataset.count}`),
    // The role legend as the DOM shows it: `role=count`, `*` after the filtered role.
    roles: Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Unit roles"] button[data-role]'),
      (button) => `${button.dataset.role}=${button.dataset.count}${button.getAttribute("aria-pressed") === "true" ? "*" : ""}`),
  };
}

/** The canvas's live region: what a screen reader announces about the selection. */
const LIVE_REGION = "architecture-announcement";

/**
 * Highlights `focus` and reports what is drawn (E2E observability).
 * ponytail: every hover reads the computed style of all edges; fine for ≤ 150 groups, gate the report behind an E2E flag if hovering lags.
 */
function showFocus(cy: cytoscape.Core, focus: cytoscape.Collection, post: (message: ArchitectureWebviewCommand) => void): void {
  highlightFocus(cy, focus);
  post({
    command: "architectureInteracted",
    ...measureInteraction(cy),
    announcement: document.getElementById(LIVE_REGION)?.textContent ?? "",
    canvasFocused: cy.container() !== null && document.activeElement === cy.container(),
    zoom: Math.round(cy.zoom() * 1000) / 1000,
  });
}

/**
 * Draws a band behind each layer's row, across the whole view, labelled on the left: the bands
 * are model coordinates, placed again on every pan and zoom.
 */
function drawBands(layer: HTMLElement | null, cy: cytoscape.Core, bands: readonly LayerBand[]): void {
  if (!layer) return;
  const zoom = cy.zoom();
  const { y } = cy.pan();
  // A pan or zoom only moves the rows: they are built once per layout.
  const built = layer.children.length === bands.length && bands.every((band, index) => (layer.children[index] as HTMLElement).dataset.layer === String(band.layer));
  if (!built) {
    layer.replaceChildren(...bands.map((band, index) => {
      const row = document.createElement("div");
      row.dataset.layer = String(band.layer);
      row.style.cssText = "position:absolute;left:0;right:0;border-top:1px dashed var(--vscode-widget-border, transparent);"
        + (index % 2 === 0 ? "background:color-mix(in srgb, var(--vscode-foreground) 6%, transparent);" : "");
      const label = document.createElement("span");
      label.textContent = bandLabel(band.layer);
      label.style.cssText = "position:absolute;right:8px;top:2px;font-size:11px;color:var(--vscode-descriptionForeground);";
      row.append(label);
      return row;
    }));
  }
  bands.forEach((band, index) => {
    const row = layer.children[index] as HTMLElement;
    row.style.top = `${band.y1 * zoom + y}px`;
    row.style.height = `${(band.y2 - band.y1) * zoom}px`;
  });
}

/** A file or "+N more" node of an expanded group (a unit inside a cycle block is a child too). */
const inGroup = (node: cytoscape.NodeSingular) => node.isChild() && !node.parent().data("cycle");

/**
 * Pushes overlapping groups (collapsed or expanded) apart, then remembers every position.
 * An expanded group moves with its files; its collapsed position stays the one to return to.
 */
function settleLayout(cy: cytoscape.Core, groups: cytoscape.NodeSingular[]): void {
  const boxes = groups.map((node) => ({ node, ...node.position(), width: node.outerWidth(), height: node.outerHeight() }));
  separateOverlaps(boxes);
  for (const { node, x, y } of boxes) {
    if (node.isParent()) {
      node.children().shift({ x: x - node.position("x"), y: y - node.position("y") });
    } else {
      node.position({ x, y });
    }
  }
  cy.nodes().forEach((node) => {
    // A cycle block's units are kept like any unit; a group's files per revision.
    if (inGroup(node)) filePositions.set(node.id(), { ...node.position() });
    else if (!node.isParent()) savedLayout.set(node.data("key"), { ...node.position(), width: node.data("width"), height: node.data("height") });
  });
  applyRoutes(cy, cy.edges(), savedRoutes);
}

/**
 * Lays the level out with ELK in its worker, the canvas hidden meanwhile, then finishes unless
 * `current()` turned false (a later render or an unmount drops the result). A failed layout
 * still finishes: settleLayout spreads the nodes.
 */
function layoutWithElk(cy: cytoscape.Core, elk: Pick<ElkRunner, "layout">, current: () => boolean, finish: () => void): void {
  const container = cy.container();
  container?.style.setProperty("visibility", "hidden");
  const settle = (layout?: ElkNode) => {
    if (!current()) return;
    container?.style.removeProperty("visibility");
    if (layout) for (const [key, route] of applyElkLayout(cy, layout)) savedRoutes.set(key, route);
    finish();
  };
  elk.layout(toElkGraph(cy)).then(settle, (error: unknown) => {
    console.error("[Graph-It-Live] ELK layout failed", error);
    settle();
  });
}

/**
 * Puts every group and file back where it was drawn; false (nothing moved) when a group is new
 * or resized, which needs a full layout.
 */
function restorePositions(cy: cytoscape.Core, groups: cytoscape.NodeSingular[]): boolean {
  const known = groups.every((node) => {
    const saved = savedLayout.get(node.data("key"));
    return saved?.width === node.data("width") && saved.height === node.data("height");
  });
  if (!known) return false;
  cy.nodes().forEach((node) => {
    const saved = inGroup(node) ? filePositions.get(node.id()) : savedLayout.get(node.data("key"));
    if (saved && !node.isParent()) node.position({ x: saved.x, y: saved.y });
  });
  return true;
}

/** The ends an evidence request names: group ids (a file restricts one end), or unit keys for a unit edge. */
interface EvidenceEnds {
  from: number | string;
  to: number | string;
  sourceFile?: string;
  targetFile?: string;
  /** A declared rule's violations instead of an edge (from and to empty). */
  rule?: string;
}

interface EvidenceState {
  ends: EvidenceEnds;
  title: string;
  /** The selected edge's count. */
  edgeCount: number;
  pairs: ArchitectureEvidencePageMessage["pairs"];
  total?: number;
  nextOffset?: number;
}

/** What a render fits: the focus, an entered group, everything, or the level's last viewport. */
type Fit = "focus" | "enter" | "all" | "restore";

/** Key of a level: the units (null), a unit's top folders, or one of its folders. */
const levelKey = (unit: string | null, folder: string | undefined) => `${unit ?? ""}>${folder ?? ""}`;

/** The drawn level as a graph or as its dependency structure matrix. */
type View = "graph" | "matrix";

/** Key of a level's matrix: its revision (a folder's covers the folder), the entered unit and folder. */
const matrixKey = (revision: string, unit: string | null | undefined, folder: string | undefined) => `${revision}|${unit ?? ""}|${folder ?? ""}`;

const sameEnds = (left: EvidenceEnds, right: EvidenceEnds) =>
  left.from === right.from && left.to === right.to && left.sourceFile === right.sourceFile && left.targetFile === right.targetFile
  && left.rule === right.rule;

interface ArchitectureGraphProps {
  postMessage: (message: ArchitectureWebviewCommand) => void;
}

const MODE_WORDING = {
  path: "Groups based on folders",
  louvain: "Groups based on imports (Louvain)",
} as const;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

function themeColors() {
  // Find match backgrounds carry their own alpha (#rrggbbaa), which Cytoscape colours do not take.
  const findMatch = parseColor(cssVar("--vscode-editor-findMatchHighlightBackground", "#ea5c0055")) ?? { r: 234, g: 92, b: 0, a: 0.33 };
  return {
    foreground: cssVar("--vscode-foreground", "#cccccc"),
    background: cssVar("--vscode-editorWidget-background", "#252526"),
    border: cssVar("--vscode-descriptionForeground", "#999999"),
    edge: cssVar("--vscode-editorLineNumber-foreground", "#858585"),
    accent: cssVar("--vscode-focusBorder", "#007fd4"),
    error: cssVar("--vscode-errorForeground", "#f14c4c"),
    findMatch: `rgb(${findMatch.r}, ${findMatch.g}, ${findMatch.b})`,
    findMatchOpacity: Math.max(0.35, findMatch.a),
    contrastBorder: cssVar("--vscode-contrastBorder", "#6fc3df"),
  };
}

const bannerStyle: React.CSSProperties = {
  background: "var(--vscode-inputValidation-warningBackground)",
  border: "1px solid var(--vscode-inputValidation-warningBorder)",
  padding: "4px 8px",
  margin: "4px 0",
};

const ROLE_PLURALS: Partial<Record<UnitRole, string>> = { library: "libraries", tooling: "tooling", unknown: "unknown" };
const roleCount = (role: UnitRole, count: number) => (count === 1 ? `1 ${role}` : `${count} ${ROLE_PLURALS[role] ?? role + "s"}`);

/** Units per role, each a filter: a click keeps only its units drawn, a second click shows them all. */
function RoleLegend({ roleCounts, roleFilter, onRole }: Readonly<{
  roleCounts: Partial<Record<UnitRole, number>>;
  roleFilter: string | null;
  onRole: (role: string) => void;
}>) {
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", alignItems: "baseline" }}
      title="[role?] inferred from manifests and files (hover a unit for its evidence), [role] declared in graphit.architecture.json"
    >
      <ul aria-label="Unit roles" style={{ display: "contents" }}>
        {Object.entries(roleCounts).map(([role, count]) => (
          <li key={role} style={{ listStyle: "none" }}>
            <button
              type="button" data-role={role} data-count={count} aria-pressed={roleFilter === role} onClick={() => onRole(role)}
              title={roleFilter === role ? "Show every unit" : `Show only the ${role} units`}
              style={{ fontWeight: roleFilter === role ? 600 : undefined }}
            >
              {roleCount(role as UnitRole, count ?? 0)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface UnitsSummaryProps {
  summary: ArchitectureSummaryMessage;
  minImports: number;
  onCycle: () => void;
}

const RED = "var(--vscode-errorForeground)";
const linkStyle: React.CSSProperties = {
  padding: 0, border: "none", background: "none", font: "inherit", color: "var(--vscode-textLink-foreground)", cursor: "pointer",
};

/** Units level, on the title's line: units, layers, upward edges, cycles (a click shows the first) and hidden edges. */
function UnitsSummary({ summary, minImports, onCycle }: Readonly<UnitsSummaryProps>) {
  const level = summary.units;
  if (!level) return null;
  const hidden = hiddenUnitEdgeCount(level, minImports, summary.rules);
  const layers = new Set(level.units.map((unit) => unit.layer)).size;
  return (
    <span>
      <span title="Packages (folders holding a package.json), else top-level folders">{plural(level.units.length, "unit")}</span>
        {" · "}{plural(layers, "layer")}{" · "}
        <span style={{ color: level.upwardEdges > 0 ? RED : undefined }} title="Unit edges to a unit on the same or a higher layer">{level.upwardEdges} upward</span>
        {" · "}
        {level.cycles > 0
          ? <button type="button" data-cycle-count onClick={onCycle} style={{ ...linkStyle, color: RED }} title="Show the cycle block">{plural(level.cycles, "cycle")}</button>
          : plural(level.cycles, "cycle")}
      {hidden > 0 && <span title="Set Min. imports per edge to show the edges by weight"> · {hidden} weaker {hidden === 1 ? "edge" : "edges"} hidden</span>}
    </span>
  );
}

/** The units' colours and roles, over the canvas: collapsible, scrolling past 40% of its height; a click selects the unit. */
function UnitLegend({ summary, onUnit, legendRef }: Readonly<{
  summary: ArchitectureSummaryMessage;
  onUnit: (key: string) => void;
  legendRef: React.RefObject<HTMLDetailsElement | null>;
}>) {
  const units = summary.units?.units ?? [];
  return (
    <details
      ref={legendRef} open
      style={{
        position: "absolute", top: 4, left: 4, maxWidth: "40%", maxHeight: "40%", overflow: "auto", zIndex: 1, padding: "2px 6px",
        fontSize: 12, background: "var(--vscode-editorWidget-background)", border: "1px solid var(--vscode-widget-border)",
      }}
    >
      <summary style={{ cursor: "pointer" }}>Legend ({plural(units.length, "unit")})</summary>
      <ul aria-label="Units" style={{ listStyle: "none", padding: 0, margin: "2px 0" }}>
        {units.map((unit, index) => (
          <li key={unit.key}>
            <button
              type="button" data-unit={unit.key} onClick={() => onUnit(unit.key)} style={{ ...linkStyle, color: "inherit", textAlign: "left" }}
              title={`${unit.key} · layer ${unit.layer} · ${unit.role} (${unit.confidence}): select it`}
            >
              <span aria-hidden="true" style={{ display: "inline-block", width: 9, height: 9, marginRight: 4, background: unitColor(index) }} />
              {unit.name} {roleBadge(unit)}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Fit (0), zoom in (+) and out (-), over the canvas's bottom-right corner. */
function ZoomControls({ onZoom }: Readonly<{ onZoom: (action: ZoomAction) => void }>) {
  const control = (action: ZoomAction, text: string, label: string) => (
    <button type="button" data-zoom={action} aria-label={label} title={label} onClick={() => onZoom(action)} style={{ minWidth: 26 }}>{text}</button>
  );
  return (
    <fieldset aria-label="Zoom controls" style={{ position: "absolute", right: 8, bottom: 8, zIndex: 1, display: "flex", gap: 2, margin: 0, padding: 0, border: "none" }}>
      {control("fit", "Fit", "Fit the graph (0)")}
      {control("in", "+", "Zoom in (+)")}
      {control("out", "−", "Zoom out (-)")}
    </fieldset>
  );
}

/** Over the canvas: the zoom controls, the units legend, and why a level without edges draws no line. */
function CanvasOverlays({ summary, drawn, unitsLevel, view, legendRef, onZoom, onUnit }: Readonly<{
  summary: ArchitectureSummaryMessage;
  drawn: ArchitectureSummaryMessage;
  unitsLevel: boolean;
  view: View;
  legendRef: React.RefObject<HTMLDetailsElement | null>;
  onZoom: (action: ZoomAction) => void;
  onUnit: (key: string) => void;
}>) {
  // Without any edge, a level of several nodes would read as a failure: say why the canvas holds no line.
  const noEdges = view === "graph" && drawn.groups.length > 1 && drawn.groupEdges.length === 0;
  return (
    <>
      <ZoomControls onZoom={onZoom} />
      {unitsLevel && <UnitLegend summary={summary} legendRef={legendRef} onUnit={onUnit} />}
      {noEdges && (
        <output style={{ position: "absolute", left: 0, right: 0, bottom: 40, textAlign: "center", fontSize: 12, pointerEvents: "none", color: "var(--vscode-descriptionForeground)" }}>
          No imports between these {unitsLevel ? "units" : "groups"}.
        </output>
      )}
    </>
  );
}

type ZoomAction = "fit" | "in" | "out";
const ZOOM_KEYS: Record<string, ZoomAction> = { "0": "fit", "+": "in", "=": "in", "-": "out" };
const ZOOM_STEP = 1.25;

const SEVERITY_COLOR = { error: "var(--vscode-errorForeground)", warning: "var(--vscode-editorWarning-foreground)", off: undefined } as const;

/**
 * The declared rules (graphit.architecture.json): "N violations of M rules (K new)", then each
 * rule with its count; a rule with violations opens its file pairs in the evidence panel.
 */
function RulesPanel({ rules, onRule }: Readonly<{ rules: ArchitectureRulesView; onRule: (rule: ArchitectureRuleSummary) => void }>) {
  if (rules.error) {
    return <output style={{ ...bannerStyle, display: "block", color: "var(--vscode-errorForeground)" }}>Architecture rules not checked: {rules.error}</output>;
  }
  const totals = rules.totals!;
  const failing = totals.errors > 0;
  return (
    <details open={totals.violations > 0}>
      <summary style={{ cursor: "pointer", color: failing ? "var(--vscode-errorForeground)" : undefined }}>
        {plural(totals.violations, "violation")} of {plural(totals.brokenRules, "rule")} ({totals.newViolations} new) · {rules.configFile}
        {totals.unmatchedFiles > 0 && <span title="Files no element of the config selects: no rule checks them."> · {plural(totals.unmatchedFiles, "file")} in no element</span>}
      </summary>
      <ul aria-label="Architecture rules" style={{ listStyle: "none", padding: 0, margin: "2px 0", maxHeight: 96, overflow: "auto" }}>
        {rules.rules.map((rule) => (
          <li key={rule.name} style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <button
              type="button" data-rule={rule.name} data-count={rule.violations}
              disabled={rule.violations === 0} title={rule.reason ?? rule.name} onClick={() => onRule(rule)}
              style={{
                padding: 0, border: "none", background: "none", font: "inherit", textDecoration: rule.violations > 0 ? "underline" : undefined,
                cursor: rule.violations > 0 ? "pointer" : undefined, color: rule.violations > 0 ? SEVERITY_COLOR[rule.severity] : "inherit",
              }}
            >
              {rule.name}
            </button>
            <span style={{ color: "var(--vscode-descriptionForeground)" }}>
              {rule.kind} · {rule.severity} · {plural(rule.violations, "violation")}{rule.newViolations < rule.violations ? ` (${rule.newViolations} new)` : ""}
            </span>
          </li>
        ))}
      </ul>
      {rules.configWarnings.map((warning) => <div key={warning} style={{ color: "var(--vscode-editorWarning-foreground)" }}>{warning}</div>)}
    </details>
  );
}

interface SummaryHeaderProps {
  summary: ArchitectureSummaryMessage;
  /** The drawn level, shaped as a summary: its groups line. */
  level: ArchitectureSummaryMessage;
  onShowMore: () => void;
  /** Entered unit; null at the units level. */
  unit: string | null;
  minImports: number;
  onRefresh: () => void;
  onRule: (rule: ArchitectureRuleSummary) => void;
  roleFilter: string | null;
  onRole: (role: string) => void;
  onCycle: () => void;
}

/** Show more groups is offered while the cap is below MAX_RENDERED_GROUPS. */
const canShowMore = (summary: ArchitectureSummaryMessage) => (summary.maxGroups ?? MAX_RENDERED_GROUPS) < MAX_RENDERED_GROUPS;

/** Counts and provenance, behind a Details disclosure: the summary line stays one line. */
function SummaryDetails({ summary, isolated }: Readonly<{ summary: ArchitectureSummaryMessage; isolated: number }>) {
  const { context, totals } = summary;
  return (
    <details style={{ flexBasis: "auto" }}>
      <summary style={{ cursor: "pointer", color: "var(--vscode-descriptionForeground)" }}>
        Details: {plural(totals.files, "file")}, {plural(totals.fileEdges, "file pair")}
        {context.failedFiles > 0 && <span style={{ color: RED }}> · {context.failedFiles} failed</span>}
      </summary>
      <div>
        {plural(totals.fileEdges, "file pair")} (static imports): {totals.intraGroupEdges} within groups, {totals.interGroupEdges} between groups
      </div>
      <div style={{ color: "var(--vscode-descriptionForeground)" }}>
        {summary.scannedFiles} scanned · {summary.analyzedFiles} analysed
        {context.failedFiles > 0 && (
          <span title="Files that could not be read or parsed; they count as files without imports.">
            {" "}· {context.failedFiles} failed
          </span>
        )}
      </div>
      {isolated > 0 && <div>{plural(isolated, "group")} without cross-group imports, drawn apart below the others.</div>}
      <div style={{ color: "var(--vscode-descriptionForeground)" }}>{summary.provenance.facts}</div>
    </details>
  );
}

function SummaryHeader({ summary, level, onShowMore, unit, minImports, onRefresh, onRule, roleFilter, onRole, onCycle }: Readonly<SummaryHeaderProps>) {
  const { context } = summary;
  const isolated = level.isolatedGroups?.length ?? 0;
  const unitsLevel = summary.units !== undefined && unit === null;
  return (
    <div style={{ padding: "4px 10px", fontSize: 12, borderBottom: "1px solid var(--vscode-widget-border)" }}>
      {summary.stale && (
        <output style={{ ...bannerStyle, display: "block" }}>
          Files or architecture rules changed since this view was built.{" "}
          <button type="button" onClick={onRefresh}>Refresh</button>
        </output>
      )}
      <div>
        <span style={{ fontWeight: 600 }} title={unitsLevel ? "Dependents above, dependencies below" : undefined}>
          {unitsLevel ? "Units in layers" : MODE_WORDING[context.communityMode]}
        </span>
        {unitsLevel && <>{" · "}<UnitsSummary summary={summary} minImports={minImports} onCycle={onCycle} /></>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline" }}>
        {unitsLevel && summary.units && <RoleLegend roleCounts={summary.units.roleCounts} roleFilter={roleFilter} onRole={onRole} />}
        <SummaryDetails summary={summary} isolated={isolated} />
      </div>
      {summary.rules && <RulesPanel rules={summary.rules} onRule={onRule} />}
      {context.truncated && (
        <div style={bannerStyle}>Only the first {context.maxFiles} files were analysed (maxFiles).</div>
      )}
      {level.hiddenGroups > 0 && (
        <div>
          {level.groups.length} of {level.totalGroups} groups shown (largest first)
          {level.hiddenGroupEdges > 0 && `; ${plural(level.hiddenGroupEdges, "group edge")} hidden`}. Totals include them.{" "}
          {canShowMore(summary) && <button type="button" data-show-more onClick={onShowMore}>Show more groups</button>}
        </div>
      )}
    </div>
  );
}

interface GraphControlsProps {
  summary: ArchitectureSummaryMessage;
  /** Group edges left by the min-imports filter, counted on the canvas. */
  shownEdges: number;
  query: string;
  onQuery: (query: string) => void;
  minImports: number;
  onMinImports: (minImports: number) => void;
  capReached: boolean;
  view: View;
  onView: (view: View) => void;
  /** Groups the find matches where it searched: the canvas, or the matrix rows. */
  findMatches: number;
  /** The extension's answer about the hidden groups, for this query and level. */
  found: ArchitectureFoundMessage | null;
  onShowMore: () => void;
  canShowMore: boolean;
  /** The units level, whose header already counts the edges the cap hides. */
  unitsLevel: boolean;
}

/**
 * The find's result line: hidden groups it matches (never reported as no group), else no match.
 * The matrix holds every group of its level: nothing is hidden there.
 */
function FindStatus({ query, view, summary, findMatches, found, onShowMore, canShowMore }: Readonly<Pick<GraphControlsProps,
  "query" | "view" | "summary" | "findMatches" | "found" | "onShowMore" | "canShowMore">>) {
  const needle = query.trim();
  const searchesHidden = view === "graph" && summary.hiddenGroups > 0;
  let status: React.ReactNode = null;
  if (searchesHidden && found && found.total > 0) {
    status = <HiddenMatches needle={needle} findMatches={findMatches} found={found} onShowMore={onShowMore} canShowMore={canShowMore} />;
  } else if (searchesHidden && !found) {
    if (findMatches === 0) status = "Searching the hidden groups…";
  } else if (findMatches === 0) status = `No group matches "${needle}".`;
  return needle && status ? <output aria-label="Find result" style={{ display: "block" }}>{status}</output> : null;
}

/** "`x` is also in N hidden groups (…)", then Show more groups while the cap allows it. */
function HiddenMatches({ needle, findMatches, found, onShowMore, canShowMore }: Readonly<{
  needle: string; findMatches: number; found: ArchitectureFoundMessage; onShowMore: () => void; canShowMore: boolean;
}>) {
  const more = found.total > found.matches.length ? `, +${found.total - found.matches.length} more` : "";
  return (
    <>
      {findMatches > 0 && `${plural(findMatches, "group")} drawn; `}"{needle}" is also in {plural(found.total, "hidden group")} ({found.matches.join(", ")}{more}).{" "}
      {canShowMore ? <button type="button" onClick={onShowMore}>Show more groups</button> : `Only the ${MAX_RENDERED_GROUPS} largest groups are drawn.`}
    </>
  );
}

/** Graph | Matrix toggle, then find and weak-edge filter: they only change what is drawn, never the counts above. */
function GraphControls(props: Readonly<GraphControlsProps>) {
  const { summary, shownEdges, query, onQuery, minImports, onMinImports, capReached, view, onView, unitsLevel } = props;
  const counts = summary.groupEdges.map((edge) => edge.fileEdgeCount);
  const toggle = (name: View, label: string) => (
    <button type="button" aria-pressed={view === name} onClick={() => onView(name)} style={{ fontWeight: view === name ? 600 : undefined }}>{label}</button>
  );
  return (
    <div style={{ padding: "4px 10px", fontSize: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span>{toggle("graph", "Graph")}{toggle("matrix", "Matrix")}</span>
        <input
          type="search"
          aria-label="Find group"
          placeholder="Find group"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        {view === "graph" && (
        <label>
          Min. imports per edge{" "}
          <input
            type="number"
            min={1}
            max={maxEdgeImports(summary)}
            value={minImports}
            onChange={(event) => onMinImports(Math.max(1, Math.floor(Number(event.target.value)) || 1))}
            style={{ width: 56 }}
          />
        </label>
        )}
      </div>
      {view === "graph" && shownEdges < counts.length && !(unitsLevel && minImports === 1) && (
        <div>
          {shownEdges} of {counts.length} group edges shown (min. {minImports} imports). Totals include them.
        </div>
      )}
      <FindStatus {...props} />
      {capReached && <output style={{ ...bannerStyle, display: "block" }}>{FILE_CAP_MESSAGE}</output>}
    </div>
  );
}

interface EvidencePanelProps {
  evidence: EvidenceState;
  /** The drawn level (changing it closes the panel): paths are shown below it. */
  unit: string | null;
  folder: string | undefined;
  onOpen: (relativePath: string) => void;
  onMore: () => void;
  onClose: () => void;
}

/**
 * `relativePath` below a unit (its key is its folder), or below `folder`, a `<unit>/<sub-folders>`
 * key whose umbrella dirs (src, lib…) are skipped; else the whole workspace-relative path.
 */
export function shortPath(relativePath: string, unit: string, folder?: string): string {
  if (folder === undefined || folder === unit) return relativePath.startsWith(`${unit}/`) ? relativePath.slice(unit.length + 1) : relativePath;
  // A folder level only holds files below the folder: its sub-folders follow the path's last umbrella dir.
  // ponytail: last match of them; a path repeating them (a/a/x.ts) is cut too far, the title keeps it whole.
  const chain = `/${folder.slice(unit.length + 1)}/`;
  const at = `/${relativePath}`.lastIndexOf(chain);
  return at === -1 ? relativePath : relativePath.slice(at + chain.length - 1);
}

/** Consecutive pairs with one target share its heading: unit pages come sorted by target. */
function byTarget(pairs: EvidenceState["pairs"]): { target: string; sources: string[] }[] {
  const groups: { target: string; sources: string[] }[] = [];
  for (const { source, target } of pairs) {
    const last = groups.at(-1);
    if (last?.target === target) last.sources.push(source);
    else groups.push({ target, sources: [source] });
  }
  return groups;
}

// Link-like buttons on one line each, cut at the start so the file name stays visible.
const EVIDENCE_CSS = `
.evidence-path { display: block; min-width: 0; max-width: 100%; padding: 0; border: none; background: none; font: inherit;
  font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); cursor: pointer;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }
.evidence-path:hover, .evidence-path:focus-visible { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.evidence-path:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }`;

/** The file pairs behind the selected edge, grouped by target; every path is a button that opens the file. */
function EvidencePanel({ evidence, unit, folder, onOpen, onMore, onClose }: Readonly<EvidencePanelProps>) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Keyboard users land in the panel when it opens for a new edge.
  useEffect(() => closeRef.current?.focus(), [evidence.ends]);
  // A unit edge's end is a unit key; any other edge's paths lie below the drawn unit or folder.
  const short = (relativePath: string, end: number | string) => {
    if (typeof end === "string") return shortPath(relativePath, end);
    return unit === null ? relativePath : shortPath(relativePath, unit, folder);
  };
  // dir="ltr" keeps the path's own order inside the right-to-left box that cuts its start.
  const pathButton = (relativePath: string, end: number | string) => (
    <button
      type="button" className="evidence-path" title={relativePath} aria-label={relativePath}
      onClick={() => onOpen(relativePath)}
    >
      <span dir="ltr">{short(relativePath, end)}</span>
    </button>
  );
  const listStyle = { listStyle: "none", padding: 0, margin: 0 } as const;
  return (
    <section
      aria-label="Evidence"
      style={{
        position: "absolute", top: 0, right: 0, width: "45%", maxHeight: "100%", overflow: "auto", padding: "6px 10px",
        fontSize: 12, background: "var(--vscode-editorWidget-background)", border: "1px solid var(--vscode-widget-border)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <strong style={{ flex: 1 }}>{evidence.title}</strong>
        <button type="button" ref={closeRef} aria-label="Close evidence" onClick={onClose}>×</button>
      </div>
      {evidence.total !== undefined && <div>showing {evidence.pairs.length} of {evidence.total}</div>}
      <style>{EVIDENCE_CSS}</style>
      <ul style={{ ...listStyle, margin: "4px 0" }}>
        {byTarget(evidence.pairs).map(({ target, sources }) => (
          <li key={`${sources[0]}>${target}`} style={{ marginTop: 4 }}>
            {pathButton(target, evidence.ends.to)}
            <ul aria-label={`Imported by (${target})`} style={{ ...listStyle, paddingLeft: 12 }}>
              {sources.map((source) => (
                <li key={source} style={{ display: "flex", gap: 4 }}>
                  <span aria-hidden="true">← </span>
                  {pathButton(source, evidence.ends.from)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {evidence.nextOffset !== undefined && <button type="button" onClick={onMore}>Load more</button>}
    </section>
  );
}

interface BreadcrumbProps {
  summary: ArchitectureSummaryMessage;
  /** Entered unit; null at the units level or without units. */
  unit: string | null;
  /** Entered folders within the unit, outermost first. */
  folders: readonly string[];
  onUnits: () => void;
  /** Back to the unit's top level (0) or to its depth-th entered folder. */
  onLevel: (depth: number) => void;
  expansions: Expansions;
  focusId: number | null;
  /** The drawn level again, without focus or entered group. */
  onOverview: () => void;
  onClearFocus: () => void;
  onFocus: (groupId: number) => void;
  onLeave: (groupId: number) => void;
  view: View;
}

/** One step of the path: a link back to its level, or, the last one, where the view is. */
function Segment({ name, current, onClick }: Readonly<{ name: string; current: boolean; onClick: () => void }>) {
  return (
    <button
      type="button" aria-current={current ? "location" : undefined} onClick={onClick}
      style={{ ...linkStyle, color: current ? "inherit" : linkStyle.color, fontWeight: current ? 600 : undefined }}
    >
      {name}
    </button>
  );
}

/**
 * One path, `All units › <unit> › <folder>… › <group>`: every step returns to its level, with the
 * viewport it was left with; a focused or entered group ends it with × to leave it.
 */
function Breadcrumb(props: Readonly<BreadcrumbProps>) {
  const { summary, unit, folders, onUnits, onLevel, expansions, focusId, onOverview, onClearFocus, onFocus, onLeave, view } = props;
  const labelOf = (id: number) => (id === 0 ? "unassigned" : summary.groups.find((group) => group.id === id)?.label ?? `group ${id}`);
  const entered = [...expansions.keys()];
  const unitName = summary.units?.units.find((entry) => entry.key === unit)?.name ?? unit;
  // Keyed by level; the drawn level's own step clears its focus and entered groups.
  const levels: { key: string; name: string; go: () => void }[] = summary.units ? [{ key: "units", name: "All units", go: onUnits }] : [];
  if (!summary.units) levels.push({ key: "groups", name: "All groups", go: () => onLevel(0) });
  if (unitName !== null) levels.push({ key: "unit", name: unitName, go: () => onLevel(0) });
  folders.forEach((folder, depth) => levels.push({ key: folder, name: folder.slice(folder.lastIndexOf("/") + 1), go: () => onLevel(depth + 1) }));
  const focused = focusId !== null && !expansions.has(focusId);
  const last = !focused && entered.length === 0;
  return (
    <nav
      aria-label="Architecture path" style={{ padding: "4px 10px", fontSize: 12 }}
      title={view === "graph"
        ? "Click: select · Double-click or Enter: enter · Arrows: move · Escape: back · 0, +, -: zoom"
        : "Cell: evidence · Header: enter · Arrows: move · Escape: back"}
    >
      {levels.map(({ key, name, go }, index) => {
        const drawnLevel = index === levels.length - 1;
        return (
          <span key={key}>
            {index > 0 && " › "}
            <Segment name={name} current={drawnLevel && last} onClick={drawnLevel ? onOverview : go} />
          </span>
        );
      })}
      {focused && (
        <span>
          {" › "}<span aria-current="location" style={{ fontWeight: 600 }}>{labelOf(focusId)}</span>
          <button type="button" aria-label={`Clear focus on ${labelOf(focusId)}`} onClick={onClearFocus}>×</button>
        </span>
      )}
      {entered.map((id, index) => (
        <span key={id}>
          {" › "}
          <Segment name={labelOf(id)} current={index === entered.length - 1} onClick={() => onFocus(id)} />
          <button type="button" aria-label={`Leave ${labelOf(id)}`} onClick={() => onLeave(id)}>×</button>
        </span>
      ))}
    </nav>
  );
}

function StatePanel({ state, onRetry, onSettings }: Readonly<{ state: ArchitectureStateMessage; onRetry: () => void; onSettings: () => void }>) {
  return (
    <output style={{ display: "block", padding: 16, fontSize: 12 }}>
      {state.status === "building" && (
        <>
          <div>{state.message ?? "Building architecture…"}{state.percent === undefined ? "" : ` (${state.percent}%)`}</div>
          <progress max={100} value={state.percent} style={{ width: "100%" }} />
        </>
      )}
      {state.status === "empty" && (
        <>
          <div>{state.message ?? "No supported source file in the workspace folder."}</div>
          <button type="button" onClick={onSettings}>Open settings</button>
        </>
      )}
      {state.status === "error" && (
        <>
          <div style={{ color: "var(--vscode-errorForeground)" }}>Architecture build failed: {state.message}</div>
          <button type="button" onClick={onRetry}>Retry</button>
        </>
      )}
    </output>
  );
}

export function ArchitectureGraph({ postMessage }: Readonly<ArchitectureGraphProps>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The canvas area: everything above it is the header. */
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDetailsElement>(null);
  /** Behind the canvas: the layer bands, placed again on every pan and zoom. */
  const bandsLayerRef = useRef<HTMLDivElement>(null);
  const bandsRef = useRef<LayerBand[]>([]);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const elkRef = useRef<ElkRunner | null>(null);
  /** Bumped by every render: an ELK result for an older one is dropped. */
  const layoutRunRef = useRef(0);
  const postMessageRef = useRef(postMessage);
  postMessageRef.current = postMessage;
  const [summary, setSummary] = useState<ArchitectureSummaryMessage | null>(null);
  const [state, setState] = useState<ArchitectureStateMessage | null>({ type: "architectureState", status: "building" });
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  /** Groups the find matches on the canvas or in the matrix. */
  const [findMatches, setFindMatches] = useState(0);
  /** The extension's answer about the hidden groups of the drawn level, for the current query. */
  const [found, setFound] = useState<ArchitectureFoundMessage | null>(null);
  /** Bumped when a level already received comes again (Show more groups): it is drawn anew. */
  const [levelsVersion, setLevelsVersion] = useState(0);
  const [minImports, setMinImports] = useState(1);
  const minImportsRef = useRef(minImports);
  minImportsRef.current = minImports;
  const [shownEdges, setShownEdges] = useState(0);
  /** Role whose units alone are drawn at the units level; null draws them all. */
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const roleFilterRef = useRef(roleFilter);
  roleFilterRef.current = roleFilter;
  const [expansions, setExpansions] = useState<Expansions>(NO_EXPANSION);
  const [capReached, setCapReached] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceState | null>(null);
  /** Focused group: only it and what it is linked to stay drawn. */
  const [focusId, setFocusId] = useState<number | null>(null);
  /** Entered unit (path mode): its folder groups are drawn; null draws the units. */
  const [unit, setUnit] = useState<string | null>(null);
  /** Entered folders within the unit, outermost first: the last one's level is drawn. */
  const [folders, setFolders] = useState<readonly string[]>([]);
  const folder = folders.at(-1);
  /** Levels received per folder key, for this revision. */
  const levelsRef = useRef(new Map<string, ArchitectureFolderLevelMessage["level"]>());
  /** Viewport per level, for this revision: the breadcrumb returns to it. */
  const viewportsRef = useRef(new Map<string, { zoom: number; pan: cytoscape.Position }>());
  /** Folder asked for: drawn when its level arrives, unless the view went elsewhere meanwhile. */
  const pendingFolderRef = useRef<string | null>(null);
  /** Graph or matrix of the drawn level; switching keeps the level and the selection. */
  const [view, setView] = useState<View>("graph");
  const viewRef = useRef(view);
  /** The drawn level's matrix, once received. */
  const [matrix, setMatrix] = useState<ArchitectureMatrixMessage | null>(null);
  /** Matrices received per level (matrixKey), for this revision. */
  const matricesRef = useRef(new Map<string, ArchitectureMatrixMessage>());
  /** A cell the E2E driver clicks; the matrix selects and reveals it. */
  const [matrixRequest, setMatrixRequest] = useState<{ row: number; column: number } | null>(null);
  /** The summary, or the entered folder's level shaped as one. */
  const source = useMemo(() => {
    const level = folder === undefined ? undefined : levelsRef.current.get(folder);
    return summary && level ? { ...level, type: "architectureSummary" as const, stale: summary.stale } : summary;
  }, [summary, folder, levelsVersion]);
  /** What the current level draws, shaped as a summary (units, one unit's or folder's groups, or every group). */
  const drawn = useMemo(() => (source ? levelSummary(source, unit) : null), [source, unit]);
  /** Tapped element or find matches: what the highlight returns to after a hover. */
  const pinnedRef = useRef<cytoscape.Collection | null>(null);
  /** Nodes with the selection and find rings, drawn again by a redraw of the same level. */
  const selectedIdRef = useRef<string | null>(null);
  const foundIdsRef = useRef<ReadonlySet<string>>(new Set());
  // Messages and Cytoscape events read the latest values here: several can arrive before a render.
  const summaryRef = useRef(summary);
  const expansionsRef = useRef(expansions);
  const evidenceRef = useRef(evidence);
  const focusRef = useRef(focusId);
  const unitRef = useRef(unit);
  const foldersRef = useRef(folders);
  /** The viewport is the whole-graph fit: a resize fits again. Any other zoom or pan (focus, find, the user) stays. */
  const fittedRef = useRef(true);
  const fitAll = (cy: cytoscape.Core) => {
    fitReadable(cy);
    fittedRef.current = true;
  };
  /** What the next render fits: the focus, an entered group once its files are drawn, everything, or the level's last viewport. */
  const fitRef = useRef<Fit | null>(null);
  /** What the last render drew: its level (to report a new one once) and its counts. */
  const renderedRef = useRef<{
    summary: ArchitectureSummaryMessage | null; unit: string | null; folder: string | undefined;
    renderedFiles: number; groupLevelEdges: number; visibleGroups: number;
  }>({
    summary: null, unit: null, folder: undefined, renderedFiles: 0, groupLevelEdges: 0, visibleGroups: 0,
  });

  const updateExpansions = (next: Expansions) => {
    expansionsRef.current = next;
    setExpansions(next);
  };
  const updateEvidence = (next: EvidenceState | null) => {
    evidenceRef.current = next;
    setEvidence(next);
  };
  const updateFocus = (next: number | null, fit: Fit) => {
    focusRef.current = next;
    setFocusId(next);
    fitRef.current = fit;
  };
  const post = (message: ArchitectureWebviewCommand) => postMessageRef.current(message);
  /** The header's height and whether the legend fits the canvas, as laid out (E2E observability). */
  const chrome = (): ViewChrome | undefined => {
    const root = rootRef.current?.getBoundingClientRect();
    const area = canvasAreaRef.current?.getBoundingClientRect();
    if (!root || !area) return undefined;
    const legend = legendRef.current?.getBoundingClientRect();
    return {
      headerHeightPx: Math.round(area.top - root.top),
      viewHeightPx: Math.round(root.height),
      legendOverflowing: legend !== undefined && legend.bottom > area.bottom + 1,
      // Capped at 40% of the canvas: a long list scrolls inside it.
      legendScrolls: legendRef.current !== null && legendRef.current.scrollHeight > legendRef.current.clientHeight,
    };
  };
  /** The layer bands of what is drawn, behind it. */
  const showBands = (cy: cytoscape.Core) => {
    bandsRef.current = layerBands(cy);
    drawBands(bandsLayerRef.current, cy, bandsRef.current);
  };

  /** Offset of the page requested per group: any other page (a late answer after leaving a group) is dropped. */
  const pendingRef = useRef(new Map<number, number>());
  /** The drawn level's revision and folder: every request names the level its group ids come from. */
  const levelOf = () => {
    const current = foldersRef.current.at(-1);
    const revision = current === undefined ? summaryRef.current?.revision : levelsRef.current.get(current)?.revision;
    return revision === undefined ? undefined : { revision, folder: current };
  };

  // Expanding, paging, collapsing and evidence, shared by clicks, keys, messages and the E2E driver.
  const requestPage = (groupId: number, offset: number) => {
    const at = levelOf();
    if (!at) return;
    pendingRef.current.set(groupId, offset);
    post({ command: "architectureExpandGroup", ...at, groupId, offset });
  };
  const expand = (groupId: number) => {
    if (!expansionsRef.current.has(groupId)) requestPage(groupId, 0);
  };
  const loadMore = (groupId: number) => {
    const expansion = expansionsRef.current.get(groupId);
    if (expansion?.nextOffset !== undefined) requestPage(groupId, expansion.files.length);
  };
  const collapse = (groupId: number) => {
    pendingRef.current.delete(groupId);
    const next = new Map(expansionsRef.current);
    next.delete(groupId);
    updateExpansions(next);
    setCapReached(false);
  };
  /** A unit edge's pairs are asked by unit key, any other edge's by the drawn level's group ids. */
  const requestEvidence = ({ from, to, rule, ...files }: EvidenceEnds, offset: number) => {
    const at = levelOf();
    if (!at) return;
    // Rules are checked once per build: asked with the summary's revision at every level.
    if (rule !== undefined) {
      post({ command: "architectureRuleEvidence", revision: summaryRef.current?.revision ?? at.revision, rule, offset });
    } else if (typeof from === "string" || typeof to === "string") {
      post({ command: "architectureUnitEvidence", revision: at.revision, from: String(from), to: String(to), offset });
    } else post({ command: "architectureEvidence", ...at, from, to, ...files, offset });
  };
  /** Opens the evidence panel on an edge or a matrix cell; red ones say why in words, not by colour alone. */
  const openEvidence = (ends: EvidenceEnds, fromName: string, toName: string, edgeCount: number, kind?: string) => {
    if (!levelOf()) return;
    const why = kind ? ` (${kind})` : "";
    const title = `${fromName} → ${toName}: ${edgeCount} file pair${edgeCount === 1 ? "" : "s"} (static imports)${why}`;
    updateEvidence({ ends, title, edgeCount, pairs: [] });
    requestEvidence(ends, 0);
  };
  /** Opens the evidence panel on a declared rule's violating file pairs. */
  const openRule = (rule: ArchitectureRuleSummary) => {
    if (!levelOf()) return;
    const why = rule.reason ? `: ${rule.reason}` : "";
    const title = `Rule "${rule.name}" (${rule.severity}): ${plural(rule.violations, "violating file pair")}${why}`;
    const ends = { from: "", to: "", rule: rule.name };
    updateEvidence({ ends, title, edgeCount: rule.violations, pairs: [] });
    requestEvidence(ends, 0);
  };
  const showEvidence = (edge: cytoscape.EdgeSingular) => {
    const unitEdge = edge.data("unitEdge") === true;
    const ends: EvidenceEnds = unitEdge ? { from: edge.data("fromUnit"), to: edge.data("toUnit") } : { from: edge.data("from"), to: edge.data("to") };
    if (edge.data("sourceFile") !== undefined) ends.sourceFile = edge.data("sourceFile");
    if (edge.data("targetFile") !== undefined) ends.targetFile = edge.data("targetFile");
    const kind = unitEdge && edge.data("kind") !== "down" ? edge.data("kind") : undefined;
    openEvidence(ends, edge.data("fromName"), edge.data("toName"), Number(edge.data("fileEdgeCount")), kind);
  };
  const moreEvidence = () => {
    const current = evidenceRef.current;
    if (current?.nextOffset !== undefined) requestEvidence(current.ends, current.pairs.length);
  };
  const openFile = (relativePath: string) => {
    const at = levelOf();
    if (at) post({ command: "architectureOpenFile", ...at, relativePath });
  };
  /** Enters a group: focuses it, expands it and zooms on it once its files are drawn. */
  const enter = (groupId: number) => {
    updateFocus(groupId, "enter");
    expand(groupId);
  };
  /**
   * Draws another level (a unit, null for the units, and the folders entered in it): nothing
   * expanded or focused, and the viewport it was left with when it was drawn before.
   */
  const goTo = (nextUnit: string | null, nextFolders: readonly string[]) => {
    const cy = cyRef.current;
    if (cy) viewportsRef.current.set(levelKey(unitRef.current, foldersRef.current.at(-1)), { zoom: cy.zoom(), pan: { ...cy.pan() } });
    pendingRef.current.clear();
    pendingFolderRef.current = null;
    updateExpansions(NO_EXPANSION);
    updateEvidence(null);
    setCapReached(false);
    updateFocus(null, viewportsRef.current.has(levelKey(nextUnit, nextFolders.at(-1))) ? "restore" : "all");
    unitRef.current = nextUnit;
    setUnit(nextUnit);
    foldersRef.current = nextFolders;
    setFolders(nextFolders);
  };
  /** Enters a unit (null: back to the units): its folder groups. */
  const selectUnit = (next: string | null) => goTo(next, []);
  /** Enters a folder of the drawn level: drawn at once if its level was received, else once it is. */
  const enterFolder = (key: string) => {
    const revision = summaryRef.current?.revision;
    if (revision === undefined) return;
    if (levelsRef.current.has(key)) {
      goTo(unitRef.current, [...foldersRef.current, key]);
      return;
    }
    pendingFolderRef.current = key;
    post({ command: "architectureEnterFolder", revision, folder: key });
  };
  const upOneFolder = () => goTo(unitRef.current, foldersRef.current.slice(0, -1));
  /** The matrix's row is the graph's focus: switching views keeps it. */
  const selectKey = (rowKey: string) => {
    const groupId = drawn?.groups.find((group) => group.key === rowKey)?.id;
    if (groupId !== undefined && groupId !== focusRef.current) updateFocus(groupId, "focus");
  };
  /** A matrix cell selects its row and opens its evidence; a unit's own pairs have no unit edge to list. */
  const matrixCell = (row: MatrixRow<number | string>, column: MatrixRow<number | string>, cell: MatrixCell | undefined) => {
    // Handled once: a remount (Graph then Matrix again) must not click the driver's cell again.
    setMatrixRequest(null);
    selectKey(row.key);
    if (!cell || (row === column && typeof row.id === "string")) return;
    const cycle = row !== column && row.cycle !== undefined && row.cycle === column.cycle;
    openEvidence({ from: row.id, to: column.id }, row.label, column.label, cell.fileEdgeCount, cycle ? "cycle" : undefined);
  };
  /** Rows holding a level below: units, and folders holding sub-folders. */
  const enterable = (row: MatrixRow<number | string>) => typeof row.id === "string" || (matrix?.nestedGroups.includes(row.id) ?? false);
  /** A header enters its unit or folder (one level down), else selects its row. */
  const matrixHeader = (row: MatrixRow<number | string>) => {
    if (typeof row.id === "string") selectUnit(row.key);
    else if (enterable(row)) enterFolder(row.key);
    else selectKey(row.key);
  };
  const matrixPainted = (paint: MatrixPaint) => {
    if (!matrix) return;
    const { totals, cycles } = matrix.matrix;
    post({
      command: "architectureMatrixRendered", revision: matrix.revision, unit: matrix.unit, folder: matrix.folder,
      rows: totals.rows, cells: totals.cells, fileEdges: totals.fileEdges, upwardCells: totals.upwardCells, cycles: cycles.length,
      digest: matrix.digest,
      // From the whole matrix: only the cells in view are in the DOM.
      violationCells: matrix.matrix.cells.filter(({ row, column }) =>
        matrix.violations?.[`${matrix.matrix.rows[row].id}>${matrix.matrix.rows[column].id}`] !== undefined).length,
      ...paint,
    });
  };
  /** Unit colour of a matrix row: each unit's at the units level, the entered unit's inside it. */
  const rowColor = (row: MatrixRow<number | string>) => {
    const units = summary?.units?.units;
    const index = units?.findIndex((entry) => entry.key === (unit ?? row.key)) ?? -1;
    return index < 0 ? undefined : unitColor(index);
  };
  const switchView = (next: View) => {
    viewRef.current = next;
    setView(next);
  };
  /** Back to the whole architecture: every group collapsed, no focus. */
  const overview = () => {
    pendingRef.current.clear();
    updateExpansions(NO_EXPANSION);
    setCapReached(false);
    updateFocus(null, "all");
  };
  const leave = (groupId: number) => {
    collapse(groupId);
    fitRef.current = "focus";
  };
  /** A new revision: back to the units, and the levels and viewports of the old one are gone. */
  const reset = () => {
    goTo(null, []);
    levelsRef.current.clear();
    viewportsRef.current.clear();
    matricesRef.current.clear();
    setMatrix(null);
    setRoleFilter(null);
    fitRef.current = "all";
  };
  /** A legend click: keeps only this role's units, or shows them all again. */
  const toggleRole = (role: string) => setRoleFilter((current) => (current === role ? null : role));
  const isGroup = (target: cytoscape.SingularElementArgument) =>
    target.isNode() && !target.data("file") && !target.data("more") && !target.data("cycle");
  /** The selected node: its focus ring and what the live region announces; none clears both. */
  const markSelected = (cy: cytoscape.Core, node: cytoscape.NodeSingular | undefined) => {
    selectedIdRef.current = node?.id() ?? null;
    markNodes(cy, "selected", node ?? cy.collection());
    const live = document.getElementById(LIVE_REGION);
    if (live) live.textContent = node ? describeNode(node) : "";
  };
  /** Selects a node as a click does, without the focus hiding the rest, and keeps it in view. */
  const selectNode = (cy: cytoscape.Core, node: cytoscape.NodeSingular) => {
    pinnedRef.current = node;
    markSelected(cy, node);
    const { x, y } = node.renderedPosition();
    if (x < 0 || y < 0 || x > cy.width() || y > cy.height()) cy.center(node);
    showFocus(cy, node, post);
  };
  /** The units legend: a click selects the unit. */
  const legendUnit = (key: string) => {
    const cy = cyRef.current;
    const node = Array.from(cy?.nodes() ?? []).find((candidate) => candidate.data("unitKey") === key);
    if (cy && node) selectNode(cy, node);
  };
  /** The header's cycle count: its first block's units highlighted, the block fitted. */
  const showCycle = () => {
    const cy = cyRef.current;
    const block = Array.from(cy?.nodes() ?? []).find((node) => node.data("cycle") === true);
    if (!cy || !block) return;
    pinnedRef.current = block.children();
    markSelected(cy, undefined);
    cy.fit(block, 30);
    showFocus(cy, block.children(), post);
  };
  /** Fit (the readable fit, top-anchored), zoom in or out around the centre. */
  const zoom = (action: ZoomAction) => {
    const cy = cyRef.current;
    if (!cy) return;
    if (action === "fit") fitAll(cy);
    else {
      const level = cy.zoom() * (action === "in" ? ZOOM_STEP : 1 / ZOOM_STEP);
      cy.zoom({ level: Math.min(cy.maxZoom(), Math.max(cy.minZoom(), level)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    }
    showFocus(cy, pinnedRef.current ?? cy.collection(), post);
  };
  /** The focused canvas's keys: arrows move the selection to the nearest group, 0 + - zoom. Enter and Escape are window-wide. */
  const canvasKey = (event: Pick<KeyboardEvent, "key" | "preventDefault">) => {
    const cy = cyRef.current;
    const action = ZOOM_KEYS[event.key];
    if (!cy || viewRef.current !== "graph") return;
    if (action) {
      event.preventDefault();
      zoom(action);
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const selected = pinnedRef.current?.length === 1 && pinnedRef.current[0].isNode() ? pinnedRef.current[0] : undefined;
    const next = nearestNode(cy.nodes().filter((node) => isGroup(node) && node.visible()), selected, event.key as Direction);
    if (next) selectNode(cy, next);
  };
  /** A click: an edge opens its evidence, a group gets the focus, "+N more" loads a page. */
  const tap = (target: cytoscape.SingularElementArgument) => {
    const cy = cyRef.current;
    if (cy) markSelected(cy, isGroup(target) ? target as cytoscape.NodeSingular : undefined);
    if (target.isEdge()) showEvidence(target);
    else if (target.data("more")) loadMore(target.data("groupId"));
    else if (isGroup(target)) updateFocus(target.data("groupId"), "focus");
  };
  /** A double click enters a unit, a folder holding sub-folders, or a group (its files). */
  const dbltap = (target: cytoscape.SingularElementArgument) => {
    if (target.isNode() && target.data("unitKey") !== undefined) selectUnit(target.data("unitKey"));
    else if (target.isNode() && target.data("folder") !== undefined) enterFolder(target.data("folder"));
    else if (isGroup(target)) enter(target.data("groupId"));
  };
  /**
   * The canvas has no focusable nodes: the tapped node is the selected one. Enter enters it
   * (outside text fields and buttons); Escape closes the evidence, else leaves the last entered
   * group, else drops the focus, else goes up one folder, else back to the units, else clears the highlight.
   */
  const key = (event: KeyboardEvent, clearFocus: () => void) => {
    const selected = pinnedRef.current?.length === 1 ? pinnedRef.current[0] : undefined;
    if (event.key === "Enter") {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, button, textarea") !== null;
      if (!typing && selected && viewRef.current === "graph") dbltap(selected);
      return;
    }
    if (event.key === "Escape") back(clearFocus);
  };
  /** Escape; the matrix has no entered group or focus to leave, so it goes up a level. */
  const back = (clearFocus: () => void) => {
    const graph = viewRef.current === "graph";
    const lastEntered = graph ? [...expansionsRef.current.keys()].at(-1) : undefined;
    if (evidenceRef.current) updateEvidence(null);
    else if (lastEntered !== undefined) leave(lastEntered);
    else if (graph && focusRef.current !== null) updateFocus(null, "all");
    else if (foldersRef.current.length > 0) upOneFolder();
    else if (unitRef.current !== null) selectUnit(null);
    else if (graph) clearFocus();
  };
  const receiveSummary = (message: ArchitectureSummaryMessage) => {
    // Group ids and pages only hold for their revision; a stale mark or a rebuild of the same graph keeps them,
    // unless the rules changed (the matrices and evidence carry them).
    const rulesKey = (summary: ArchitectureSummaryMessage | null) => summary?.rules?.revision ?? summary?.rules?.error;
    const rulesChanged = rulesKey(summaryRef.current) !== rulesKey(message);
    if (summaryRef.current?.revision !== message.revision || (summaryRef.current && rulesChanged)) reset();
    summaryRef.current = message;
    setSummary(message);
    setState(null);
  };
  const receiveFolderLevel = ({ revision, folder: key, level }: ArchitectureFolderLevelMessage) => {
    if (revision !== summaryRef.current?.revision) return;
    // A level sent again (Show more groups) replaces its groups and keeps the view where it is.
    if (levelsRef.current.has(key)) {
      levelsRef.current.set(key, level);
      setLevelsVersion((version) => version + 1);
      return;
    }
    if (pendingFolderRef.current !== key) return;
    levelsRef.current.set(key, level);
    goTo(unitRef.current, [...foldersRef.current, key]);
  };
  /** Kept only for the drawn level and the current query: a late answer is dropped. */
  const receiveFound = (message: ArchitectureFoundMessage) => {
    const at = levelOf();
    // A message always carries a revision: without a drawn level, the first test drops it.
    if (message.revision !== at?.revision || message.folder !== at.folder || (message.unit ?? null) !== unitRef.current) return;
    if (message.query === queryRef.current) setFound(message);
  };
  const showMoreGroups = () => {
    const revision = summaryRef.current?.revision;
    if (revision !== undefined) post({ command: "architectureShowMoreGroups", revision });
  };
  const receiveDetail = ({ revision, detail }: ArchitectureGroupDetailMessage) => {
    // A level's revision covers its folder: a page for another level is dropped.
    if (revision !== levelOf()?.revision || pendingRef.current.get(detail.group.id) !== detail.page.offset) return;
    pendingRef.current.delete(detail.group.id);
    const merged = mergeGroupDetail(expansionsRef.current, detail);
    updateExpansions(merged.expansions);
    setCapReached(merged.capReached);
  };
  const receiveEvidence = (page: ArchitectureEvidencePageMessage) => {
    const current = evidenceRef.current;
    // A page for another edge, revision or offset (a late answer, a double click) is dropped.
    const revision = page.rule === undefined ? levelOf()?.revision : summaryRef.current?.revision;
    if (!current || page.revision !== revision || !sameEnds(current.ends, page)) return;
    if (page.page.offset !== current.pairs.length) return;
    updateEvidence({ ...current, pairs: [...current.pairs, ...page.pairs], total: page.page.total, nextOffset: page.page.nextOffset });
  };
  /** Keeps every level's matrix of this revision; shows it if it is the drawn level's. */
  const receiveMatrix = (message: ArchitectureMatrixMessage) => {
    if (message.revision !== levelOf()?.revision && message.revision !== summaryRef.current?.revision) return;
    const key = matrixKey(message.revision, message.unit, message.folder);
    matricesRef.current.set(key, message);
    const at = levelOf();
    if (at && key === matrixKey(at.revision, unitRef.current, at.folder)) setMatrix(message);
  };
  /** E2E driver: the toggle, a matrix cell and a matrix header, named by row keys. */
  const controlMatrix = ({ view: next, matrixCell: cell, matrixHeader: header }: ArchitectureControlsMessage) => {
    if (next !== undefined) switchView(next);
    const rows = matrix?.matrix.rows ?? [];
    const indexOf = (rowKey: string) => rows.findIndex((row) => row.key === rowKey);
    if (cell && indexOf(cell.row) >= 0 && indexOf(cell.column) >= 0) setMatrixRequest({ row: indexOf(cell.row), column: indexOf(cell.column) });
    const headerRow = header === undefined ? undefined : rows[indexOf(header)];
    if (headerRow) matrixHeader(headerRow);
  };
  /** The id of the drawn group with this key (E2E driver). */
  const groupOf = (groupKey: string | undefined): number | undefined => {
    if (!groupKey) return undefined;
    return Array.from(cyRef.current?.nodes() ?? [])
      .find((node) => !node.isChild() && node.data("unitKey") === undefined && node.data("groupKey") === groupKey)?.data("groupId");
  };
  /** The id of the drawn unit with this key (E2E driver, units level). */
  const unitIdOf = (unitKey: string | undefined): number | undefined =>
    (unitKey ? Array.from(cyRef.current?.nodes() ?? []).find((node) => node.data("unitKey") === unitKey)?.data("groupId") : undefined);
  /** E2E driver: real clicks on the zoom controls, the legend and the cycle count; keys pressed on the focused canvas. */
  const controlCanvas = ({ zoom: action, keys, legendUnit: key, cycleCount }: ArchitectureControlsMessage) => {
    if (action) document.querySelector<HTMLButtonElement>(`[aria-label="Zoom controls"] button[data-zoom="${action}"]`)?.click();
    if (key !== undefined) document.querySelector<HTMLButtonElement>(`[aria-label="Units"] button[data-unit="${CSS.escape(key)}"]`)?.click();
    if (cycleCount) document.querySelector<HTMLButtonElement>("button[data-cycle-count]")?.click();
    const container = containerRef.current;
    if (!keys || !container) return;
    container.focus();
    for (const pressed of keys) container.dispatchEvent(new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true }));
  };
  /** E2E driver: selects the first edge of a group or unit (its evidence opens), then clicks a row's source. */
  const controlEvidence = ({ evidenceOf, openEvidenceRow, rule, role, showMoreGroups }: ArchitectureControlsMessage) => {
    // A real click on the Rules panel's button.
    if (rule !== undefined) document.querySelector<HTMLButtonElement>(`[aria-label="Architecture rules"] button[data-rule="${CSS.escape(rule)}"]`)?.click();
    // A real click on the role legend's button.
    if (role !== undefined) document.querySelector<HTMLButtonElement>(`[aria-label="Unit roles"] button[data-role="${CSS.escape(role)}"]`)?.click();
    // A real click on the header's Show more groups.
    if (showMoreGroups) document.querySelector<HTMLButtonElement>("button[data-show-more]")?.click();
    const groupId = groupOf(evidenceOf) ?? unitIdOf(evidenceOf);
    const touches = (edge: cytoscape.EdgeSingular) => edge.data("from") === groupId || edge.data("to") === groupId;
    const edge = Array.from(cyRef.current?.edges() ?? []).find((candidate) => candidate.data("from") !== candidate.data("to") && touches(candidate));
    if (groupId !== undefined && edge) showEvidence(edge);
    const row = openEvidenceRow === undefined ? undefined : evidenceRef.current?.pairs[openEvidenceRow];
    if (row) openFile(row.source);
  };
  /** E2E driver: the same actions as a user, groups named by key. */
  const control = (message: ArchitectureControlsMessage) => {
    controlMatrix(message);
    // Entering a unit first: the group keys below are those of the unit's groups, drawn on the next render.
    if (message.unit !== undefined) {
      selectUnit(message.unit === "" ? null : message.unit);
      return;
    }
    if (message.folder !== undefined) {
      if (message.folder === "") upOneFolder();
      else enterFolder(message.folder);
      return;
    }
    if (message.find !== undefined) setQuery(message.find);
    if (message.minImports !== undefined) setMinImports(message.minImports);
    if (message.focus === "") updateFocus(null, "all");
    const focusId = groupOf(message.focus);
    if (focusId !== undefined) updateFocus(focusId, "focus");
    const expandId = groupOf(message.expand);
    if (expandId !== undefined) enter(expandId);
    const collapseId = groupOf(message.collapse);
    if (collapseId !== undefined) collapse(collapseId);
    controlEvidence(message);
    controlCanvas(message);
  };
  const receive = (message: ArchitectureExtensionMessage) => {
    switch (message.type) {
      case "architectureSummary":
        return receiveSummary(message);
      case "architectureFolderLevel":
        return receiveFolderLevel(message);
      case "architectureState":
        return setState(message);
      case "architectureGroupDetail":
        return receiveDetail(message);
      case "architectureEvidencePage":
        return receiveEvidence(message);
      case "architectureMatrix":
        return receiveMatrix(message);
      case "architectureFound":
        return receiveFound(message);
      case "architectureRevisionChanged":
        reset();
        return post({ command: "architectureMounted" });
      case "architectureControls":
        return control(message);
    }
  };
  const actions = {
    tap, dbltap, key, canvasKey, zoom, legendUnit, showCycle, showBands, chrome, markSelected, openFile, moreEvidence, receive, overview, leave, updateFocus, selectUnit, goTo, openRule, toggleRole, showMoreGroups,
    switchView, matrixCell, matrixHeader, matrixPainted, enterable, rowColor, levelOf,
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ArchitectureExtensionMessage>) => {
      // Extension messages come from the webview's own vscode-webview:// origin (S2819).
      if (event.origin && !event.origin.startsWith("vscode-webview://") && event.origin !== "null") return;
      if (event.data?.type) actionsRef.current.receive(event.data);
    };
    window.addEventListener("message", handleMessage);
    postMessageRef.current({ command: "architectureMounted" });
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const cy = cytoscape({
      container,
      elements: [],
      style: buildArchitectureStylesheet(themeColors(), themeKindOf(document.body)),
      wheelSensitivity: 0.3,
      minZoom: 0.05,
      maxZoom: 5,
    });
    const pinned = () => pinnedRef.current ?? cy.collection();
    const clearFocus = () => {
      pinnedRef.current = null;
      setQuery("");
      actionsRef.current.markSelected(cy, undefined);
      showFocus(cy, cy.collection(), postMessageRef.current);
    };
    cy.on("mouseover", "node, edge", (event) => {
      container.title = String(event.target.data("tooltip") ?? "");
      showFocus(cy, event.target, postMessageRef.current);
    });
    cy.on("mouseout", "node, edge", () => {
      container.title = "";
      showFocus(cy, pinned(), postMessageRef.current);
    });
    cy.on("tap", (event) => {
      if (event.target === cy) {
        clearFocus();
        if (focusRef.current !== null) actionsRef.current.updateFocus(null, "all");
        return;
      }
      pinnedRef.current = event.target;
      showFocus(cy, event.target, postMessageRef.current);
      actionsRef.current.tap(event.target);
    });
    cy.on("dbltap", "node", (event) => actionsRef.current.dbltap(event.target));
    // Synchronous: fitAll sets the flag again right after its own zoom and pan.
    cy.on("viewport", () => {
      fittedRef.current = false;
      drawBands(bandsLayerRef.current, cy, bandsRef.current);
    });
    // A dragged node leaves its routes: its edges go back to the default curve.
    cy.on("drag", "node", (event) => {
      const moved = event.target.union(event.target.ancestors());
      applyRoutes(cy, moved.union(moved.descendants()).connectedEdges(), savedRoutes);
    });
    // VS Code switches the theme on the body: the units' tones and the rings follow it.
    const themeObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      cy.style(buildArchitectureStylesheet(themeColors(), themeKindOf(document.body)));
    });
    themeObserver?.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind"] });
    const handleKeyDown = (event: KeyboardEvent): void => actionsRef.current.key(event, clearFocus);
    // Cytoscape's container takes the keyboard focus (Tab) and the canvas keys: arrows and zoom.
    const handleCanvasKey = (event: KeyboardEvent): void => actionsRef.current.canvasKey(event);
    container.tabIndex = 0;
    container.addEventListener("keydown", handleCanvasKey);
    window.addEventListener("keydown", handleKeyDown);
    cyRef.current = cy;
    const elk = createElk();
    elkRef.current = elk;

    // Re-fit when the view is resized (same pattern as CytoscapeGraph). Debounced so a
    // live drag does not thrash; the layout is not re-run, only the viewport.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const handleResize = (): void => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        cy.resize();
        // A banner (stale, find) resizes the canvas too: only a whole-graph fit follows it.
        if (fittedRef.current) fitAll(cy);
        postMessageRef.current({ command: "architectureResized", width: container.clientWidth, height: container.clientHeight });
      }, 120);
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);
    resizeObserver?.observe(container);
    // Also covers environments without ResizeObserver; the debounce merges both sources.
    window.addEventListener("resize", handleResize);

    return () => {
      clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("keydown", handleCanvasKey);
      cy.destroy();
      cyRef.current = null;
      elk.terminate();
      elkRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    const elk = elkRef.current;
    if (!cy || !elk || !summary || !source || !drawn) return;
    const run = ++layoutRunRef.current;
    // Shown again by any render: only a pending ELK layout hides the canvas.
    cy.container()?.style.removeProperty("visibility");
    const previous = renderedRef.current.summary;
    const freshRevision = previous?.revision !== summary.revision;
    // A new level re-fits like a new revision; a page, a collapse or a stale mark keeps the viewport.
    const freshLevel = freshRevision || renderedRef.current.unit !== unit || renderedRef.current.folder !== folder;
    if (freshRevision) filePositions.clear();
    // A page, a collapse or a stale mark redraws the same graph: keep what was tapped.
    const pinnedIds = new Set(freshLevel ? [] : (pinnedRef.current?.map((element) => element.id()) ?? []));
    const elements = toLevelElements(source, unit, expansions, folder);
    cy.elements().remove();
    cy.add(elements);
    pinnedRef.current = pinnedIds.size > 0 ? cy.elements().filter((element) => pinnedIds.has(element.id())) : null;
    // New elements carry no class: the same level keeps its find and selection rings.
    if (freshLevel) selectedIdRef.current = null;
    markNodes(cy, "found", freshLevel ? cy.collection() : cy.nodes().filter((node) => foundIdsRef.current.has(node.id())));
    markNodes(cy, "selected", selectedIdRef.current === null ? cy.collection() : cy.getElementById(selectedIdRef.current));
    renderedRef.current = { summary: drawn, unit, folder, ...countRendered(elements), visibleGroups: 0 };
    // Laid out and pushed apart as a whole: a cycle block with its units.
    const orphans = cy.nodes().filter((node) => !node.isChild());
    const finish = (fit: boolean) => {
      settleLayout(cy, orphans);
      if (fit) fitAll(cy);
      // The same level laid out again (Show more groups): what was found or tapped stays in view.
      if (fit && !freshLevel && pinnedRef.current?.length) cy.center(pinnedRef.current);
      // Measured after the min-imports and role filters, which run in later effects.
      if (previous !== drawn) {
        applyMinImports(cy, minImportsRef.current);
        applyRoleFilter(cy, roleFilterRef.current);
      }
      actionsRef.current.showBands(cy);
      if (previous === drawn) return;
      postMessageRef.current(renderedReport(cy, summary, drawn, unit, folder, actionsRef.current.chrome()));
    };
    const laidOut = () => {
      packIsolatedGroups(cy);
      finish(true);
    };
    const restored = restorePositions(cy, groupNodes(cy));
    if (!restored && summary.units) {
      // Units, and an entered unit's groups, sit on their layers.
      layoutWithElk(cy, elk, () => run === layoutRunRef.current && !cy.destroyed(), laidOut);
      return;
    }
    if (!restored) {
      // ponytail: one new or resized group re-runs the whole layout; pin the known ones
      // (fcose fixedNodeConstraint) if users miss their picture after small edits.
      const linked = linkedElements(cy);
      if (linked.nodes().empty()) {
        laidOut();
        return;
      }
      const layout = linked.layout(ARCHITECTURE_FCOSE_LAYOUT as cytoscape.LayoutOptions);
      layout.on("layoutstop", laidOut);
      layout.run();
      return;
    }
    placeNewFiles(cy, filePositions, (group) => savedLayout.get(group.data("key")) ?? { x: 0, y: 0 });
    // Only a new revision or level re-fits: a page, a collapse or a stale mark keeps the viewport.
    finish(freshLevel);
  }, [summary, source, drawn, unit, folder, expansions]);

  // After each render: hide what the focus leaves out, then fit what was asked for.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !summary) return;
    const group = focusId === null ? cy.collection() : cy.getElementById(`group-${focusId}`);
    const shown = focusGroup(cy, group);
    renderedRef.current.visibleGroups = shown.nodes().filter((node) => !node.isChild()).length;
    const fit = fitRef.current;
    if (fit === "enter" && group.nonempty() && !group.isParent()) {
      // The entered group's files are not drawn yet: zoom once they are, unless no page is coming (cap).
      if (!pendingRef.current.has(Number(focusId))) fitRef.current = null;
      return;
    }
    const viewport = fit === "restore" ? viewportsRef.current.get(levelKey(unit, folder)) : undefined;
    if (viewport) cy.viewport(viewport);
    else if (fit === "all" || fit === "restore") fitAll(cy);
    else if (fit !== null) cy.fit(fit === "enter" ? group : shown, 30);
    fitRef.current = null;
  }, [summary, drawn, unit, folder, expansions, focusId]);

  // Before the highlight effects, so their report stays the last message of a render.
  useEffect(() => {
    if (!summary) return;
    const { renderedFiles, groupLevelEdges, visibleGroups } = renderedRef.current;
    const focused = focusId === 0 ? "" : drawn?.groups.find((group) => group.id === focusId)?.key;
    postMessageRef.current({
      command: "architectureDetailRendered",
      expandedGroups: expansions.size,
      expandedFileCount: [...expansions.values()].reduce((total, expansion) => total + expansion.total, 0),
      renderedFiles,
      groupLevelEdges,
      visibleGroups,
      focusedGroup: focusId === null ? undefined : focused,
      capReached,
      findStatus: document.querySelector('output[aria-label="Find result"]')?.textContent ?? "",
      viewport: cyRef.current ? `${Math.round(cyRef.current.zoom() * 1000) / 1000}@${Math.round(cyRef.current.pan().x)},${Math.round(cyRef.current.pan().y)}` : undefined,
      evidence: evidence?.total === undefined
        ? undefined
        : {
          edgeCount: evidence.edgeCount, total: evidence.total, shown: evidence.pairs.length, firstSource: evidence.pairs[0]?.source,
          // The pairs the Evidence region shows, read from the DOM this render committed: each source under its target's heading.
          title: evidence.title,
          pairs: Array.from(document.querySelectorAll('section[aria-label="Evidence"] li li'), (row) =>
            `${row.querySelector("button")?.title} → ${row.parentElement?.closest("li")?.querySelector("button")?.title}`),
        },
    });
  }, [summary, drawn, expansions, evidence, capReached, focusId, findMatches, found, query, view, minImports]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !summary) return;
    setShownEdges(applyMinImports(cy, minImports));
    showFocus(cy, pinnedRef.current ?? cy.collection(), postMessageRef.current);
  }, [summary, drawn, expansions, focusId, minImports]);

  // The legend's role filter, then what is drawn once filtered (the units level's render report).
  useEffect(() => {
    const cy = cyRef.current;
    const current = summaryRef.current;
    if (!cy || !current?.units || unitRef.current !== null || cy.nodes().length === 0) return;
    applyRoleFilter(cy, roleFilter);
    actionsRef.current.showBands(cy);
    postMessageRef.current(renderedReport(cy, current, current, null, undefined, actionsRef.current.chrome()));
  }, [roleFilter]);

  // A new revision, level or cap (Show more groups) finds again; a stale mark or a page keeps what is pinned.
  const revision = summary?.revision;
  const hiddenGroups = drawn?.hiddenGroups ?? 0;
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || revision === undefined) return;
    const matches = findGroups(cy, query);
    pinnedRef.current = matches;
    foundIdsRef.current = new Set(matches.map((node) => node.id()));
    markNodes(cy, "found", matches);
    setFindMatches(matches.length);
    showFocus(cy, matches, postMessageRef.current);
    if (matches.nonempty()) cy.center(matches);
  }, [revision, unit, folder, query, hiddenGroups]);

  // The hidden groups are searched by the extension: asked again for a new query, level or cap.
  useEffect(() => {
    setFound(null);
    const at = actionsRef.current.levelOf();
    if (!at || hiddenGroups === 0 || !query.trim()) return;
    postMessageRef.current({ command: "architectureFind", ...at, unit: unit ?? undefined, query });
  }, [revision, unit, folder, query, hiddenGroups]);

  // The matrix holds every group of its level: its find searches the rows.
  const needle = query.trim().toLowerCase();
  const matrixMatches = view === "matrix" && needle && matrix
    ? matrix.matrix.rows.filter((row) => `${row.label}\n${row.key}`.toLowerCase().includes(needle))
    : [];

  // The matrix of the drawn level: kept per level, asked for once.
  useEffect(() => {
    if (view !== "matrix" || revision === undefined) return;
    const current = folders.at(-1);
    const levelRevision = current === undefined ? revision : levelsRef.current.get(current)?.revision;
    if (levelRevision === undefined) return;
    const cached = matricesRef.current.get(matrixKey(levelRevision, unit, current));
    setMatrix(cached ?? null);
    if (!cached) postMessageRef.current({ command: "architectureMatrix", revision: levelRevision, folder: current, unit: unit ?? undefined });
  }, [view, revision, unit, folders]);

  const refresh = () => postMessageRef.current({ command: "architectureRefresh" });
  const unitsLevel = summary?.units !== undefined && unit === null;
  const levelName = unitsLevel ? "the units" : [unit, ...folders].findLast(Boolean) ?? "the groups";
  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      {state && (
        <StatePanel state={state} onRetry={refresh} onSettings={() => postMessageRef.current({ command: "architectureOpenSettings" })} />
      )}
      {!state && summary && drawn && (
        <>
          <SummaryHeader
            summary={summary} level={drawn} onShowMore={() => actionsRef.current.showMoreGroups()}
            unit={unit} minImports={minImports} onRefresh={refresh}
            onRule={(rule) => actionsRef.current.openRule(rule)}
            roleFilter={roleFilter} onRole={(role) => actionsRef.current.toggleRole(role)}
            onCycle={() => actionsRef.current.showCycle()}
          />
          {/* The path sits right of the controls while the width allows. */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", borderBottom: "1px solid var(--vscode-widget-border)" }}>
          <GraphControls
            summary={drawn}
            unitsLevel={unitsLevel}
            shownEdges={shownEdges}
            query={query}
            onQuery={setQuery}
            minImports={minImports}
            onMinImports={setMinImports}
            capReached={capReached}
            view={view}
            onView={(next) => actionsRef.current.switchView(next)}
            findMatches={view === "matrix" ? matrixMatches.length : findMatches}
            found={found}
            onShowMore={() => actionsRef.current.showMoreGroups()}
            canShowMore={canShowMore(summary)}
          />
          <Breadcrumb
            summary={drawn}
            unit={unit}
            folders={folders}
            onUnits={() => actionsRef.current.selectUnit(null)}
            onLevel={(depth) => actionsRef.current.goTo(unit, folders.slice(0, depth))}
            expansions={expansions}
            focusId={focusId}
            onOverview={() => actionsRef.current.overview()}
            onClearFocus={() => actionsRef.current.updateFocus(null, "all")}
            onFocus={(groupId) => actionsRef.current.updateFocus(groupId, "enter")}
            onLeave={(groupId) => actionsRef.current.leave(groupId)}
            view={view}
          />
          </div>
        </>
      )}
      <div ref={canvasAreaRef} style={{ position: "relative", flex: 1, minHeight: 0, visibility: state ? "hidden" : "visible" }}>
        {/* Hidden on a wrapper: the ELK layout shows and hides the container itself. */}
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", visibility: view === "matrix" ? "hidden" : undefined }}>
          <div ref={bandsLayerRef} aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
          {/* Enter and Escape are window-wide; arrows and zoom keys need the canvas focused. */}
          <div
            ref={containerRef} data-testid="architecture-graph" role="application"
            aria-label={`Architecture graph of ${levelName}: arrow keys select, Enter enters, Escape goes back, 0 fits, + and - zoom`}
            aria-describedby={LIVE_REGION}
            style={{ position: "absolute", inset: 0, outlineOffset: -2 }}
          />
          {!state && summary && drawn && (
            <CanvasOverlays
              summary={summary} drawn={drawn} unitsLevel={unitsLevel} view={view} legendRef={legendRef}
              onZoom={(action) => actionsRef.current.zoom(action)} onUnit={(key) => actionsRef.current.legendUnit(key)}
            />
          )}
        </div>
        <output id={LIVE_REGION} aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }} />
        {!state && view === "matrix" && !matrix && <output style={{ display: "block", padding: 16, fontSize: 12 }}>Building the matrix…</output>}
        {!state && view === "matrix" && matrix && (
          <ArchitectureMatrix
            matrix={matrix.matrix}
            violations={matrix.violations}
            request={matrixRequest}
            revealKey={matrixMatches[0]?.key}
            enterable={(row) => actionsRef.current.enterable(row)}
            colorOf={(row) => actionsRef.current.rowColor(row)}
            selectedKey={focusId === null ? undefined : drawn?.groups.find((group) => group.id === focusId)?.key}
            onCell={(row, column, cell) => actionsRef.current.matrixCell(row, column, cell)}
            onHeader={(row) => actionsRef.current.matrixHeader(row)}
            onPaint={(paint) => actionsRef.current.matrixPainted(paint)}
          />
        )}
        {!state && evidence && (
          <EvidencePanel
            evidence={evidence}
            unit={unit}
            folder={folder}
            onOpen={(relativePath) => actionsRef.current.openFile(relativePath)}
            onMore={() => actionsRef.current.moreEvidence()}
            onClose={() => updateEvidence(null)}
          />
        )}
      </div>
    </div>
  );
}
