/**
 * ArchitectureGraph — the sidebar's Architecture view mode: collapsed groups and the
 * group edges between them, rendered with Cytoscape + fcose.
 *
 * Mounted only in architecture mode. On mount it posts `architectureMounted`, and the
 * extension answers with the cached summary or a build, so no message can arrive early.
 */

import cytoscape from "cytoscape";
import React, { useEffect, useRef, useState } from "react";
import type {
  ArchitectureExtensionMessage,
  ArchitectureStateMessage,
  ArchitectureSummaryMessage,
  ArchitectureWebviewCommand,
} from "../../../shared/architecture-types";
import { buildArchitectureStylesheet } from "../cytoscape/CytoscapeTheme";
import { ARCHITECTURE_FCOSE_LAYOUT, type LayoutBox, separateOverlaps, toArchitectureElements } from "./architectureElements";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fcose = require("cytoscape-fcose") as cytoscape.Ext;

cytoscape.use(fcose);

/**
 * Last position and size per group key, kept for the webview's lifetime (remounts
 * included), so Refresh or a communityMode round trip redraws the same picture.
 */
const savedLayout = new Map<string, LayoutBox>();

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

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ArchitectureExtensionMessage>) => {
      // Extension messages come from the webview's own vscode-webview:// origin (S2819).
      if (event.origin && !event.origin.startsWith("vscode-webview://") && event.origin !== "null") return;
      const message = event.data;
      if (message?.type === "architectureSummary") {
        setSummary(message);
        setState(null);
      } else if (message?.type === "architectureState") {
        setState(message);
      }
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
    cy.on("mouseover", "node, edge", (event) => {
      container.title = String(event.target.data("tooltip") ?? "");
    });
    cy.on("mouseout", "node, edge", () => {
      container.title = "";
    });
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
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !summary) return;
    cy.elements().remove();
    cy.add(toArchitectureElements(summary));
    const nodes = cy.nodes();
    const reused = nodes.every((node) => {
      const saved = savedLayout.get(node.data("key"));
      return saved?.width === node.data("width") && saved.height === node.data("height");
    });
    // ponytail: one new or resized group re-runs the whole layout; pin the known ones
    // (fcose fixedNodeConstraint) if users miss their picture after small edits.
    const layout = reused
      ? cy.layout({ name: "preset", positions: (node: cytoscape.NodeSingular) => savedLayout.get(node.data("key")) } as cytoscape.LayoutOptions)
      : cy.layout(ARCHITECTURE_FCOSE_LAYOUT as cytoscape.LayoutOptions);
    layout.on("layoutstop", () => {
      const boxes = nodes.map((node) => ({ node, ...node.position(), width: node.outerWidth(), height: node.outerHeight() }));
      separateOverlaps(boxes);
      for (const { node, x, y } of boxes) {
        node.position({ x, y });
        savedLayout.set(node.data("key"), { x, y, width: node.data("width"), height: node.data("height") });
      }
      cy.fit(undefined, 30);
      postMessageRef.current({
        command: "architectureRendered",
        revision: summary.revision,
        renderedGroups: nodes.length,
        renderedGroupEdges: cy.edges().length,
        communityMode: summary.context.communityMode,
        stale: summary.stale,
        ...measureLayout(nodes),
      });
    });
    layout.run();
  }, [summary]);

  const refresh = () => postMessageRef.current({ command: "architectureRefresh" });
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      {state && <StatePanel state={state} onRetry={refresh} />}
      {!state && summary && <SummaryHeader summary={summary} onRefresh={refresh} />}
      <div
        ref={containerRef}
        data-testid="architecture-graph"
        style={{ flex: 1, minHeight: 0, visibility: state ? "hidden" : "visible" }}
      />
    </div>
  );
}
