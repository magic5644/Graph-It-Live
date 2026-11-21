/**
 * The flow diagram of one entry symbol (#793): its flow model (flowModel.ts) on a fixed grid, one column per step
 * in call order and one row per lane used (main, alternative, error). diagramSvg.ts draws it.
 *
 * No ELK: a layered layout cannot pin a node to a lane row across columns, a grid is deterministic by construction.
 * An edge between two neighbour columns crosses their gap; any other runs on its own channel, above the rows for a
 * forward call, below them for a call back to an earlier step. Each edge owns its vertical track in every gap it
 * uses and its channel y, so no segment crosses a box.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { fitLabel, fitName, textWidth, textBound, legendHeight, workspaceName, type Box, type DiagramText, type LegendOptions } from "./architectureDiagram";
import { MAX_FLOW_STEPS, SIZES, snap, type LegendKind } from "./diagramStyle";
import type { FlowEdge, FlowLane, FlowModel, FlowNode } from "./flowModel";

/** Space between two edge tracks, two channels or two ports. */
const TRACK = 8;
/** Space between a box and the first track or label of a gap. */
const GAP_PAD = 12;
/** Most cells drawn of an edge label and of a step's subtitle: longer ones end with "…". */
export const FLOW_LABEL_CHARS = 20;
export const FLOW_SUBTITLE_CHARS = 40;
const LABEL_LINE = 14;
/** Room above and below the tallest box of a lane row. */
const ROW_PAD = 40;
const LANES: readonly FlowLane[] = ["main", "alternative", "error"];
const LANE_KIND: Record<FlowLane, LegendKind> = { main: "main", alternative: "alternative", error: "error-path" };

export interface Point {
  x: number;
  y: number;
}

export interface FlowBox extends Box {
  id: string;
  /** Title, optional subtitle and meta line, each cut to fit the box. */
  text: string;
  subtitle?: string;
  meta: string;
  entry: boolean;
  /** Tooltip: the full id, file and line. */
  title: string;
}

export interface FlowPlacedEdge {
  /** Index of the drawn edge in `model.edges`: self-calls and edges to undrawn steps are not placed. */
  edge: number;
  from: string;
  to: string;
  kind: LegendKind;
  points: Point[];
  /** Tooltip: `from → to: file:line (relation, lane)`. */
  title: string;
  label: Point & { text: string };
}

export interface FlowLayout {
  text: DiagramText;
  width: number;
  height: number;
  /** Where the graph starts below the header. */
  top: number;
  /** Lane names, left of their row. */
  lanes: (Point & { text: string })[];
  nodes: FlowBox[];
  edges: FlowPlacedEdge[];
  /** The legend items the drawing needs. */
  legend: LegendOptions;
}

type Route = "straight" | "jog" | "above" | "below";

/** One edge with its columns and route; `rank` orders the channels of one route. */
interface Plan {
  edge: FlowEdge;
  index: number;
  from: number;
  to: number;
  route: Route;
  rank: number;
  label: string;
}

const isBus = (plan: Plan) => plan.route === "above" || plan.route === "below";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The text an edge carries before any annotation: its condition, or its call line. */
export function defaultEdgeLabel(edge: FlowEdge): string {
  if (edge.relation === "REFERENCES") return `ref · line ${edge.line}`;
  return edge.condition ?? `line ${edge.line}`;
}

const edgeLabel = (edge: FlowEdge) => fitLabel(edge.label ?? defaultEdgeLabel(edge), FLOW_LABEL_CHARS);

function routeOf(from: number, to: number, sameRow: boolean): Route {
  if (to === from + 1) return sameRow ? "straight" : "jog";
  return to > from ? "above" : "below";
}

function planEdges(model: FlowModel, rowOf: (node: FlowNode) => number): Plan[] {
  const column = new Map(model.nodes.map((node, index) => [node.id, index]));
  const ranks: Record<Route, number> = { straight: 0, jog: 0, above: 0, below: 0 };
  return model.edges.flatMap((edge, index) => {
    const [from, to] = [column.get(edge.from), column.get(edge.to)];
    if (from === undefined || to === undefined || from === to) return [];
    const route = routeOf(from, to, rowOf(model.nodes[from]) === rowOf(model.nodes[to]));
    return [{ edge, index, from, to, route, rank: ranks[route]++, label: edgeLabel(edge) }];
  });
}

