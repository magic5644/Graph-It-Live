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

/** The diagram choices of the CLI, MCP and LM tool; kept here, free of elkjs, for the MCP schemas. */
export const DIAGRAM_VIEWS = ["units", "folder", "matrix"] as const;
/** `diagram-spec`: the level's data as JSON (diagramSpec.ts), for an agent diagram skill. */
export const DIAGRAM_FORMATS = ["svg", "html", "diagram-spec"] as const;

/** The file a diagram goes to when none is named. */
export const defaultDiagramFile = (format: (typeof DIAGRAM_FORMATS)[number]) =>
  format === "diagram-spec" ? "architecture.diagram-spec.json" : `architecture.${format}`;
export const DIAGRAM_THEMES = ["light", "dark"] as const;

export type DiagramTheme = (typeof DIAGRAM_THEMES)[number];
export type DiagramView = (typeof DIAGRAM_VIEWS)[number];

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
    error: "#cf222e",
  },
  dark: {
    background: "#0d1117",
    surface: "#161b22",
    text: "#e6edf3",
    muted: "#8d96a0",
    line: "#6e7681",
    accent: "#f0883e",
    error: "#ff7b72",
  },
};
