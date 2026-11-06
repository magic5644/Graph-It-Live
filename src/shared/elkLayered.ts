/**
 * The ELK layered options of the architecture layouts, shared by the webview's Architecture view
 * and the static diagrams (src/analyzer/diagram), so both place layers and route edges alike.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic and imports nothing.
 */

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
  // The compound padding of the webview's buildArchitectureStylesheet, so ELK and Cytoscape draw the same boxes.
  "elk.padding": "[top=12,left=12,bottom=12,right=12]",
  "elk.json.shapeCoords": "ROOT",
  "elk.json.edgeCoords": "ROOT",
};

/** The ELK partition of a node at `layer` when `top` is the highest layer: partition 0 is drawn on top. */
export const layerPartition = (top: number, layer: number) => ({ "elk.partitioning.partition": String(top - layer) });
