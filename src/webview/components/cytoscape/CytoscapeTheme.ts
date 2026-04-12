/**
 * CytoscapeTheme — Cytoscape.js CSS-like style objects for the call graph webview.
 *
 * Colors are derived exclusively from LANGUAGE_COLORS (no hardcoded hex values for
 * language colors). Shape and edge styles implement the SBGN-inspired subset from
 * research.md Decision 5.
 *
 * SPEC: specs/001-live-call-graph/research.md — Decision 5
 * DATA MODEL: specs/001-live-call-graph/data-model.md
 */

import cytoscape from "cytoscape";
import { LANGUAGE_COLORS } from "../../../shared/constants";

// cytoscape uses `export =` so we access types via namespace
type CyStylesheet = cytoscape.StylesheetStyle | cytoscape.StylesheetCSS;

/** Cycle highlight color — red accent aligned with ReactFlow cycle color (#ff4d4d) */
const CYCLE_COLOR = "#ff4d4d";

/** Fallback node color when language is unrecognised */
const UNKNOWN_COLOR = LANGUAGE_COLORS.unknown ?? "#6b6b6b";

/** Compound (folder group) background opacity */
const COMPOUND_BG_OPACITY = 0.08;

// ---------------------------------------------------------------------------
// Theme-aware color palettes
// ---------------------------------------------------------------------------

interface ThemeColors {
  /** Node label text */
  nodeText: string;
  /** Text outline on nodes (helps readability against node fill) */
  nodeTextOutline: string;
  /** Parent compound label color */
  parentLabel: string;
  /** Folder compound label color */
  folderLabel: string;
  /** File compound label color */
  fileLabel: string;
  /** Compound background base color */
  compoundBg: string;
  /** Compound border color */
  compoundBorder: string;
  /** Folder compound border color */
  folderBorder: string;
  /** Selection/root border highlight */
  selectionBorder: string;
  /** Default edge color */
  edgeColor: string;
  /** Lateral edge color */
  lateralEdge: string;
}

const DARK_THEME: ThemeColors = {
  nodeText: "#ffffff",
  nodeTextOutline: UNKNOWN_COLOR,
  parentLabel: "#cccccc",
  folderLabel: "#e0e0e0",
  fileLabel: "#b0b0b0",
  compoundBg: "#ffffff",
  compoundBorder: "#888888",
  folderBorder: "#aaaaaa",
  selectionBorder: "#ffffff",
  edgeColor: "#d4d4d4",
  lateralEdge: "#aaaaaa",
};

const LIGHT_THEME: ThemeColors = {
  nodeText: "#1a1a1a",
  nodeTextOutline: "#e0e0e0",
  parentLabel: "#555555",
  folderLabel: "#333333",
  fileLabel: "#555555",
  compoundBg: "#000000",
  compoundBorder: "#999999",
  folderBorder: "#777777",
  selectionBorder: "#333333",
  edgeColor: "#666666",
  lateralEdge: "#888888",
};

// ---------------------------------------------------------------------------
// Node shape per symbol type
// ---------------------------------------------------------------------------

const SYMBOL_SHAPES: ReadonlyArray<[string, string]> = [
  ["class", "ellipse"],
  ["function", "round-rectangle"],
  ["method", "round-rectangle"],
  ["variable", "diamond"],
  ["interface", "hexagon"],
  ["type", "parallelogram"],
];

// ---------------------------------------------------------------------------
// Language entries: [langKey, fillColor]
// ---------------------------------------------------------------------------

const LANG_COLORS: ReadonlyArray<[string, string]> = [
  ["typescript", LANGUAGE_COLORS.typescript ?? UNKNOWN_COLOR],
  ["javascript", LANGUAGE_COLORS.javascript ?? UNKNOWN_COLOR],
  ["python", LANGUAGE_COLORS.python ?? UNKNOWN_COLOR],
  ["rust", LANGUAGE_COLORS.rust ?? UNKNOWN_COLOR],
  ["csharp", LANGUAGE_COLORS.csharp ?? UNKNOWN_COLOR],
  ["go", LANGUAGE_COLORS.go ?? UNKNOWN_COLOR],
  ["java", LANGUAGE_COLORS.java ?? UNKNOWN_COLOR],
];

