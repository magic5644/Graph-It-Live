/**
 * Builds Mermaid dependency and caller diagrams from WikiArticle data, and the grouped
 * architecture diagram shared by the wiki index and `graph-it architecture --groups`.
 * All labels use display paths (relative, no absolute workspace root).
 */

import type { GraphData } from "../../shared/graph-types.js";
import { normalizePath } from "../../shared/path.js";
import type { MermaidDiagram, WikiArticle } from "../../shared/wiki-types.js";
import { aggregateCommunityGroups } from "../community/groupAggregation.js";

/** Practical Mermaid.js rendering limit before diagrams become unreadable. */
const MAX_NODES = 50;
const MAX_ARCH_EDGES = 40;

export interface GroupedDiagramOptions {
  display: (filePath: string) => string;
  /** First `%%` comment: community mode, graph kind and scope of the graph. */
  context: string;
  /** Above this many files, groups collapse to single nodes. Also caps the shown groups. */
  maxFiles?: number;
  /** Above this many intra-group edges, groups collapse. Also caps the shown group edges. */
  maxEdges?: number;
}

/** Escape label text for Mermaid "..." quoted node labels. */
function mermaidLabel(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\x00-\x1F\x7F]/g, " ")
    .replaceAll('"', "'")
    // A leading backtick would switch the label to a Markdown string.
    .replaceAll(/[|<>`]/g, "")
    .substring(0, 60)
    // After the cut, so an entity is never split: `#x;` would otherwise render as an entity code.
    .replaceAll("#", "#35;");
}

/** A `%%` comment ends at the line break; control characters would end it early. */
function mermaidComment(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/[\x00-\x1F\x7F]/g, " ");
}

/**
 * Stable, unique node ID derived from the display path (relative path).
 * Uses last 2 segments to be readable but avoids collisions between
 * e.g. src/mcp/types.ts and src/analyzer/types.ts.
 */
function nodeId(displayPath: string): string {
  const parts = displayPath.replace(/\\/g, "/").split("/");
  const key = parts.length >= 2
    ? `${parts[parts.length - 2]}_${parts[parts.length - 1]}`
    : parts[parts.length - 1];
  return key
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .substring(0, 40);
}

/**
 * Disambiguate collisions: if two different files produce the same nodeId,
 * append a counter suffix.
 */
function buildNodeRegistry(
  filePaths: string[],
  display: (fp: string) => string,
): Map<string, string> {
  const registry = new Map<string, string>(); // absPath → mermaidId
  const seen = new Map<string, number>();      // mermaidId → count

  for (const fp of filePaths) {
    const dp = display(fp);
    const base = nodeId(dp);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count > 0 ? `${base}_${count}` : base;
    registry.set(normalizePath(fp), id);
  }
  return registry;
}

/**
 * flowchart LR — file → its callees (dependency diagram).
 * Always generated when the file has callees.
 */
export function buildDependencyDiagram(
  article: WikiArticle,
  display: (fp: string) => string,
): MermaidDiagram | null {
  if (article.callees.length === 0) return null;

  const seenFiles = new Set<string>();
  const external = article.callees
    .filter((c) => normalizePath(c.filePath) !== normalizePath(article.filePath))
    .filter((c) => {
      const k = normalizePath(c.filePath);
      if (seenFiles.has(k)) return false;
      seenFiles.add(k);
      return true;
    });
  const truncated = external.length > MAX_NODES;
  const shown = external.slice(0, MAX_NODES);
  if (shown.length === 0) return null;

  const allPaths = [article.filePath, ...shown.map((c) => c.filePath)];
  const registry = buildNodeRegistry(allPaths, display);

  const lines: string[] = ["flowchart LR"];
  const selfId = registry.get(normalizePath(article.filePath))!;
  lines.push(`  ${selfId}["${mermaidLabel(display(article.filePath))}"]`);

  const declared = new Set<string>([normalizePath(article.filePath)]);
  for (const c of shown) {
    const norm = normalizePath(c.filePath);
    const id = registry.get(norm)!;
    if (!declared.has(norm)) {
      declared.add(norm);
      lines.push(`  ${id}["${mermaidLabel(display(c.filePath))}"]`);
    }
    lines.push(`  ${selfId} --> ${id}`);
  }

  return {
    title: "External calls",
    type: "dependency",
    mermaid: lines.join("\n"),
    truncated,
    truncationNote: truncated
      ? `Showing ${shown.length} of ${external.length} dependencies`
      : undefined,
  };
}

/**
 * flowchart LR — callers → file (caller diagram).
 * Only generated for hub files (score ≥ threshold).
 */
export function buildCallerDiagram(
  article: WikiArticle,
  display: (fp: string) => string,
): MermaidDiagram | null {
  if (article.callers.length === 0) return null;

  const seenCallers = new Set<string>();
  const external = article.callers
    .filter((c) => normalizePath(c.filePath) !== normalizePath(article.filePath))
    .filter((c) => {
      const k = normalizePath(c.filePath);
      if (seenCallers.has(k)) return false;
      seenCallers.add(k);
      return true;
    });
  const truncated = external.length > MAX_NODES;
  const shown = external.slice(0, MAX_NODES);
  if (shown.length === 0) return null;

  const allPaths = [article.filePath, ...shown.map((c) => c.filePath)];
  const registry = buildNodeRegistry(allPaths, display);

  const lines: string[] = ["flowchart LR"];
  const selfId = registry.get(normalizePath(article.filePath))!;
  lines.push(`  ${selfId}["${mermaidLabel(display(article.filePath))}"]`);

  const declared = new Set<string>([normalizePath(article.filePath)]);
  for (const c of shown) {
    const norm = normalizePath(c.filePath);
    const id = registry.get(norm)!;
    if (!declared.has(norm)) {
      declared.add(norm);
      lines.push(`  ${id}["${mermaidLabel(display(c.filePath))}"]`);
    }
    lines.push(`  ${id} --> ${selfId}`);
  }

  return {
    title: `Called by`,
    type: "caller",
    mermaid: lines.join("\n"),
    truncated,
    truncationNote: truncated
      ? `Showing ${shown.length} of ${external.length} callers`
      : undefined,
  };
}