function sizeBox(node: FlowNode, entry: boolean): Omit<FlowBox, "x" | "y"> {
  const text = fitName(node.title);
  const subtitle = node.subtitle === undefined ? undefined : fitLabel(node.subtitle, FLOW_SUBTITLE_CHARS);
  const meta = `${fitName(node.file, 24)}:${node.line} · ${plural(node.symbolCount, "symbol")}`;
  const widest = Math.max(textWidth(text, SIZES.label), textWidth(subtitle ?? "", SIZES.meta), textWidth(meta, SIZES.meta));
  return {
    id: node.id,
    text,
    ...(subtitle === undefined ? {} : { subtitle }),
    meta,
    entry,
    title: `${node.id}: ${node.file}:${node.line}`,
    width: snap(Math.max(SIZES.minNodeWidth, widest + 2 * SIZES.nodePaddingX)),
    height: subtitle === undefined ? SIZES.nodeHeight : 60,
  };
}

/**
 * The tracks of the gap after column `gap`, left to right: the source side of that column's channel edges, the
 * neighbour edge that changes row, then the target side of the next column's channel edges, last edge first.
 * That order keeps the edges of one gap from crossing each other next to the boxes.
 */
function gapTracks(plans: readonly Plan[], gap: number): Plan[] {
  return [
    ...plans.filter((plan) => isBus(plan) && plan.from === gap),
    ...plans.filter((plan) => plan.route === "jog" && plan.from === gap),
    ...plans.filter((plan) => isBus(plan) && plan.to - 1 === gap).reverse(),
  ];
}

interface Gap {
  x: number;
  tracks: Plan[];
  labelX: number;
  width: number;
}

function sizeGap(plans: readonly Plan[], gap: number): Omit<Gap, "x" | "labelX"> & { labelOffset: number } {
  const tracks = gapTracks(plans, gap);
  const labels = plans.filter((plan) => plan.to - 1 === gap);
  const labelOffset = GAP_PAD + TRACK * tracks.length;
  const labelWidth = Math.max(0, ...labels.map((plan) => textWidth(plan.label, SIZES.meta)));
  return { tracks, labelOffset, width: snap(labelOffset + (labels.length > 0 ? labelWidth + GAP_PAD : 0)) };
}

/** Lays the gaps (-1 before the first column to the one after the last) and the columns out, left to right. */
function placeColumns(boxes: readonly Omit<FlowBox, "x" | "y">[], plans: readonly Plan[], left: number) {
  const gaps = new Map<number, Gap>();
  const xs: number[] = [];
  let x = left;
  for (let gap = -1; gap < boxes.length; gap++) {
    const { tracks, labelOffset, width } = sizeGap(plans, gap);
    gaps.set(gap, { x, tracks, labelX: x + labelOffset, width });
    x += width;
    if (gap + 1 < boxes.length) {
      xs.push(x);
      x += boxes[gap + 1].width;
    }
  }
  return { gaps, xs, right: x };
}

/** Port y of `plan` on one side of a box: channel edges spread over the half facing their channel, others at the centre. */
function portY(plans: readonly Plan[], plan: Plan, node: number, centre: number, height: number): number {
  if (!isBus(plan)) return centre;
  const side = plans.filter((other) => other.route === plan.route && (plan.from === node ? other.from === node : other.to === node));
  const spacing = Math.min(TRACK, Math.floor((height / 2 - 4) / side.length));
  const offset = spacing * (side.length - side.indexOf(plan));
  return plan.route === "above" ? centre - offset : centre + offset;
}

interface Grid {
  plans: Plan[];
  boxes: FlowBox[];
  gaps: Map<number, Gap>;
  centres: number[];
  channel: (plan: Plan) => number;
}

const trackX = (grid: Grid, gap: number, plan: Plan) => {
  const { x, tracks } = grid.gaps.get(gap)!;
  return x + GAP_PAD + TRACK * tracks.indexOf(plan);
};

function routePoints(grid: Grid, plan: Plan): Point[] {
  const [source, target] = [grid.boxes[plan.from], grid.boxes[plan.to]];
  const out = portY(grid.plans, plan, plan.from, grid.centres[plan.from], source.height);
  const into = portY(grid.plans, plan, plan.to, grid.centres[plan.to], target.height);
  const start = { x: source.x + source.width, y: out };
  const end = { x: target.x, y: into };
  if (plan.route === "straight") return [start, end];
  const near = trackX(grid, plan.from, plan);
  if (plan.route === "jog") return [start, { x: near, y: out }, { x: near, y: into }, end];
  const far = trackX(grid, plan.to - 1, plan);
  const y = grid.channel(plan);
  return [start, { x: near, y: out }, { x: near, y }, { x: far, y }, { x: far, y: into }, end];
}

/** Edge labels in the gap before their target, right of its tracks, stacked above the target's highest port. */
function placeLabel(grid: Grid, plan: Plan, points: readonly Point[][]): Point & { text: string } {
  const incoming = grid.plans.filter((other) => other.to === plan.to);
  const top = Math.min(...incoming.map((other) => points[grid.plans.indexOf(other)].at(-1)!.y));
  const y = top - 4 - LABEL_LINE * (incoming.length - 1 - incoming.indexOf(plan));
  return { text: plan.label, x: grid.gaps.get(plan.to - 1)!.labelX, y };
}