// ---------------------------------------------------------------------------
// Stylesheet builder
// ---------------------------------------------------------------------------

/**
 * Build the full Cytoscape stylesheet for the call graph.
 *
 * @param isDark — `true` for dark/high-contrast themes, `false` for light themes.
 *                 Defaults to `true` (dark theme).
 *
 * The returned array should be passed directly to `cytoscape({ style: ... })`.
 */
export function buildCallGraphStylesheet(isDark = true): CyStylesheet[] {
  const t = isDark ? DARK_THEME : LIGHT_THEME;
  const shapeStyles = SYMBOL_SHAPES.map(([symbolType, shape]) => ({
    selector: `node[type="${symbolType}"]`,
    style: { shape } as Record<string, unknown>,
  }));

  const langStyles = LANG_COLORS.flatMap(([lang, color]) => {
    const colorStyle = {
      selector: `node[lang="${lang}"]`,
      style: { "background-color": color, "border-color": color },
    };
    if (lang !== "javascript") {
      return [colorStyle];
    }
    return [
      colorStyle,
      {
        selector: `node[lang="${lang}"]`,
        style: { color: "#333333", "text-outline-color": color },
      },
    ];
  });

  return [
    // Base node style — use default z-ordering (auto compound depth).
    // Edges use z-index-compare:manual so they render AFTER all auto-depth
    // elements (i.e. on top of compound backgrounds).
    {
      selector: "node",
      style: {
        label: "data(name)",
        "text-valign": "center",
        "text-halign": "center",
        "font-size": "13px",
        "font-weight": "bold",
        "font-family":
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        color: t.nodeText,
        "text-outline-width": 2,
        "text-outline-color": isDark ? UNKNOWN_COLOR : t.nodeTextOutline,
        width: "label",
        height: "label",
        padding: "10px",
        "border-width": 2,
        "border-color": UNKNOWN_COLOR,
        "background-color": UNKNOWN_COLOR,
      },
    },
    {
      selector: "node[?isRoot]",
      style: {
        "background-color": "#f5a623",
        "border-width": 4,
        "border-style": "solid",
        "border-color": t.selectionBorder,
        "font-weight": "bold",
        color: "#1a1a1a",
        "text-outline-color": "#f5a623",
        "text-outline-width": 2,
        // Glow effect
        "shadow-blur": 18,
        "shadow-color": "#f5a623",
        "shadow-opacity": 0.85,
        "shadow-offset-x": 0,
        "shadow-offset-y": 0,
      },
    },
    {
      selector: `node[type="interface"], node[type="type"]`,
      style: { "background-opacity": 0.15 },
    },
    {
      selector: ":parent",
      style: {
        shape: "round-rectangle",
        "background-opacity": COMPOUND_BG_OPACITY,
        "background-color": t.compoundBg,
        "border-style": "dashed",
        "border-color": t.compoundBorder,
        "border-width": 1,
        "text-valign": "top",
        "text-halign": "center",
        "font-size": "11px",
        "font-weight": "bold",
        color: t.parentLabel,
        label: "data(label)",
        padding: "20px",
      } as Record<string, unknown>,
    },
    // Folder-level compound: prominent label with full path
    {
      selector: `node[type="compound"][compoundLevel="folder"]`,
      style: {
        "border-width": 2,
        "border-color": t.folderBorder,
        "border-style": "dashed",
        "font-size": "13px",
        "font-weight": "bold",
        "font-style": "italic",
        color: t.folderLabel,
        "text-outline-width": 0,
        "text-margin-y": -8,
        padding: "28px",
      },
    },
    // File-level compound: clear filename label
    {
      selector: `node[type="compound"][compoundLevel="file"]`,
      style: {
        "border-width": 1,
        "border-color": t.compoundBorder,
        "border-style": "solid",
        "background-opacity": 0.08,
        "font-size": "12px",
        "font-weight": "bold",
        color: t.fileLabel,
        "text-outline-width": 0,
        "text-margin-y": -4,
        padding: "18px",
      },
    },
    {
      selector: "edge",
      style: {
        width: 2,
        "line-color": t.edgeColor,
        "target-arrow-color": t.edgeColor,
        "target-arrow-shape": "triangle",
        "arrow-scale": 1.1,
        "curve-style": "bezier",
        opacity: 1,
        // Use manual z-index so compound depth doesn't push edges behind
        // parent backgrounds. Combined with orphan z-compound-depth on
        // :parent, edges always render above compound backgrounds.
        "z-index": 999,
        "z-index-compare": "manual",
      },
    },
    // Call order label on CALLS edges — shows the sequence number
    {
      selector: "edge[callOrder]",
      style: {
        label: "data(callOrder)",
        "font-size": "10px",
        "font-weight": "bold",
        "font-family":
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        color: isDark ? "#e0e0e0" : "#444444",
        "text-background-color": isDark ? "#1e1e1e" : "#ffffff",
        "text-background-opacity": 0.85,
        "text-background-padding": "3px",
        "text-background-shape": "roundrectangle",
        "text-margin-y": -10,
        "text-rotation": "autorotate",
      } as Record<string, unknown>,
    },
    // T037: directional edge colouring relative to root node
    {
      selector: `edge[direction="outgoing"]`,
      style: {
        "line-color": "#4fc3f7",
        "target-arrow-color": "#4fc3f7",
        width: 2.5,
      },
    },
    {
      selector: `edge[direction="incoming"]`,
      style: {
        "line-color": "#ffb74d",
        "target-arrow-color": "#ffb74d",
        width: 2.5,
      },
    },
    {
      selector: `edge[direction="lateral"]`,
      style: {
        "line-color": t.lateralEdge,
        "target-arrow-color": t.lateralEdge,
        "line-style": "dashed",
        width: 2,
      },
    },
    {
      selector: `edge[typeRelation="CALLS"]`,
      style: { "line-style": "solid", "target-arrow-shape": "triangle" },
    },
    {
      selector: `edge[typeRelation="INHERITS"]`,
      style: {
        "line-style": "solid",
        "target-arrow-shape": "triangle",
        "target-arrow-fill": "filled",
        "line-color": "#5a9cf8",
        "target-arrow-color": "#5a9cf8",
      },
    },
    {
      selector: `edge[typeRelation="IMPLEMENTS"]`,
      style: {
        "line-style": "dashed",
        "target-arrow-shape": "triangle",
        "target-arrow-fill": "open",
        "line-color": "#9b59b6",
        "target-arrow-color": "#9b59b6",
      },
    },
    {
      selector: `edge[typeRelation="USES"]`,
      style: {
        "line-style": "dotted",
        "target-arrow-shape": "none",
        "line-color": "#888888",
      },
    },
    {
      selector: `edge[?isCyclic]`,
      style: {
        "line-style": "dashed",
        "line-color": CYCLE_COLOR,
        "target-arrow-color": CYCLE_COLOR,
        width: 2,
        // Cyclic overrides direction colours
        "z-index": 1000,
      },
    },
    // T036: drag cursor feedback
    {
      selector: "node[type != 'compound']",
      style: { cursor: "pointer" } as Record<string, unknown>,
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 3,
        "border-color": t.selectionBorder,
        "border-style": "solid",
      },
    },
    {
      selector: "edge:selected",
      style: { width: 3 },
    },
    ...shapeStyles,
    ...langStyles,
  ];
}
