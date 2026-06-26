/**
 * Builds Mermaid dependency, caller, and architecture diagrams from WikiArticle data.
 * All labels use display paths (relative, no absolute workspace root).
 */

import { normalizePath } from "../../shared/path.js";
import type { MermaidDiagram, WikiArticle } from "../../shared/wiki-types.js";

/** Practical Mermaid.js rendering limit before diagrams become unreadable. */
const MAX_NODES = 50;
const MAX_ARCH_EDGES = 40;

/** Escape label text for Mermaid "..." quoted node labels. */
function mermaidLabel(text: string): string {
  return text
    .replace(/[\n\r]/g, " ")
    .replace(/"/g, "'")
    .replace(/[|<>]/g, "")
    .substring(0, 60);
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
 * flowchart TD — top hub files and edges between them (architecture overview).
 * Included in the wiki index.
 */
export function buildArchitectureDiagram(
  articles: WikiArticle[],
  display: (fp: string) => string,
  limit = MAX_NODES,
): MermaidDiagram | null {
  const hubs = [...articles]
    .sort((a, b) => b.hubScore - a.hubScore)
    .slice(0, limit);

  if (hubs.length < 2) return null;

  const hubNorm = new Set(hubs.map((h) => normalizePath(h.filePath)));
  const registry = buildNodeRegistry(hubs.map((h) => h.filePath), display);

  const lines: string[] = ["flowchart TD"];

  for (const hub of hubs) {
    const id = registry.get(normalizePath(hub.filePath))!;
    const label = mermaidLabel(`${display(hub.filePath)} (${hub.hubScore})`);
    lines.push(`  ${id}["${label}"]`);
  }

  const seenEdges = new Set<string>();
  let edgeCount = 0;
  for (const hub of hubs) {
    const srcId = registry.get(normalizePath(hub.filePath))!;
    for (const callee of hub.callees) {
      const norm = normalizePath(callee.filePath);
      if (hubNorm.has(norm) && edgeCount < MAX_ARCH_EDGES) {
        const tgtId = registry.get(norm);
        if (tgtId && tgtId !== srcId) {
          const edgeKey = `${srcId}-->${tgtId}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            lines.push(`  ${srcId} --> ${tgtId}`);
            edgeCount++;
          }
        }
      }
    }
  }

  const truncated = hubs.length < articles.length;
  return {
    title: "Architecture overview",
    type: "architecture",
    mermaid: lines.join("\n"),
    truncated,
    truncationNote: truncated
      ? `Showing top ${hubs.length} of ${articles.length} files by hub score`
      : undefined,
  };
}
