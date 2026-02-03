import { getLogger } from "@/shared/logger";
import type { SymbolCluster, SymbolNode } from "@/shared/types";

const log = getLogger("clusterUtils");

/**
 * Build hierarchical clusters from symbols.
 * Creates namespace clusters (one per dossier/namespace) containing class clusters.
 *
 * Structure:
 * - Namespace cluster (e.g., "src/components")
 *   - Class cluster 1 (e.g., "UserService")
 *   - Class cluster 2 (e.g., "UserController")
 *   - Standalone symbols (functions/variables without a class)
 */
export function buildClusters(symbols: SymbolNode[]): SymbolCluster[] {
  const clusters: SymbolCluster[] = [];

  // Group symbols by namespace (extracted from symbol ID)
  const symbolsByNamespace = new Map<string, SymbolNode[]>();

  for (const symbol of symbols) {
    // Extract namespace from symbol ID (format: "filePath:symbolName")
    // For now, use file path as namespace (will be enhanced for language-specific namespaces)
    const [filePath] = symbol.id.split(":");
    const namespace = filePath; // TODO: Extract namespace from file content for TypeScript, Python, etc.

    if (!symbolsByNamespace.has(namespace)) {
      symbolsByNamespace.set(namespace, []);
    }
    symbolsByNamespace.get(namespace)!.push(symbol);
  }

  // Create namespace clusters and nested class clusters
  for (const [namespace, nsSymbols] of symbolsByNamespace.entries()) {
    // Separate symbols by type
    const classSymbols = nsSymbols.filter((s) => s.type === "class");
    const standaloneSymbols = nsSymbols.filter(
      (s) => s.type !== "class" && !s.parentSymbolId
    );

    // Create class clusters (nested in namespace)
    const childClusterIds: string[] = [];

    for (const classSymbol of classSymbols) {
      const classClusterId = `${namespace}:${classSymbol.name}`;

      // Get members of this class
      const classMembers = nsSymbols.filter(
        (s) => s.parentSymbolId === classSymbol.id
      );

      const classCluster: SymbolCluster = {
        id: classClusterId,
        type: "class",
        name: classSymbol.name,
        namespace,
        parentClass: undefined, // Not nested in another class
        symbolIds: [classSymbol.id, ...classMembers.map((m) => m.id)],
        childClusterIds: [],
        isOpen: true, // Default: all class clusters open
      };

      clusters.push(classCluster);
      childClusterIds.push(classClusterId);
    }

    // Create namespace cluster
    const namespaceCluster: SymbolCluster = {
      id: namespace,
      type: "namespace",
      name: namespace.split("/").pop() || namespace,
      namespace,
      symbolIds: [
        ...standaloneSymbols.map((s) => s.id),
        ...classSymbols.map((s) => s.id),
      ],
      childClusterIds,
      isOpen: true, // Default: all namespace clusters open
    };

    clusters.push(namespaceCluster);
  }

  log.debug(
    `Built ${clusters.length} clusters from ${symbols.length} symbols`,
    {
      namespaces: symbolsByNamespace.size,
      classes: clusters.filter((c) => c.type === "class").length,
    }
  );

  return clusters;
}

/**
 * Build a lookup map of clusters by ID for quick access.
 */
function buildClusterMap(clusters: SymbolCluster[]): Map<string, SymbolCluster> {
  const clusterMap = new Map<string, SymbolCluster>();
  for (const cluster of clusters) {
    clusterMap.set(cluster.id, cluster);
  }
  return clusterMap;
}

/**
 * Add visible symbols from namespace cluster and its open child class clusters.
 */
