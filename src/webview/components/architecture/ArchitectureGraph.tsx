/**
 * ArchitectureGraph — the sidebar's Architecture view mode: collapsed groups and the
 * group edges between them, rendered with Cytoscape + fcose. A group expands into its
 * files, and any edge lists the file pairs behind it.
 *
 * Mounted only in architecture mode. On mount it posts `architectureMounted`, and the
 * extension answers with the cached summary or a build, so no message can arrive early.
 */

import cytoscape from "cytoscape";
import React, { useEffect, useRef, useState } from "react";
import type {
  ArchitectureControlsMessage,
  ArchitectureEvidencePageMessage,
  ArchitectureExtensionMessage,
  ArchitectureGroupDetailMessage,
  ArchitectureStateMessage,
  ArchitectureSummaryMessage,
  ArchitectureWebviewCommand,
} from "../../../shared/architecture-types";
import { buildArchitectureStylesheet } from "../cytoscape/CytoscapeTheme";
import {
  applyMinImports,
  ARCHITECTURE_FCOSE_LAYOUT,
  type Expansions,
  FILE_CAP_MESSAGE,
  findGroups,
  focusGroup,
  highlightFocus,
  type LayoutBox,
  measureInteraction,
  mergeGroupDetail,
  countRendered,
  placeNewFiles,
  separateOverlaps,
  toArchitectureElements,
} from "./architectureElements";
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

/**
 * Highlights `focus` and reports what is drawn (E2E observability).
 * ponytail: every hover reads the computed style of all edges; fine for ≤ 150 groups, gate the report behind an E2E flag if hovering lags.
 */
function showFocus(cy: cytoscape.Core, focus: cytoscape.Collection, post: (message: ArchitectureWebviewCommand) => void): void {
  highlightFocus(cy, focus);
  post({ command: "architectureInteracted", ...measureInteraction(cy) });
}

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
      savedLayout.set(node.data("key"), { x, y, width: node.data("width"), height: node.data("height") });
    }
  }
  cy.nodes().forEach((node) => {
    if (node.isChild()) filePositions.set(node.id(), { ...node.position() });
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
    const saved = node.isChild() ? filePositions.get(node.id()) : savedLayout.get(node.data("key"));
    if (saved && !node.isParent()) node.position({ x: saved.x, y: saved.y });
  });
  return true;
}

/** The ends an evidence request names; a file restricts one end. */
interface EvidenceEnds {
  from: number;
  to: number;
  sourceFile?: string;
  targetFile?: string;
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

const sameEnds = (left: EvidenceEnds, right: EvidenceEnds) =>
  left.from === right.from && left.to === right.to && left.sourceFile === right.sourceFile && left.targetFile === right.targetFile;

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
  return {
    foreground: cssVar("--vscode-foreground", "#cccccc"),
    background: cssVar("--vscode-editorWidget-background", "#252526"),
    border: cssVar("--vscode-descriptionForeground", "#999999"),
    edge: cssVar("--vscode-editorLineNumber-foreground", "#858585"),
    accent: cssVar("--vscode-focusBorder", "#007fd4"),
  };
}

const bannerStyle: React.CSSProperties = {
  background: "var(--vscode-inputValidation-warningBackground)",
  border: "1px solid var(--vscode-inputValidation-warningBorder)",
  padding: "4px 8px",
  margin: "4px 0",
};

