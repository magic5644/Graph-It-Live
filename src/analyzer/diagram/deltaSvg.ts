/**
 * Draws the architecture delta (#449) as one bare SVG: Before and After panels on the same grid, then
 * the ledger of every change. A status is told by its word and by a unique (border width, dash) pair;
 * the colour is secondary. The output holds no script, no external URL and no foreignObject; every
 * string, refs and unit names included, is untrusted and escaped.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureDeltaSource } from "../ReviewGateAnalyzer";
import { fitLabel, sanitizeText, textWidth } from "./architectureDiagram";
import { buildDeltaModel, headLabel, LEDGER_CELLS, layoutDelta, type DeltaEdge, type DeltaLayout, type DeltaPlacedNode, type DeltaStatus } from "./architectureDelta";
import { CLASSES, escapeXml, markers, text, variables } from "./diagramSvg";
import { DELTA, PALETTES, SIZES, snap, type DiagramTheme } from "./diagramStyle";

const GAP = 48;
const ROW = 18;
const LEGEND_WIDTH = 760;
/** Side by side only while the SVG stays at most this wide: a wider pair is stacked, Before above After (#843). */
const MAX_SIDE_BY_SIDE = 4000;

const DELTA_CSS = [
  ".dnode{fill:var(--surface)}",
  ".c-accent{stroke:var(--accent)}.c-line{stroke:var(--line)}.c-error{stroke:var(--error)}",
  ".ring{fill:none;stroke:var(--cycle);stroke-width:2px}",
  `.ledger{fill:var(--text);font-size:${SIZES.label}px}`,
  `.heading{fill:var(--text);font-size:${SIZES.label}px;font-weight:600}`,
].join("");

const dashAttr = (status: DeltaStatus) => {
  const { dash } = DELTA[status] as { dash?: string };
  return dash === undefined ? "" : ` stroke-dasharray="${dash}"`;
};
const signature = (status: DeltaStatus) => `${DELTA[status].width}:${(DELTA[status] as { dash?: string }).dash ?? "solid"}`;

/** Context is drawn muted; every change in the accent (colour is secondary: the word and the dash carry the status). */
const statusColour = (status: DeltaStatus) => (status === "UNCHANGED" ? "c-line" : "c-accent");

function nodeMarkup(node: DeltaPlacedNode, snapshot: "before" | "after"): string {
  const pad = SIZES.nodePaddingX;
  const colour = node.violations.new > 0 ? "c-error" : statusColour(node.status);
  const title = escapeXml(node.label + ": " + node.meta);
  // A new cycle exists only After, a resolved one only Before.
  const ringed = node.inCycle === "BOTH" || node.inCycle === (snapshot === "after" ? "ADDED" : "REMOVED");
  const ring = ringed ? `<rect data-role="ring" class="ring" x="${node.x - 4}" y="${node.y - 4}" width="${node.width + 8}" height="${node.height + 8}" rx="${SIZES.radius + 2}"/>` : "";
  return `<g data-object-id="${escapeXml(node.id)}" data-kind="unit" data-status="${node.status}" data-signature="${signature(node.status)}">` +
    `<title>${title}</title>${ring}` +
    `<rect data-role="bounds" class="dnode ${colour}" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${SIZES.radius}" stroke-width="${DELTA[node.status].width}"${dashAttr(node.status)}/>` +
    `${text(node.x + pad, node.y + 18, "label", node.text)}${text(node.x + pad, node.y + 34, "meta", node.meta)}</g>`;
}

/** The point halfway along the route, for the file-pair count. */
function middle(points: readonly { x: number; y: number }[]): { x: number; y: number } {
  const index = Math.floor((points.length - 1) / 2);
  const [a, b] = [points[index], points[Math.min(index + 1, points.length - 1)]];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4 };
}

