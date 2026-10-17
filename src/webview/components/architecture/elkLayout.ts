import type { Core, EdgeCollection, EdgeSingular, NodeSingular, Position } from "cytoscape";
import type { ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api";

/**
 * ELK layered, top to bottom: the analyzer's layers are partitions (highest layer on top, layer 0
 * at the bottom), longest-path layering keeps a partition's sinks on its bottom row (a cycle spreads
 * its members over several rows), compounds are laid out with their children in one run, and edges
 * are routed orthogonally around the boxes. Coordinates are absolute (ROOT).
 */
export const ELK_LAYERED_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.partitioning.activate": "true",
  "elk.layered.layering.strategy": "LONGEST_PATH",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  // The compound padding of buildArchitectureStylesheet, so ELK and Cytoscape draw the same boxes.
  "elk.padding": "[top=12,left=12,bottom=12,right=12]",
  "elk.json.shapeCoords": "ROOT",
  "elk.json.edgeCoords": "ROOT",
};

/** An edge's ELK route, with the centres of its ends it was computed for. */
export interface EdgeRoute {
  points: ElkPoint[];
  source: Position;
  target: Position;
}

const keyOf = (node: NodeSingular): string => String(node.data("key") ?? node.id());
/** Stable across builds (group keys and file paths), unlike edge ids. */
export const routeKey = (edge: EdgeSingular): string => `${keyOf(edge.source())}>${keyOf(edge.target())}`;

function elkNode(node: NodeSingular, partitionOf: (node: NodeSingular) => string | undefined): ElkNode {
  const partition = partitionOf(node);
  const layoutOptions = partition === undefined ? undefined : { "elk.partitioning.partition": partition };
  if (node.isParent()) {
    return { id: node.id(), layoutOptions, children: node.children().nodes().map((child) => elkNode(child, partitionOf)) };
  }
  return { id: node.id(), layoutOptions, width: Number(node.data("width")), height: Number(node.data("height")) };
}

/** The drawn graph as ELK input: top-level nodes carry their layer as partition, compounds nest their children. */
export function toElkGraph(cy: Core): ElkNode {
  const layers = cy.nodes().map((node) => node.data("layer")).filter((layer): layer is number => typeof layer === "number");
  const top = Math.max(0, ...layers);
  const partitionOf = (node: NodeSingular) => (typeof node.data("layer") === "number" ? String(top - node.data("layer")) : undefined);
  const edges: ElkExtendedEdge[] = cy.edges().map((edge) => ({ id: edge.id(), sources: [edge.source().id()], targets: [edge.target().id()] }));
  return {
    id: "root",
    layoutOptions: ELK_LAYERED_OPTIONS,
    children: cy.nodes(":orphan").map((node) => elkNode(node, partitionOf)),
    edges,
  };
}

/** Every node of an ELK result, nested ones included. */
function flatten(node: ElkNode): ElkNode[] {
  return (node.children ?? []).flatMap((child) => [child, ...flatten(child)]);
}

/**
 * Moves the leaves to the ELK result and returns each edge's route. Compounds follow their
 * children, so a route keeps the centres Cytoscape gives its ends, not ELK's.
 */
export function applyElkLayout(cy: Core, layout: ElkNode): Map<string, EdgeRoute> {
  cy.batch(() => {
    for (const node of flatten(layout)) {
      const element = cy.getElementById(node.id);
      if (element.nonempty() && !element.isParent()) {
        element.position({ x: (node.x ?? 0) + (node.width ?? 0) / 2, y: (node.y ?? 0) + (node.height ?? 0) / 2 });
      }
    }
  });
  const routes = new Map<string, EdgeRoute>();
  for (const edge of layout.edges ?? []) {
    const section = edge.sections?.[0];
    const element = cy.getElementById(edge.id);
    if (!section || element.empty()) continue;
    routes.set(routeKey(element), {
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
      source: { ...element.source().position() },
      target: { ...element.target().position() },
    });
  }
  return routes;
}

const near = (a: Position, b: Position) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
const ROUTE_FIELDS = ["routed", "sourceEndpoint", "targetEndpoint", "segmentWeights", "segmentDistances"];

/**
 * Draws each edge along its route while both ends sit where the route was computed for, else
 * leaves it to the default curve. Cytoscape segments are relative to the line between the two
 * endpoints: a bend P is at S + w·(E − S) + d·n, with n the unit normal (−dy, dx) / l.
 */
export function applyRoutes(cy: Core, edges: EdgeCollection, routes: ReadonlyMap<string, EdgeRoute>): void {
  cy.batch(() => {
    edges.forEach((edge) => {
      const route = routes.get(routeKey(edge));
      const source = edge.source().position();
      const target = edge.target().position();
      const start = route?.points[0];
      const end = route?.points.at(-1);
      const length = start && end ? Math.hypot(end.x - start.x, end.y - start.y) : 0;
      if (!route || !start || !end || length === 0 || !near(source, route.source) || !near(target, route.target)) {
        edge.removeData(ROUTE_FIELDS.join(" "));
        return;
      }
      const dx = (end.x - start.x) / length;
      const dy = (end.y - start.y) / length;
      const bends = route.points.slice(1, -1);
      // A straight route still needs one segment point.
      const points = bends.length > 0 ? bends : [{ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }];
      edge.data({
        routed: true,
        sourceEndpoint: `${start.x - source.x}px ${start.y - source.y}px`,
        targetEndpoint: `${end.x - target.x}px ${end.y - target.y}px`,
        segmentWeights: points.map((point) => ((point.x - start.x) * dx + (point.y - start.y) * dy) / length),
        segmentDistances: points.map((point) => (point.x - start.x) * -dy + (point.y - start.y) * dx),
      });
    });
  });
}
