/**
 * The one editorial style of the static architecture diagrams: system fonts (no network), a
 * neutral palette with one accent for what the reader must see first (cycles, upward edges) and
 * an error colour for rule violations, every length on a 4 px grid, 1 px hairlines, no shadow.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

export const GRID = 4;

/** Rounds a length up to the grid. */
export const snap = (length: number) => Math.ceil(length / GRID) * GRID;

/** Every text is set in a system monospace face: its width is known without font metrics, so it always fits its box. */
export const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export const SIZES = {
  label: 12,
  meta: 11,
  title: 16,
  caption: 12,
  /** Upper bound of a monospace advance, in em (Menlo/DejaVu 0.602, Consolas 0.55, Courier 0.6). */
  monoAdvance: 0.62,
  nodeHeight: 44,
  nodePaddingX: 12,
  minNodeWidth: 96,
  /** Longer labels end with "…": a box never grows past this. */
  maxLabelChars: 32,
  margin: 24,
  headerHeight: 80,
  legendHeight: 40,
  hairline: 1,
  maxStroke: 4,
  radius: 4,
} as const;

/** ELK padding of a cycle block, on the grid; its top leaves room for the block's title. */
export const CYCLE_PADDING = "[top=28,left=12,bottom=12,right=12]";

/** Most steps a flow diagram draws: past it the boxes no longer fit a screen (#793). */
export const MAX_FLOW_STEPS = 12;

/** Bounds of a sequence diagram (#798): its default depth and messages, and the most messages and lifelines it draws. */
export const DEFAULT_SEQUENCE_DEPTH = 3;
export const DEFAULT_SEQUENCE_MESSAGES = 30;
export const MAX_SEQUENCE_MESSAGES = 60;
export const MAX_SEQUENCE_PARTICIPANTS = 12;

/** The diagram choices of the CLI, MCP and LM tool; kept here, free of elkjs, for the MCP schemas. */
/**
 * `flow`: the call flow of one entry symbol (flowDiagram.ts); `sequence`: its calls in order (sequenceDiagram.ts);
 * the others draw one architecture level.
 */
export const DIAGRAM_VIEWS = ["units", "folder", "matrix", "flow", "sequence"] as const;
/** `diagram-spec`: the level's data as JSON (diagramSpec.ts), for an agent diagram skill; `mermaid`: a sequence only. */
export const DIAGRAM_FORMATS = ["svg", "html", "diagram-spec", "mermaid"] as const;

/** The file a diagram goes to when none is named. */
export function defaultDiagramFile(format: (typeof DIAGRAM_FORMATS)[number], view?: DiagramRequestView) {
  const name = view === "flow" || view === "sequence" ? view : "architecture";
  if (format === "diagram-spec") return `${name}.diagram-spec.json`;
  return format === "mermaid" ? `${name}.mmd` : `${name}.${format}`;
}
export const DIAGRAM_THEMES = ["light", "dark"] as const;

export type DiagramTheme = (typeof DIAGRAM_THEMES)[number];
export type DiagramRequestView = (typeof DIAGRAM_VIEWS)[number];
/** The architecture levels: every view but flow and sequence. */
export type DiagramView = Exclude<DiagramRequestView, "flow" | "sequence">;

/** The level a request names: a folder alone means its groups, and keys use "/" on every OS (a Windows user may type app\core). */
export function diagramLevel(view: DiagramView | undefined, folder: string | undefined) {
  const key = folder?.replaceAll("\\", "/");
  return { view: view ?? (key === undefined ? "units" : "folder"), folder: key } as const;
}

export interface Palette {
  background: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  /** Cycles, by kind: runtime solid, type-only and lazy dashed (#745). */
  cycle: string;
  error: string;
}

export const PALETTES: Record<DiagramTheme, Palette> = {
  light: {
    background: "#ffffff",
    surface: "#f6f7f9",
    text: "#1f2328",
    muted: "#656d76",
    line: "#8c959f",
    accent: "#d4560b",
    cycle: "#8250df",
    error: "#cf222e",
  },
  dark: {
    background: "#0d1117",
    surface: "#161b22",
    text: "#e6edf3",
    muted: "#8d96a0",
    line: "#6e7681",
    accent: "#f0883e",
    cycle: "#bc8cff",
    error: "#ff7b72",
  },
};

/**
 * The one visual vocabulary of the SVG diagrams and the init page (#745): each style's palette
 * colour, dash pattern (SVG stroke-dasharray) and legend text. A colour never tells two kinds
 * apart alone: the cycle kinds differ by their dashes too.
 */
export const LEGEND = {
  down: { colour: "line", text: "dependency" },
  upward: { colour: "accent", text: "upward" },
  cycle: { colour: "cycle", text: "runtime cycle" },
  "type-only": { colour: "cycle", dash: "2 3", text: "type-only cycle" },
  lazy: { colour: "cycle", dash: "8 4", text: "lazy cycle (import())" },
  cut: { colour: "cycle", text: "cell to cut" },
  error: { colour: "error", text: "breaks a rule" },
  accepted: { colour: "error", dash: "4 3", text: "accepted in baseline" },
  dead: { colour: "muted", dash: "4 3", text: "dead file" },
  // A node border, never an edge: a unit whose role no config declares (#776).
  "inferred-role": { colour: "line", dash: "3 3", text: "dashed border: role inferred" },
  // The flow diagram (#793): a node border, then its call lanes and the references.
  entry: { colour: "line", text: "thick border: entry" },
  main: { colour: "line", text: "main lane" },
  alternative: { colour: "line", dash: "6 3", text: "alternative lane" },
  "error-path": { colour: "error", text: "error lane" },
  reference: { colour: "line", dash: "1 3", text: "reference" },
  // The sequence diagram (#798): its calls, those made in a catch or except clause.
  call: { colour: "line", text: "call" },
  "catch-call": { colour: "error", text: "call in a catch" },
} as const satisfies Record<string, { colour: keyof Palette; dash?: string; text: string }>;

export type LegendKind = keyof typeof LEGEND;

/** Legend kinds in drawing order, the one order every legend lists them in. */
export const LEGEND_KINDS = Object.keys(LEGEND) as LegendKind[];

/** The dash pattern of a kind, or undefined for a solid line. */
export const legendDash = (kind: LegendKind): string | undefined => (LEGEND[kind] as { dash?: string }).dash;

/**
 * The style of an edge or a file pair: a broken rule outranks its cycle or upward kind; a cycle
 * is drawn by how it runs (buildArchitectureUnits' cycleKind), runtime when unknown.
 */
export function edgeStyle(
  kind: "down" | "upward" | "cycle",
  cycleKind: "runtime" | "type-only" | "lazy" | undefined,
  rules?: { broken: boolean; accepted?: boolean },
): LegendKind {
  if (rules?.broken) return rules.accepted ? "accepted" : "error";
  if (kind !== "cycle") return kind;
  return cycleKind === "type-only" || cycleKind === "lazy" ? cycleKind : "cycle";
}