function edgeMarkup(edge: DeltaEdge & { points: { x: number; y: number }[] }, snapshot: "before" | "after"): string {
  // A violation is red on the side where it exists: a resolved one in Before, a new or accepted one in After.
  const broken = snapshot === "before" ? edge.violation === "resolved" : edge.violation === "new" || edge.violation === "accepted";
  const context = edge.status === "UNCHANGED" ? "down" : "upward";
  const kind = broken ? "error" : context;
  const path = edge.points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
  const count = snapshot === "before" ? edge.pairs.before : edge.pairs.after;
  const rules = edge.rules.length > 0 ? "; " + edge.rules.join(", ") : "";
  const title = `${edge.status} ${edge.from} -> ${edge.to}${rules}`;
  const objectId = escapeXml(edge.from + "->" + edge.to);
  const label = count === undefined || edge.points.length === 0 ? "" : text(middle(edge.points).x, middle(edge.points).y, "edge-label", String(count));
  return `<path data-object-id="${objectId}" data-kind="edge" data-from="${escapeXml(edge.from)}" data-to="${escapeXml(edge.to)}" data-status="${edge.status}" class="edge s-${kind}" d="${path}" ` +
    `stroke-width="${DELTA[edge.status].width}"${dashAttr(edge.status)} marker-end="url(#arrow-${kind})"><title>${escapeXml(title)}</title></path>${label}`;
}

/** One panel: the units present on that side and the edges whose two ends are both in it. */
function panelMarkup(layout: DeltaLayout, snapshot: "before" | "after", x: number, y: number, heading: string): string {
  const absent: DeltaStatus = snapshot === "before" ? "ADDED" : "REMOVED";
  const nodes = layout.nodes.filter((node) => node.status !== absent);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = layout.edges.filter((edge) => edge.status !== absent && ids.has(edge.from) && ids.has(edge.to));
  return text(x, y - 12, "heading", heading) +
    `<g data-snapshot="${snapshot}" data-grid="${layout.width}x${layout.height}" transform="translate(${x} ${y})">` +
    `${edges.toSorted((left, right) => Number(right.status === "UNCHANGED") - Number(left.status === "UNCHANGED")).map((edge) => edgeMarkup(edge, snapshot)).join("")}${nodes.map((node) => nodeMarkup(node, snapshot)).join("")}</g>`;
}

const STATUS_WORDS: [DeltaStatus, string][] = [
  ["ADDED", "ADDED"], ["REMOVED", "REMOVED"], ["CHANGED", "CHANGED"], ["RENAMED", "RENAMED"], ["REWIRED", "REWIRED"], ["UNCHANGED", "UNCHANGED (context unit or edge)"],
];

function legendMarkup(y: number): string {
  let x = SIZES.margin;
  const samples = STATUS_WORDS.map(([status, word]) => {
    const colour = statusColour(status);
    const sample = `<path class="edge ${colour}" d="M${x} ${y - 4}L${x + 28} ${y - 4}" stroke-width="${DELTA[status].width}"${dashAttr(status)}/>${text(x + 36, y, "caption", word)}`;
    x += 36 + textWidth(word, SIZES.caption) + 24;
    return sample;
  });
  return `<g class="legend">${samples.join("")}</g>`;
}

const NOTE = "Red border or edge: breaks a rule. Purple ring: member of a cycle. Number on an edge: file pairs on that side. REWIRED: connections changed, not content.";

