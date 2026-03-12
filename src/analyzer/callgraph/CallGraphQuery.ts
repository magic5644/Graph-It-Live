/**
 * CallGraphQuery — BFS neighbourhood traversal over sql.js SQLite database.
 *
 * Given a root symbol ID, performs a bidirectional BFS up to `depth` hops,
 * then groups nodes into compound nodes (by folder), runs cycle detection, and
 * returns a serializable `NeighbourhoodResult` ready to be sent to the webview.
 *
 * No vscode imports — pure Node.js / analyzer layer.
 *
 * SPEC: specs/001-live-call-graph/spec.md — FR-001, FR-003, FR-004, FR-007
 * DATA MODEL: specs/001-live-call-graph/data-model.md
 */

import { detectCycleEdges } from "@/analyzer/callgraph/cycleUtils";
import type {
  RelationType,
  SerializedCallEdge,
  SerializedCallNode,
  SerializedCompoundNode,
  SupportedLang,
  SymbolType,
} from "@/shared/callgraph-types";
import type { Database } from "sql.js";

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface NeighbourhoodResult {
  /** The root symbol's stable ID */
  rootSymbolId: string;
  nodes: SerializedCallNode[];
  edges: SerializedCallEdge[];
  compounds: SerializedCompoundNode[];
  /** Traversal depth used */
  depth: number;
  /** Unix timestamp (ms) */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Internal raw row shapes (from sql.js query results)
// ---------------------------------------------------------------------------

interface RawNode {
  id: string;
  name: string;
  type: string;
  lang: string;
  path: string;
  folder: string;
  start_line: number;
  end_line: number;
  start_col: number;
  is_exported: number;
}

interface RawEdge {
  source_id: string;
  target_id: string;
  type_relation: string;
  is_cyclic: number;
  source_line: number;
}

// ---------------------------------------------------------------------------
// Query implementation
// ---------------------------------------------------------------------------

/**
 * Query the call graph neighbourhood around a root symbol.
 *
 * @param db       The sql.js Database (already initialized with schema + data).
 * @param rootId   The symbol ID to start traversal from.
 * @param depth    Maximum BFS hop count (default: 2).
 * @returns        Serialized neighbourhood ready for the webview.
 */
export function queryNeighbourhood(
  db: Database,
  rootId: string,
  depth = 2,
): NeighbourhoodResult {
  // 1. Gather all reachable node IDs via bidirectional BFS
  const visitedIds = bfsBidirectional(db, rootId, depth);

  // If root not found, return empty result
  if (visitedIds.size === 0) {
    return {
      rootSymbolId: rootId,
      nodes: [],
      edges: [],
      compounds: [],
      depth,
      timestamp: Date.now(),
    };
  }

  // 2. Fetch full node rows for visited IDs
  const rawNodes = fetchNodes(db, visitedIds);

  // 3. Fetch edges where both endpoints are in the visited set
  const rawEdges = fetchEdges(db, visitedIds);

  // 4. Run cycle detection on the result edge set (overrides DB is_cyclic flag
  //    which may be stale until full re-index; this ensures freshness for the
  //    current neighbourhood view).  Uses edge-level detection so only the
  //    specific edges that form a cycle are marked (not merely edges between
  //    two nodes that happen to be cycle participants).
  //    USES edges (type references) are excluded — they naturally create
  //    bidirectional patterns (class uses interface, interface references class)
  //    that are not real call cycles.
  const cycleEdgeKeys = detectCycleEdges(
    rawEdges
      .filter((e) => e.type_relation !== "USES")
      .map((e) => ({ source: e.source_id, target: e.target_id })),
  );

  // 5. Serialize nodes (mark root)
  const nodes: SerializedCallNode[] = rawNodes.map((r) =>
    serializeNode(r, r.id === rootId),
  );

  // 6. Serialize edges (mark cyclic from fresh detection; compute direction)
  const edges: SerializedCallEdge[] = rawEdges.map((r) =>
    serializeEdge(r, cycleEdgeKeys, rootId),
  );

  // 7. Build compound nodes (one per unique folder)
  const compounds = buildCompounds(nodes);

  return {
    rootSymbolId: rootId,
    nodes,
    edges,
    compounds,
    depth,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// BFS helpers
// ---------------------------------------------------------------------------

/**
 * Bidirectional BFS: walk outgoing edges (source→target) AND incoming edges
 * (target→source) up to `depth` hops. Returns set of all visited node IDs
 * including the root.
 */
function bfsBidirectional(
  db: Database,
  rootId: string,
  depth: number,
): Set<string> {
  const visited = new Set<string>();

  // Verify root exists first
  const rootCheck = db.exec(
    `SELECT id FROM nodes WHERE id = ? LIMIT 1`,
    [rootId],
  );
  if (!rootCheck[0]?.values?.length) {
    return visited;
  }

  visited.add(rootId);
  let frontier = new Set<string>([rootId]);

  for (let hop = 0; hop < depth; hop++) {
    if (frontier.size === 0) break;
    frontier = collectFrontierNeighbours(db, frontier, visited);
  }

  return visited;
}

/**
 * Collect neighbours for an entire frontier set in two SQL queries
 * (outgoing + incoming), instead of 2 queries per node.
 * Returns the new frontier (unvisited, non-stub neighbours).
 */
function collectFrontierNeighbours(
  db: Database,
  frontier: Set<string>,
  visited: Set<string>,
): Set<string> {
  const nextFrontier = new Set<string>();
  const frontierArr = [...frontier];
  const placeholders = frontierArr.map(() => "?").join(", ");

  // Outgoing: frontier nodes as sources → get their targets
  const outgoing = db.exec(
    `SELECT target_id FROM edges WHERE source_id IN (${placeholders})`,
    frontierArr,
  );
  for (const row of outgoing[0]?.values ?? []) {
    addIfReachable(row[0] as string, visited, nextFrontier);
  }

  // Incoming: frontier nodes as targets → get their sources
  const incoming = db.exec(
    `SELECT source_id FROM edges WHERE target_id IN (${placeholders})`,
    frontierArr,
  );
  for (const row of incoming[0]?.values ?? []) {
    addIfReachable(row[0] as string, visited, nextFrontier);
  }

  return nextFrontier;
}

function addIfReachable(
  id: string,
  visited: Set<string>,
  frontier: Set<string>,
): void {
  if (id && !id.startsWith("@@external:") && !visited.has(id)) {
    visited.add(id);
    frontier.add(id);
  }
}

// ---------------------------------------------------------------------------
// DB fetch helpers
// ---------------------------------------------------------------------------

function fetchNodes(db: Database, ids: Set<string>): RawNode[] {
  if (ids.size === 0) return [];

  const placeholders = [...ids].map(() => "?").join(", ");
  const result = db.exec(
    `SELECT id, name, type, lang, path, folder,
            start_line, end_line, start_col, is_exported
     FROM nodes
     WHERE id IN (${placeholders})`,
    [...ids],
  );

  if (!result[0]) return [];

  return result[0].values.map((row) => ({
    id: row[0] as string,
    name: row[1] as string,
    type: row[2] as string,
    lang: row[3] as string,
    path: row[4] as string,
    folder: row[5] as string,
    start_line: row[6] as number,
    end_line: row[7] as number,
    start_col: row[8] as number,
    is_exported: row[9] as number,
  }));
}

function fetchEdges(db: Database, nodeIds: Set<string>): RawEdge[] {
  if (nodeIds.size === 0) return [];

  const placeholders = [...nodeIds].map(() => "?").join(", ");
  const args = [...nodeIds, ...nodeIds];
  const result = db.exec(
    `SELECT source_id, target_id, type_relation, is_cyclic, source_line
     FROM edges
     WHERE source_id IN (${placeholders})
       AND target_id IN (${placeholders})`,
    args,
  );

  if (!result[0]) return [];

  return result[0].values.map((row) => ({
    source_id: row[0] as string,
    target_id: row[1] as string,
    type_relation: row[2] as string,
    is_cyclic: row[3] as number,
    source_line: row[4] as number,
  }));
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeNode(raw: RawNode, isRoot: boolean): SerializedCallNode {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type as SymbolType,
    lang: raw.lang as SupportedLang,
    path: raw.path,
    folder: raw.folder,
    startLine: raw.start_line,
    endLine: raw.end_line,
    startCol: raw.start_col,
    isExported: raw.is_exported === 1,
    isRoot,
  };
}

function serializeEdge(
  raw: RawEdge,
  cycleEdgeKeys: Set<string>,
  rootId: string,
): SerializedCallEdge {
  let direction: "outgoing" | "incoming" | "lateral";
  if (raw.source_id === rootId) {
    direction = "outgoing";
  } else if (raw.target_id === rootId) {
    direction = "incoming";
  } else {
    direction = "lateral";
  }
  return {
    sourceId: raw.source_id,
    targetId: raw.target_id,
    typeRelation: raw.type_relation as RelationType,
    // An edge is cyclic only when this specific directed edge is part of a cycle
    isCyclic: cycleEdgeKeys.has(`${raw.source_id}->${raw.target_id}`),
    sourceLine: raw.source_line,
    direction,
  };
}

// ---------------------------------------------------------------------------
// Compound node builder
// ---------------------------------------------------------------------------

function buildCompounds(nodes: SerializedCallNode[]): SerializedCompoundNode[] {
  const folderMap = new Map<string, SerializedCompoundNode>();
  const fileMap = new Map<string, SerializedCompoundNode>();

  for (const node of nodes) {
    // Top-level folder compound — use full workspace-relative path for readability
    if (!folderMap.has(node.folder)) {
      folderMap.set(node.folder, {
        id: node.folder,
        label: node.folder,
        type: "compound",
        compoundLevel: "folder",
      });
    }
    // File-level compound nested inside the folder compound
    if (!fileMap.has(node.path)) {
      const label = node.path.split("/").at(-1) ?? node.path;
      fileMap.set(node.path, {
        id: node.path,
        label,
        type: "compound",
        compoundLevel: "file",
        parent: node.folder,
      });
    }
  }

  return [...folderMap.values(), ...fileMap.values()];
}