/** The header lines, counts and notes of a flow; an annotated spec's caption replaces the title and caption lines. */
export function flowText(model: FlowModel, workspace: string): DiagramText {
  const entry = model.nodes.find((node) => node.id === model.entry) ?? model.nodes[0];
  const references = model.edges.filter((edge) => edge.relation === "REFERENCES").length;
  const omitted = model.omittedSteps;
  const callees = `${plural(omitted, "callee")} past the step cap left out`;
  const rerun = model.maxSteps >= MAX_FLOW_STEPS
    ? `${callees}: ${MAX_FLOW_STEPS} steps is the most a flow draws`
    : `${callees}: rerun with --maxSteps ${Math.min(MAX_FLOW_STEPS, model.nodes.length + omitted)}`;
  return {
    title: model.caption?.title ?? `Flow · ${fitName(entry?.title ?? model.entry)}`,
    caption: model.caption?.caption
      ?? [fitLabel(workspaceName(workspace), 48), entry ? `${fitName(entry.file, 64)}:${entry.line}` : undefined, model.language].filter(Boolean).join(" · "),
    counts: [plural(model.nodes.length, "step"), plural(model.edges.length - references, "call"), plural(references, "reference")].join(" · "),
    hidden: [
      ...(omitted > 0 ? [rerun] : []),
      ...(model.lanes === "unsupported" ? [`lanes not read for ${model.language}: every step on main, in call order`] : []),
    ],
    rules: undefined,
  };
}

const edgeKind = (edge: FlowEdge): LegendKind => (edge.relation === "REFERENCES" ? "reference" : LANE_KIND[edge.lane]);

/** Lays the flow of `model` out; `workspace` is named by its last folder only. */
export function layoutFlow(model: FlowModel, workspace: string): FlowLayout {
  const rows = LANES.filter((lane) => model.nodes.some((node) => node.lane === lane));
  const rowOf = (node: FlowNode) => rows.indexOf(node.lane);
  const plans = planEdges(model, rowOf);
  const sized = model.nodes.map((node, index) => sizeBox(node, index === 0));
  const laneWidth = snap(Math.max(...rows.map((lane) => textWidth(lane, SIZES.meta))) + GAP_PAD);
  const { gaps, xs, right } = placeColumns(sized, plans, SIZES.margin + laneWidth);
  const above = plans.filter((plan) => plan.route === "above").length;
  const below = plans.filter((plan) => plan.route === "below").length;
  const top = SIZES.margin + SIZES.headerHeight;
  const rowsTop = top + TRACK * above;
  const band = Math.ceil((Math.max(...sized.map((box) => box.height)) + ROW_PAD) / TRACK) * TRACK;
  const rowsBottom = rowsTop + band * rows.length;
  const centre = (row: number) => rowsTop + band * row + band / 2;
  const centres = model.nodes.map((node) => centre(rowOf(node)));
  const boxes = sized.map((box, index) => ({ ...box, x: xs[index], y: centres[index] - box.height / 2 }));
  // Rank 0 runs farthest from the rows: its edge leaves by the outermost port and the nearest track.
  const channel = (plan: Plan) => (plan.route === "above" ? top + TRACK * plan.rank : rowsBottom + TRACK * (below - plan.rank));
  const grid: Grid = { plans, boxes, gaps, centres, channel };
  const points = plans.map((plan) => routePoints(grid, plan));
  const text = flowText(model, workspace);
  const legend: LegendOptions = { kinds: ["entry", "main", ...plans.map((plan) => edgeKind(plan.edge))], weight: false, dependency: false };
  const bottom = rowsBottom + (below > 0 ? TRACK * below + TRACK : 0);
  return {
    text,
    width: snap(SIZES.margin + Math.max(right, SIZES.margin + textBound(text, legend))),
    height: snap(bottom + SIZES.margin + legendHeight(text)),
    top,
    lanes: rows.map((lane, row) => ({ text: lane, x: SIZES.margin, y: centre(row) + 4 })),
    nodes: boxes,
    edges: plans.map((plan, index) => ({
      edge: plan.index,
      from: plan.edge.from,
      to: plan.edge.to,
      kind: edgeKind(plan.edge),
      points: points[index],
      title: `${plan.edge.from} → ${plan.edge.to}: ${plan.edge.file}:${plan.edge.line} (${plan.edge.relation}, ${plan.edge.lane})`,
      label: placeLabel(grid, plan, points),
    })),
    legend,
  };
}