/** A bare SVG of the delta in one theme. Pure: same layout, same bytes. */
export function renderDeltaSvg(layout: DeltaLayout, theme: DiagramTheme = "light"): string {
  const { model } = layout;
  const margin = SIZES.margin;
  const [first, ...more] = model.counts.split(" · ");
  const countLines = [first, more.join(" · ")];
  const panel = Math.max(layout.width, textWidth(`Before · ${model.refs.base}`, SIZES.label), textWidth(`After · ${headLabel(model.refs.head)}`, SIZES.label));
  const footer = [...model.cut, ...model.warnings.map((warning) => `warning: ${warning}`)].map((line) => fitLabel(line, LEDGER_CELLS));
  const ledger = model.ledger.map((row) => ({ ...row, text: fitLabel(row.text, LEDGER_CELLS) }));
  const lines = [...footer, ...ledger.map((row) => row.text), NOTE, ...countLines];
  const stacked = 2 * (panel + margin) + GAP > MAX_SIDE_BY_SIDE;
  const width = snap(margin * 2 + Math.max(stacked ? panel : 2 * panel + GAP, ...lines.map((line) => textWidth(line, SIZES.caption)), LEGEND_WIDTH));
  const top = margin + 84;
  const originY = top + 28;
  const panelHeight = Math.max(layout.height, SIZES.nodeHeight);
  const afterY = stacked ? originY + panelHeight + 56 : originY;
  const ledgerY = afterY + panelHeight + 40;
  const footerY = ledgerY + 24 + ROW * ledger.length + 16;
  const height = snap(footerY + ROW * (footer.length + 1) + 16 + SIZES.legendHeight);
  const title = `Architecture delta · ${fitLabel(model.refs.base, 48)} -> ${fitLabel(headLabel(model.refs.head), 48)}`;
  const style = variables("svg", PALETTES[theme]) + CLASSES + DELTA_CSS;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-desc" data-diagram="architecture-delta">`,
    `<title id="diagram-title">${escapeXml(title)}</title>`,
    `<desc id="diagram-desc">${escapeXml(model.counts)}</desc>`,
    `<style>${style}</style>`,
    `<defs>${markers}</defs>`,
    `<rect class="bg" width="${width}" height="${height}"/>`,
    text(margin, margin + 16, "title", title),
    text(margin, margin + 36, "caption", countLines[0]),
    text(margin, margin + 54, "caption", countLines[1]),
    panelMarkup(layout, "before", margin, originY, `Before · ${fitLabel(model.refs.base, 48)}`),
    panelMarkup(layout, "after", stacked ? margin : margin + panel + GAP, afterY, `After · ${fitLabel(headLabel(model.refs.head), 48)}`),
    text(margin, ledgerY, "heading", `Changes (${ledger.length})`),
    ...ledger.map((row, index) => `<text class="ledger" x="${margin}" y="${ledgerY + 24 + ROW * index}" data-target="${escapeXml(row.target)}" data-change="${escapeXml(row.change)}">${escapeXml(row.text)}</text>`),
    ...footer.map((line, index) => text(margin, footerY + ROW * index, "caption", line)),
    text(margin, footerY + ROW * footer.length, "caption", NOTE),
    legendMarkup(height - margin - 12),
    "</svg>",
    "",
  ].join("\n");
}

/**
 * A delta is drawn when the architecture changed: a unit added, removed, renamed or with another role, a unit edge
 * added or removed, a cycle, or a moved rules verdict (a rules-file edit changes violations, not imports). File and
 * file-pair counts alone change in nearly every pull request: not drawn (GATE-5 decision). The one definition for every caller.
 */
export function deltaChanged({ structure, architecture }: Pick<ArchitectureDeltaSource, "structure" | "architecture">): boolean {
  const units = structure?.units;
  const topology = units !== undefined && (
    units.items.some((item) => item.status !== "CHANGED" || item.role?.before !== item.role?.after)
    || units.edges.some((edge) => edge.status !== "CHANGED")
    || units.cycles.length > 0);
  return topology || (architecture !== undefined && architecture.verdict !== "unchanged");
}

/** Why an undrawn delta is undrawn, for the one line the CLI prints. */
export function deltaUnchangedLine({ structure, baseRef, headRef }: Pick<ArchitectureDeltaSource, "structure" | "baseRef" | "headRef">): string {
  const { items, edges } = structure!.units.compared;
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  const sized = [count(structure!.units.items.length, "unit"), count(structure!.units.edges.length, "unit edge")].filter((part) => !part.startsWith("0 "));
  const only = sized.length > 0 ? `; ${sized.join(" and ")} only changed size (file or file-pair counts)` : "";
  return sanitizeText(`No architecture change between ${baseRef} and ${headLabel(headRef)} (${count(items.after ?? items.before ?? 0, "unit")}, ${count(edges.after ?? edges.before ?? 0, "unit edge")} compared${only}): no diagram written.`);
}

/** The delta of a review as an SVG, with the counts, the cut notes and the warnings the caller reports. */
export async function renderArchitectureDelta(source: ArchitectureDeltaSource, options: { theme?: DiagramTheme } = {}):
  Promise<{ markup: string; counts: string; cut: string[]; warnings: string[] }> {
  const layout = await layoutDelta(buildDeltaModel(source));
  const { counts, cut, warnings } = layout.model;
  // These lines reach stderr, a CI log: unit names come from the pull request, so a newline or `::cmd::` must not start a line.
  return { markup: renderDeltaSvg(layout, options.theme), counts: sanitizeText(counts), cut: cut.map(sanitizeText), warnings: warnings.map(sanitizeText) };
}
