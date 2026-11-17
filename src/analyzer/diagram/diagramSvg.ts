/**
 * Draws a laid-out architecture diagram (architectureDiagram.ts) as a bare SVG in one theme, or
 * as one self-contained HTML page whose SVG follows `prefers-color-scheme`. The output holds no
 * script, no external URL and no foreignObject; every label is escaped.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { drawnKinds, edgeLegendKind, legendLayout, legendNotes, sanitizeText, type DiagramLayout, type LegendOptions, type PlacedEdge } from "./architectureDiagram";
import type { MatrixLayout } from "./diagramMatrix";
import { edgeStyle, FONT_MONO, LEGEND, LEGEND_KINDS, legendDash, PALETTES, SIZES, type DiagramTheme, type LegendKind, type Palette } from "./diagramStyle";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text safe inside an XML element or a quoted attribute. */
export const escapeXml = (text: string) => sanitizeText(text).replaceAll(/[&<>"']/g, (char) => ENTITIES[char]);

/** One class per shared legend style (diagramStyle LEGEND): its colour, and its dashes on edges and cycle blocks. */
const styleClass = (kind: LegendKind) => `s-${kind}`;

/** The palette as CSS custom properties of `selector`. */
const variables = (selector: string, palette: Palette) =>
  `${selector}{--bg:${palette.background};--surface:${palette.surface};--text:${palette.text};--muted:${palette.muted};` +
  `--line:${palette.line};--accent:${palette.accent};--cycle:${palette.cycle};--error:${palette.error}}`;

const CLASSES = [
  `svg{font-family:${FONT_MONO}}`,
  ".bg{fill:var(--bg)}",
  `.node{fill:var(--surface);stroke:var(--line);stroke-width:${SIZES.hairline}px}`,
  `.label{fill:var(--text);font-size:${SIZES.label}px}`,
  `.meta{fill:var(--muted);font-size:${SIZES.meta}px}`,
  `.title{fill:var(--text);font-size:${SIZES.title}px;font-weight:600}`,
  `.caption{fill:var(--muted);font-size:${SIZES.caption}px}`,
  ".edge{fill:none;stroke-linejoin:round}",
  ...LEGEND_KINDS.map((kind) => {
    const dash = legendDash(kind);
    return `.${styleClass(kind)}{stroke:var(--${LEGEND[kind].colour})${dash ? `;stroke-dasharray:${dash}` : ""}}.head-${kind}{fill:var(--${LEGEND[kind].colour})}`;
  }),
  `.cell{fill:var(--surface);stroke-width:${SIZES.hairline}px}.diagonal{fill:var(--line);fill-opacity:0.18}`,
  `.frame{fill:none;stroke:var(--line);stroke-width:${SIZES.hairline}px}`,
  `.cycle{fill:none;stroke-width:${SIZES.hairline}px}.cut{fill:none;stroke-width:2px}`,
  // A halo keeps the title readable where an edge crosses it.
  `.cycle-title{fill:var(--cycle);font-size:${SIZES.meta}px;paint-order:stroke;stroke:var(--bg);stroke-width:3px}`,
].join("");

const markers = LEGEND_KINDS.map((kind) =>
  `<marker id="arrow-${kind}" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">` +
  `<path class="head-${kind}" d="M0 0L8 4L0 8z"/></marker>`).join("");

const text = (x: number, y: number, className: string, content: string) =>
  `<text class="${className}" x="${x}" y="${y}">${escapeXml(content)}</text>`;

function edgeMarkup(edge: PlacedEdge): string {
  const kind = edgeLegendKind(edge);
  const path = edge.points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
  const rules = edge.rules.length > 0 ? `, breaks ${edge.rules.join(", ")}` : "";
  const typeOnly = edge.typeOnlyEdgeCount ? `, ${edge.typeOnlyEdgeCount} type-only` : "";
  const title = `${edge.from} → ${edge.to}: ${edge.fileEdgeCount} file pairs (${edge.kind === "cycle" ? LEGEND[edgeStyle("cycle", edge.cycleKind)].text : edge.kind}${typeOnly}${rules})`;
  return `<path class="edge ${styleClass(kind)}" d="${path}" stroke-width="${edge.stroke}" marker-end="url(#arrow-${kind})"><title>${escapeXml(title)}</title></path>`;
}

function legendMarkup(layout: DiagramLayout | MatrixLayout, options: LegendOptions): string {
  const { items } = legendLayout(options);
  const y = layout.height - SIZES.margin - 12;
  const samples = items.map(({ kind, text: label, x }) => {
    const left = SIZES.margin + x;
    const stroke = kind === "weight" ? "down" : kind;
    const width = kind === "weight" || kind === "cut" ? 3 : SIZES.hairline;
    return `<path class="edge ${styleClass(stroke)}" d="M${left} ${y - 4}L${left + 24} ${y - 4}" stroke-width="${width}"/>${text(left + 32, y, "caption", label)}`;
  });
  const notes = legendNotes(layout.text);
  const noteMarkup = notes.map((note, index) => text(SIZES.margin, y - 20 * (notes.length - index), "caption", note));
  return `<g class="legend">${noteMarkup.join("")}${samples.join("")}</g>`;
}

/** The graph: cycle blocks, edges, then nodes on top. */
function graphMarkup(layout: DiagramLayout): string[] {
  const pad = SIZES.nodePaddingX;
  const cycles = layout.cycles.map((cycle) => {
    const kind = edgeStyle("cycle", cycle.kind);
    return `<rect class="cycle ${styleClass(kind)}" x="${cycle.x}" y="${cycle.y}" width="${cycle.width}" height="${cycle.height}" rx="${SIZES.radius}"/>` +
      text(cycle.x + pad, cycle.y + 18, "cycle-title", `${LEGEND[kind].text} · ${cycle.size}`);
  });
  const nodes = layout.nodes.map((node) =>
    `<g><title>${escapeXml(node.key + ": " + node.meta)}</title>` +
    `<rect class="node" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${SIZES.radius}"/>` +
    `${text(node.x + pad, node.y + 18, "label", node.text)}${text(node.x + pad, node.y + 34, "meta", node.meta)}</g>`);
  return [...cycles, ...layout.edges.map(edgeMarkup), ...nodes, legendMarkup(layout, { kinds: drawnKinds(layout.edges, layout.cycles) })];
}

/** The matrix: column numbers, numbered row labels, the frame, the cells, cycle outlines on top. */
function matrixMarkup(layout: MatrixLayout): string[] {
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2 + 4;
  const cellSize = layout.grid.height / Math.max(1, layout.rows.length);
  return [
    ...layout.columns.map((column) => text(column.x + 4, column.y + 14, "meta", column.text)),
    ...layout.rows.map((row) => text(row.x, middle({ y: row.y, height: cellSize }), "label", row.text)),
    `<rect class="frame" x="${layout.grid.x}" y="${layout.grid.y}" width="${layout.grid.width}" height="${layout.grid.height}"/>`,
    ...layout.cells.map((cell) =>
      `<g class="matrix-cell" data-from="${escapeXml(cell.from)}" data-to="${escapeXml(cell.to)}"><title>${escapeXml(cell.title)}</title>` +
      `<rect class="cell ${cell.kind === "diagonal" ? "diagonal" : styleClass(cell.kind)}" x="${cell.x + 1}" y="${cell.y + 1}" width="${cell.width - 2}" height="${cell.height - 2}"/>` +
      (cell.cut ? `<rect class="cut ${styleClass("cut")}" x="${cell.x + 2}" y="${cell.y + 2}" width="${cell.width - 4}" height="${cell.height - 4}"/>` : "") +
      `${text(cell.x + 4, middle(cell), "meta", String(cell.count))}</g>`),
    ...layout.cycles.map((cycle) =>
      `<rect class="cycle ${styleClass(edgeStyle("cycle", cycle.kind))}" x="${cycle.x}" y="${cycle.y}" width="${cycle.width}" height="${cycle.height}"/>`),
    legendMarkup(layout, { kinds: layout.kinds, weight: false }),
  ];
}

function svgMarkup(layout: DiagramLayout | MatrixLayout, style: string): string {
  const { width, height, text: lines } = layout;
  const top = SIZES.margin;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-desc">`,
    `<title id="diagram-title">${escapeXml(lines.title)}</title>`,
    `<desc id="diagram-desc">${escapeXml(lines.caption + ". " + lines.counts + ".")}</desc>`,
    style === "" ? "" : `<style>${style}</style>`,
    `<defs>${markers}</defs>`,
    `<rect class="bg" width="${width}" height="${height}"/>`,
    text(SIZES.margin, top + 16, "title", lines.title),
    text(SIZES.margin, top + 36, "caption", lines.caption),
    text(SIZES.margin, top + 54, "caption", lines.counts),
    ...("cells" in layout ? matrixMarkup(layout) : graphMarkup(layout)),
    "</svg>",
  ].join("\n");
}

/** A bare SVG in one theme: what a README, a wiki or a slide embeds. */
export function renderDiagramSvg(layout: DiagramLayout | MatrixLayout, theme: DiagramTheme = "light"): string {
  return `${svgMarkup(layout, variables("svg", PALETTES[theme]) + CLASSES)}\n`;
}

/** One self-contained HTML page, light or dark with the reader's `prefers-color-scheme`; its CSP allows inline styles only. */
export function renderDiagramHtml(layout: DiagramLayout | MatrixLayout): string {
  const style = [
    variables(":root", PALETTES.light),
    `@media (prefers-color-scheme: dark){${variables(":root", PALETTES.dark)}}`,
    "body{margin:0;background:var(--bg)}",
    CLASSES,
  ].join("");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeXml(layout.text.title)}</title>`,
    `<style>${style}</style>`,
    "</head>",
    "<body>",
    svgMarkup(layout, ""),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