function addVisibleSymbolsFromNamespace(
  cluster: SymbolCluster,
  clusterMap: Map<string, SymbolCluster>,
  symbols: SymbolNode[],
  visible: Set<string>
): void {
  if (!cluster.isOpen) return;

  // Add standalone symbols and class nodes
  for (const symbolId of cluster.symbolIds) {
    // Add symbol to visible set (class node or standalone symbol)
    visible.add(symbolId);
  }

  // Add symbols from open class clusters
  for (const childClusterId of cluster.childClusterIds) {
    const childCluster = clusterMap.get(childClusterId);
    if (childCluster?.isOpen) {
      for (const symbolId of childCluster.symbolIds) {
        visible.add(symbolId);
      }
    } else if (childCluster) {
      // Add only the class node itself
      const classSymbol = symbols.find((s) => s.id === childCluster.symbolIds[0]);
      if (classSymbol && classSymbol.type === "class") {
        visible.add(classSymbol.id);
      }
    }
  }
}

/**
 * Get all symbol IDs that should be visible for a given cluster state.
 * Takes into account which clusters are open/closed.
 */
export function getVisibleSymbolIds(
  clusters: SymbolCluster[],
  symbols: SymbolNode[]
): Set<string> {
  const visible = new Set<string>();
  const clusterMap = buildClusterMap(clusters);

  for (const cluster of clusters) {
    if (cluster.type === "namespace") {
      addVisibleSymbolsFromNamespace(cluster, clusterMap, symbols, visible);
    }
  }

  return visible;
}

/**
 * Calculate bounding box for all clusters.
 * Used for auto-fit viewport calculation.
 */
export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function calculateClusterBounds(
  clusters: SymbolCluster[]
): BoundingBox | null {
  const withBounds = clusters.filter((c) => c.x !== undefined && c.y !== undefined && c.width !== undefined && c.height !== undefined);

  if (withBounds.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const cluster of withBounds) {
    const x = cluster.x!;
    const y = cluster.y!;
    const w = cluster.width!;
    const h = cluster.height!;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Calculate zoom and pan transform to fit all clusters in viewport with padding.
 */
export interface FitViewParams {
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
  maxZoom?: number;
}

export function calculateFitTransform(
  bounds: BoundingBox,
  params: FitViewParams
): { scale: number; tx: number; ty: number } {
  const { viewportWidth, viewportHeight, padding = 40, maxZoom = 4 } = params;

  const graphWidth = bounds.maxX - bounds.minX;
  const graphHeight = bounds.maxY - bounds.minY;

  // Calculate zoom to fit with padding
  const scaleX = (viewportWidth - padding * 2) / graphWidth;
  const scaleY = (viewportHeight - padding * 2) / graphHeight;
  const scale = Math.min(scaleX, scaleY, maxZoom);

  // Calculate translation to center
  const scaledWidth = graphWidth * scale;
  const scaledHeight = graphHeight * scale;
  const tx = (viewportWidth - scaledWidth) / 2 - bounds.minX * scale;
  const ty = (viewportHeight - scaledHeight) / 2 - bounds.minY * scale;

  return { scale, tx, ty };
}

/**
 * Get class clusters within a namespace cluster.
 * Used for hierarchical visual rendering (namespace contains class clusters).
 */
export function getClassClustersInNamespace(
  clusters: SymbolCluster[],
  namespaceId: string
): SymbolCluster[] {
  return clusters.filter(
    (c) => c.type === "class" && c.namespace === namespaceId
  );
}

/**
 * Get standalone symbols in a namespace (not part of any class).
 * Used for calculating cluster bounds and layout.
 */
export function getStandaloneSymbolIds(
  clusters: SymbolCluster[],
  symbols: SymbolNode[],
  namespaceId: string
): string[] {
  const namespace = clusters.find((c) => c.id === namespaceId);
  if (!namespace) return [];

  // Get all symbol IDs that belong to classes in this namespace
  const classClusterIds = getClassClustersInNamespace(clusters, namespaceId);
  const classSymbolIds = new Set<string>();
  for (const classCluster of classClusterIds) {
    for (const symbolId of classCluster.symbolIds) {
      classSymbolIds.add(symbolId);
    }
  }

  // Return symbols in namespace but not in any class
  return namespace.symbolIds.filter((id: string) => !classSymbolIds.has(id));
}