/**
 * flowchart LR — files grouped by the communityId in nodeMetadata (path or Louvain, see
 * computeNodeMetadata). One subgraph per group while the file graph fits maxFiles files and
 * maxEdges intra-group edges; beyond, one node per group. Inter-group edges are always drawn
 * between groups, labelled with their distinct file-pair count. Counts come from
 * aggregateCommunityGroups on the whole graph, so the display caps never change them.
 */
export function buildGroupedDiagram(
  graphData: GraphData,
  options: GroupedDiagramOptions,
): MermaidDiagram | null {
  const { display, context, maxFiles = MAX_NODES, maxEdges = MAX_ARCH_EDGES } = options;
  const aggregation = aggregateCommunityGroups(graphData);
  const { totals, unassigned } = aggregation;
  if (totals.files === 0) return null;

  const groups = aggregation.groups.map(({ id, label, fileCount }) => ({ id, label: label || `group ${id}`, fileCount }));
  if (unassigned.fileCount > 0) groups.push({ id: 0, label: "unassigned", fileCount: unassigned.fileCount });
  const shownGroups = groups.sort((a, b) => b.fileCount - a.fileCount || a.id - b.id).slice(0, maxFiles);
  const shownIds = new Set(shownGroups.map((group) => group.id));
  const shownEdges = aggregation.groupEdges
    .filter((edge) => shownIds.has(edge.from) && shownIds.has(edge.to))
    .sort((a, b) => b.fileEdgeCount - a.fileEdgeCount || a.from - b.from || a.to - b.to)
    .slice(0, maxEdges);
  const hiddenGroups = groups.length - shownGroups.length;
  const hiddenEdges = aggregation.groupEdges.length - shownEdges.length;
  const collapsed = totals.files > maxFiles || totals.intraGroupEdges > maxEdges;

  const lines = [
    "flowchart LR",
    `%% ${mermaidComment(context)}`,
    `%% ${totals.files} files, ${totals.fileEdges} file edges (${totals.intraGroupEdges} intra-group, ${totals.interGroupEdges} inter-group)`,
    `%% view: ${collapsed ? "collapsed" : "expanded"}; hidden: ${hiddenGroups} group(s), ${hiddenEdges} group edge(s)`,
  ];
  if (collapsed) {
    lines.push(...shownGroups.map((group) => `  G${group.id}["${groupLabel(group)}"]`));
  } else {
    lines.push(...expandedGroupLines(graphData, shownGroups, display));
  }
  lines.push(...shownEdges.map((edge) => `  G${edge.from} -->|${edge.fileEdgeCount}| G${edge.to}`));

  const notes = [
    collapsed && `Collapsed to groups: ${totals.files} files and ${totals.intraGroupEdges} intra-group edges exceed ${maxFiles} files or ${maxEdges} edges`,
    hiddenGroups > 0 && `${hiddenGroups} smallest group(s) hidden`,
    hiddenEdges > 0 && `${hiddenEdges} weakest group edge(s) hidden`,
  ].filter((note): note is string => typeof note === "string");
  const truncationNote = notes.join("; ") || undefined;
  return {
    title: "Architecture overview",
    type: "architecture",
    mermaid: lines.join("\n"),
    truncated: truncationNote !== undefined,
    truncationNote,
  };
}

function groupLabel(group: { label: string; fileCount: number }): string {
  return mermaidLabel(`${group.label} (${group.fileCount} file${group.fileCount === 1 ? "" : "s"})`);
}

/** One subgraph of file nodes per group, then the file edges inside each group. */
function expandedGroupLines(
  graphData: GraphData,
  groups: { id: number; label: string; fileCount: number }[],
  display: (fp: string) => string,
): string[] {
  const communityOf = (filePath: string): number => graphData.nodeMetadata?.[filePath]?.communityId ?? 0;
  const pairs = new Map(graphData.edges.map((edge) => {
    const pair = [normalizePath(edge.source), normalizePath(edge.target)] as const;
    return [`${pair[0]}\0${pair[1]}`, pair];
  }));
  const files = new Set([...graphData.nodes.map(normalizePath), ...[...pairs.values()].flat()]);
  const filesByGroup = new Map<number, string[]>();
  for (const filePath of files) {
    const id = communityOf(filePath);
    filesByGroup.set(id, [...(filesByGroup.get(id) ?? []), filePath]);
  }

  // Numeric ids: labels and paths may repeat across groups or hold Mermaid syntax.
  const fileIds = new Map<string, string>();
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`  subgraph G${group.id}["${groupLabel(group)}"]`);
    for (const filePath of filesByGroup.get(group.id) ?? []) {
      const id = `F${fileIds.size}`;
      fileIds.set(filePath, id);
      lines.push(`    ${id}["${mermaidLabel(display(filePath))}"]`);
    }
    lines.push("  end");
  }
  for (const [source, target] of pairs.values()) {
    if (communityOf(source) === communityOf(target)) lines.push(`  ${fileIds.get(source)} --> ${fileIds.get(target)}`);
  }
  return lines;
}