function SummaryHeader({ summary, onRefresh }: Readonly<{ summary: ArchitectureSummaryMessage; onRefresh: () => void }>) {
  const { context, totals } = summary;
  return (
    <div style={{ padding: "6px 10px", fontSize: 12, borderBottom: "1px solid var(--vscode-widget-border)" }}>
      {summary.stale && (
        <output style={{ ...bannerStyle, display: "block" }}>
          Files changed since this view was built.{" "}
          <button type="button" onClick={onRefresh}>Refresh</button>
        </output>
      )}
      <div style={{ fontWeight: 600 }}>{MODE_WORDING[context.communityMode]}</div>
      <div>
        {totals.files} files · {totals.fileEdges} file edges ({totals.intraGroupEdges} within groups,{" "}
        {totals.interGroupEdges} between groups)
      </div>
      <div style={{ color: "var(--vscode-descriptionForeground)" }}>
        {summary.scannedFiles} scanned · {summary.analyzedFiles} analysed
        {context.failedFiles > 0 && (
          <span title="Files that could not be read or parsed; they count as files without imports.">
            {" "}· {context.failedFiles} failed
          </span>
        )}
      </div>
      {context.truncated && (
        <div style={bannerStyle}>Only the first {context.maxFiles} files were analysed (maxFiles).</div>
      )}
      {summary.hiddenGroups > 0 && (
        <div>
          {summary.groups.length} of {summary.totalGroups} groups shown (largest first); {summary.hiddenGroupEdges} group
          edges hidden. Totals include them.
        </div>
      )}
      <div style={{ color: "var(--vscode-descriptionForeground)" }}>{summary.provenance.facts}</div>
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
}

/** Find and weak-edge filter: they only change what is drawn, never the counts above. */
function GraphControls({ summary, shownEdges, query, onQuery, minImports, onMinImports, capReached }: Readonly<GraphControlsProps>) {
  const counts = summary.groupEdges.map((edge) => edge.fileEdgeCount);
  return (
    <div style={{ padding: "4px 10px", fontSize: 12, borderBottom: "1px solid var(--vscode-widget-border)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <input
          type="search"
          aria-label="Find group"
          placeholder="Find group"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        <label>
          Min. imports per edge{" "}
          <input
            type="number"
            min={1}
            max={Math.max(1, ...counts)}
            value={minImports}
            onChange={(event) => onMinImports(Math.max(1, Math.floor(Number(event.target.value)) || 1))}
            style={{ width: 56 }}
          />
        </label>
      </div>
      {shownEdges < counts.length && (
        <div>
          {shownEdges} of {counts.length} group edges shown (min. {minImports} imports). Totals include them.
        </div>
      )}
      {query.trim() && summary.hiddenGroups > 0 && (
        <div>Find searches the {summary.groups.length} groups shown; the {summary.hiddenGroups} hidden groups are not searched.</div>
      )}
      {capReached && <output style={{ ...bannerStyle, display: "block" }}>{FILE_CAP_MESSAGE}</output>}
    </div>
  );
}

interface EvidencePanelProps {
  evidence: EvidenceState;
  onOpen: (relativePath: string) => void;
  onMore: () => void;
  onClose: () => void;
}

/** The file pairs behind the selected edge; every path is a button that opens the file. */
function EvidencePanel({ evidence, onOpen, onMore, onClose }: Readonly<EvidencePanelProps>) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Keyboard users land in the panel when it opens for a new edge.
  useEffect(() => closeRef.current?.focus(), [evidence.ends]);
  const pathButton = (relativePath: string) => (
    <button type="button" onClick={() => onOpen(relativePath)} style={{ fontFamily: "var(--vscode-editor-font-family)" }}>
      {relativePath}
    </button>
  );
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
      <ul style={{ listStyle: "none", padding: 0, margin: "4px 0" }}>
        {evidence.pairs.map((pair) => (
          <li key={`${pair.source}>${pair.target}`}>{pathButton(pair.source)} → {pathButton(pair.target)}</li>
        ))}
      </ul>
      {evidence.nextOffset !== undefined && <button type="button" onClick={onMore}>Load more</button>}
    </section>
  );
}

interface BreadcrumbProps {
  summary: ArchitectureSummaryMessage;
  expansions: Expansions;
  focusId: number | null;
  onOverview: () => void;
  onFocus: (groupId: number) => void;
  onLeave: (groupId: number) => void;
}

/** Where the view is: the overview, the focused group, the entered groups, each with a way back. */
function Breadcrumb({ summary, expansions, focusId, onOverview, onFocus, onLeave }: Readonly<BreadcrumbProps>) {
  const labelOf = (id: number) => (id === 0 ? "unassigned" : summary.groups.find((group) => group.id === id)?.label ?? `group ${id}`);
  const entered = [...expansions.keys()];
  return (
    <nav aria-label="Architecture path" style={{ padding: "4px 10px", fontSize: 12, borderBottom: "1px solid var(--vscode-widget-border)" }}>
      <button type="button" onClick={onOverview} disabled={focusId === null && entered.length === 0}>Overview</button>
      {focusId !== null && !expansions.has(focusId) && <> › <strong>{labelOf(focusId)}</strong></>}
      {entered.map((id) => (
        <span key={id}>
          {" › "}
          <button type="button" onClick={() => onFocus(id)} aria-current={id === focusId ? "location" : undefined}>{labelOf(id)}</button>
          <button type="button" aria-label={`Leave ${labelOf(id)}`} onClick={() => onLeave(id)}>×</button>
        </span>
      ))}
      <span style={{ marginLeft: 8, color: "var(--vscode-descriptionForeground)" }}>
        Click: focus · Double-click or Enter: enter · Escape: back
      </span>
    </nav>
  );
}

function StatePanel({ state, onRetry }: Readonly<{ state: ArchitectureStateMessage; onRetry: () => void }>) {
  return (
    <output style={{ display: "block", padding: 16, fontSize: 12 }}>
      {state.status === "building" && (
        <>
          <div>{state.message ?? "Building architecture…"}</div>
          <progress max={100} value={state.percent} style={{ width: "100%" }} />
        </>
      )}
      {state.status === "empty" && <div>{state.message ?? "No source file found."}</div>}
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
  const cyRef = useRef<cytoscape.Core | null>(null);
  const postMessageRef = useRef(postMessage);
  postMessageRef.current = postMessage;
  const [summary, setSummary] = useState<ArchitectureSummaryMessage | null>(null);
  const [state, setState] = useState<ArchitectureStateMessage | null>({ type: "architectureState", status: "building" });
  const [query, setQuery] = useState("");
  const [minImports, setMinImports] = useState(1);
  const [shownEdges, setShownEdges] = useState(0);
  const [expansions, setExpansions] = useState<Expansions>(NO_EXPANSION);
  const [capReached, setCapReached] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceState | null>(null);
  /** Focused group: only it and what it is linked to stay drawn. */
  const [focusId, setFocusId] = useState<number | null>(null);
  /** Tapped element or find matches: what the highlight returns to after a hover. */
  const pinnedRef = useRef<cytoscape.Collection | null>(null);
  // Messages and Cytoscape events read the latest values here: several can arrive before a render.
  const summaryRef = useRef(summary);
  const expansionsRef = useRef(expansions);
  const evidenceRef = useRef(evidence);
  const focusRef = useRef(focusId);
  /** What the next render fits: the focus, an entered group once its files are drawn, or everything. */
  const fitRef = useRef<"focus" | "enter" | "all" | null>(null);
  /** What the last render drew: its summary (to report a new one once) and its counts. */
  const renderedRef = useRef<{ summary: ArchitectureSummaryMessage | null; renderedFiles: number; groupLevelEdges: number; visibleGroups: number }>({
    summary: null, renderedFiles: 0, groupLevelEdges: 0, visibleGroups: 0,
  });

  const updateExpansions = (next: Expansions) => {
    expansionsRef.current = next;
    setExpansions(next);
  };
  const updateEvidence = (next: EvidenceState | null) => {
    evidenceRef.current = next;
    setEvidence(next);
  };
  const updateFocus = (next: number | null, fit: "focus" | "enter" | "all") => {
    focusRef.current = next;
    setFocusId(next);
    fitRef.current = fit;
  };
  const post = (message: ArchitectureWebviewCommand) => postMessageRef.current(message);

  /** Groups with a page requested and not received yet: any other page (a late answer after a collapse) is dropped. */
  const pendingRef = useRef(new Set<number>());

  // Expanding, paging, collapsing and evidence, shared by clicks, keys, messages and the E2E driver.
  const requestPage = (groupId: number, offset: number) => {
    const revision = summaryRef.current?.revision;
    if (revision === undefined) return;
    pendingRef.current.add(groupId);
    post({ command: "architectureExpandGroup", revision, groupId, offset });
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
  const showEvidence = (edge: cytoscape.EdgeSingular) => {
    const revision = summaryRef.current?.revision;
    if (revision === undefined) return;
    const ends: EvidenceEnds = { from: edge.data("from"), to: edge.data("to") };
    if (edge.data("sourceFile") !== undefined) ends.sourceFile = edge.data("sourceFile");
    if (edge.data("targetFile") !== undefined) ends.targetFile = edge.data("targetFile");
    const edgeCount = Number(edge.data("fileEdgeCount"));
    const title = `${edge.data("fromName")} → ${edge.data("toName")}: ${edgeCount} file pair${edgeCount === 1 ? "" : "s"} (static imports)`;
    updateEvidence({ ends, title, edgeCount, pairs: [] });
    post({ command: "architectureEvidence", revision, ...ends, offset: 0 });
  };
  const moreEvidence = () => {
    const revision = summaryRef.current?.revision;
    const current = evidenceRef.current;
    if (revision !== undefined && current?.nextOffset !== undefined) {
      post({ command: "architectureEvidence", revision, ...current.ends, offset: current.pairs.length });
    }
  };
  const openFile = (relativePath: string) => {
    const revision = summaryRef.current?.revision;
    if (revision !== undefined) post({ command: "architectureOpenFile", revision, relativePath });
  };
  /** Enters a group: focuses it, expands it and zooms on it once its files are drawn. */
  const enter = (groupId: number) => {
    updateFocus(groupId, "enter");
    expand(groupId);
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
  const reset = () => {
    pendingRef.current.clear();
    updateExpansions(NO_EXPANSION);
    updateEvidence(null);
    setCapReached(false);
    updateFocus(null, "all");
  };
  const isGroup = (target: cytoscape.SingularElementArgument) => target.isNode() && !target.data("file") && !target.data("more");
  /** A click: an edge opens its evidence, a group gets the focus, "+N more" loads a page. */
  const tap = (target: cytoscape.SingularElementArgument) => {
    if (target.isEdge()) showEvidence(target);
    else if (target.data("more")) loadMore(target.data("groupId"));
    else if (isGroup(target)) updateFocus(target.data("groupId"), "focus");
  };
  /** A double click enters a group. */
  const dbltap = (target: cytoscape.SingularElementArgument) => {
    if (isGroup(target)) enter(target.data("groupId"));
  };
  /**
   * The canvas has no focusable nodes: the tapped node is the selected one. Enter enters it
   * (outside text fields and buttons); Escape closes the evidence, else leaves the last entered
   * group, else drops the focus, else clears the highlight.
   */
  const key = (event: KeyboardEvent, clearFocus: () => void) => {
    const selected = pinnedRef.current?.length === 1 ? pinnedRef.current[0] : undefined;
    if (event.key === "Enter") {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, button, textarea") !== null;
      if (!typing && selected) dbltap(selected);
      return;
    }
    if (event.key !== "Escape") return;
    const lastEntered = [...expansionsRef.current.keys()].at(-1);
    if (evidenceRef.current) updateEvidence(null);
    else if (lastEntered !== undefined) leave(lastEntered);
    else if (focusRef.current === null) clearFocus();
    else updateFocus(null, "all");
  };
  const receiveSummary = (message: ArchitectureSummaryMessage) => {
    // Group ids and pages only hold for their revision; a stale mark or a rebuild of the same graph keeps them.
    if (summaryRef.current?.revision !== message.revision) reset();
    summaryRef.current = message;
    setSummary(message);
    setState(null);
  };
  const receiveDetail = ({ revision, detail }: ArchitectureGroupDetailMessage) => {
    if (revision !== summaryRef.current?.revision || !pendingRef.current.delete(detail.group.id)) return;
    const merged = mergeGroupDetail(expansionsRef.current, detail);
    updateExpansions(merged.expansions);
    setCapReached(merged.capReached);
  };
  const receiveEvidence = (page: ArchitectureEvidencePageMessage) => {
    const current = evidenceRef.current;
    // A page for another edge, revision or offset (a late answer, a double click) is dropped.
    if (!current || page.revision !== summaryRef.current?.revision || !sameEnds(current.ends, page)) return;
    if (page.page.offset !== current.pairs.length) return;
    updateEvidence({ ...current, pairs: [...current.pairs, ...page.pairs], total: page.page.total, nextOffset: page.page.nextOffset });
  };
  /** The id of the drawn group with this key (E2E driver). */
  const groupOf = (groupKey: string | undefined): number | undefined => {
    if (!groupKey) return undefined;
    const key = `${summaryRef.current?.context.communityMode}:${groupKey}`;
    return Array.from(cyRef.current?.nodes() ?? []).find((node) => !node.isChild() && node.data("key") === key)?.data("groupId");
  };
  /** E2E driver: selects the first edge of a group (its evidence opens), then clicks a row's source. */
  const controlEvidence = ({ evidenceOf, openEvidenceRow }: ArchitectureControlsMessage) => {
    const groupId = groupOf(evidenceOf);
    const touches = (edge: cytoscape.EdgeSingular) => edge.data("from") === groupId || edge.data("to") === groupId;
    const edge = Array.from(cyRef.current?.edges() ?? []).find((candidate) => candidate.data("from") !== candidate.data("to") && touches(candidate));
    if (groupId !== undefined && edge) showEvidence(edge);
    const row = openEvidenceRow === undefined ? undefined : evidenceRef.current?.pairs[openEvidenceRow];
    if (row) openFile(row.source);
  };
  /** E2E driver: the same actions as a user, groups named by key. */
  const control = (message: ArchitectureControlsMessage) => {
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
  };
  const receive = (message: ArchitectureExtensionMessage) => {
    switch (message.type) {
      case "architectureSummary":
        return receiveSummary(message);
      case "architectureState":
        return setState(message);
      case "architectureGroupDetail":
        return receiveDetail(message);
      case "architectureEvidencePage":
        return receiveEvidence(message);
      case "architectureRevisionChanged":
        reset();
        return post({ command: "architectureMounted" });
      case "architectureControls":
        return control(message);
    }
  };
  const actions = { tap, dbltap, key, openFile, moreEvidence, receive, overview, leave, updateFocus };
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
      style: buildArchitectureStylesheet(themeColors()),
      wheelSensitivity: 0.3,
      minZoom: 0.05,
      maxZoom: 5,
    });
    const pinned = () => pinnedRef.current ?? cy.collection();
    const clearFocus = () => {
      pinnedRef.current = null;
      setQuery("");
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
    const handleKeyDown = (event: KeyboardEvent): void => actionsRef.current.key(event, clearFocus);
    window.addEventListener("keydown", handleKeyDown);
    cyRef.current = cy;

    // Re-fit when the view is resized (same pattern as CytoscapeGraph). Debounced so a
    // live drag does not thrash; the layout is not re-run, only the viewport.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const handleResize = (): void => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        cy.resize();
        cy.fit(undefined, 30);
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
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !summary) return;
    const previous = renderedRef.current.summary;
    const freshRevision = previous?.revision !== summary.revision;
    if (freshRevision) filePositions.clear();
    // A page, a collapse or a stale mark redraws the same graph: keep what was tapped.
    const pinnedIds = new Set(freshRevision ? [] : (pinnedRef.current?.map((element) => element.id()) ?? []));
    const elements = toArchitectureElements(summary, expansions);
    cy.elements().remove();
    cy.add(elements);
    pinnedRef.current = pinnedIds.size > 0 ? cy.elements().filter((element) => pinnedIds.has(element.id())) : null;
    renderedRef.current = { summary, ...countRendered(elements), visibleGroups: 0 };
    const groups = cy.nodes().filter((node) => !node.isChild());
    const finish = (fit: boolean) => {
      settleLayout(cy, groups);
      if (fit) cy.fit(undefined, 30);
      if (previous === summary) return;
      postMessageRef.current({
        command: "architectureRendered",
        revision: summary.revision,
        renderedGroups: groups.length,
        renderedGroupEdges: cy.edges().length,
        communityMode: summary.context.communityMode,
        stale: summary.stale,
        ...measureLayout(groups),
      });
    };
    if (!restorePositions(cy, groups)) {
      // ponytail: one new or resized group re-runs the whole layout; pin the known ones
      // (fcose fixedNodeConstraint) if users miss their picture after small edits.
      const layout = cy.layout(ARCHITECTURE_FCOSE_LAYOUT as cytoscape.LayoutOptions);
      layout.on("layoutstop", () => finish(true));
      layout.run();
      return;
    }
    placeNewFiles(cy, filePositions, (group) => savedLayout.get(group.data("key")) ?? { x: 0, y: 0 });
    // Only a new revision re-fits: a page, a collapse or a stale mark keeps the viewport.
    finish(freshRevision);
  }, [summary, expansions]);

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
    if (fit !== null) {
      cy.fit(fit === "enter" ? group : shown, 30);
      fitRef.current = null;
    }
  }, [summary, expansions, focusId]);

  // Before the highlight effects, so their report stays the last message of a render.
  useEffect(() => {
    if (!summary) return;
    const { renderedFiles, groupLevelEdges, visibleGroups } = renderedRef.current;
    const focused = focusId === 0 ? "" : summary.groups.find((group) => group.id === focusId)?.key;
    postMessageRef.current({
      command: "architectureDetailRendered",
      expandedGroups: expansions.size,
      expandedFileCount: [...expansions.values()].reduce((total, expansion) => total + expansion.total, 0),
      renderedFiles,
      groupLevelEdges,
      visibleGroups,
      focusedGroup: focusId === null ? undefined : focused,
      capReached,
      evidence: evidence?.total === undefined
        ? undefined
        : { edgeCount: evidence.edgeCount, total: evidence.total, shown: evidence.pairs.length, firstSource: evidence.pairs[0]?.source },
    });
  }, [summary, expansions, evidence, capReached, focusId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !summary) return;
    setShownEdges(applyMinImports(cy, minImports));
    showFocus(cy, pinnedRef.current ?? cy.collection(), postMessageRef.current);
  }, [summary, expansions, minImports]);

  // A new revision finds again; a stale mark or a page keeps what is pinned.
  const revision = summary?.revision;
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || revision === undefined) return;
    const matches = findGroups(cy, query);
    pinnedRef.current = matches;
    showFocus(cy, matches, postMessageRef.current);
    if (matches.nonempty()) cy.center(matches);
  }, [revision, query]);

  const refresh = () => postMessageRef.current({ command: "architectureRefresh" });
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      {state && <StatePanel state={state} onRetry={refresh} />}
      {!state && summary && (
        <>
          <SummaryHeader summary={summary} onRefresh={refresh} />
          <GraphControls
            summary={summary}
            shownEdges={shownEdges}
            query={query}
            onQuery={setQuery}
            minImports={minImports}
            onMinImports={setMinImports}
            capReached={capReached}
          />
          <Breadcrumb
            summary={summary}
            expansions={expansions}
            focusId={focusId}
            onOverview={() => actionsRef.current.overview()}
            onFocus={(groupId) => actionsRef.current.updateFocus(groupId, "enter")}
            onLeave={(groupId) => actionsRef.current.leave(groupId)}
          />
        </>
      )}
      <div style={{ position: "relative", flex: 1, minHeight: 0, visibility: state ? "hidden" : "visible" }}>
        <div ref={containerRef} data-testid="architecture-graph" style={{ position: "absolute", inset: 0 }} />
        {!state && evidence && (
          <EvidencePanel
            evidence={evidence}
            onOpen={(relativePath) => actionsRef.current.openFile(relativePath)}
            onMore={() => actionsRef.current.moreEvidence()}
            onClose={() => updateEvidence(null)}
          />
        )}
      </div>
    </div>
  );
}
