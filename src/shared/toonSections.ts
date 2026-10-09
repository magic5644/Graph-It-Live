/**
 * Sectioned TOON encoding for tool results, shared by the CLI and the MCP server.
 *
 * TOON encodes a flat array of objects. A tool result is usually an object that
 * holds several arrays (`nodes` and `edges`, `callers` and `callees`) next to
 * scalar facts (`nodeCount`, `truncated`). Picking a single array dropped all the
 * rest, so this encodes one section per array plus a scalar header line.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { jsonToToon } from "./toon";

export interface ToonSection {
  name: string;
  items: unknown[];
}

export interface EncodedToonSections {
  content: string;
  /** JSON of what was actually encoded, so dropped content never counts as a saving. */
  encodedJson: string;
}

/**
 * Encode every array of `data` as its own TOON section, after a scalar header.
 *
 * Returns null when `data` holds no non-empty array, so each caller keeps its own
 * fallback for scalar-only payloads.
 */
export function encodeToonSections(data: unknown, rootName?: string): EncodedToonSections | null {
  const sections = collectToonSections(data, rootName);
  if (sections.length === 0) return null;

  // jsonToToon returns no trailing newline, so sections must be joined with one
  // or the next section's header lands at the end of the previous row.
  const body = sections
    .map(section => jsonToToon(section.items, { objectName: section.name }))
    .join("\n");
  const encodedJson = JSON.stringify(
    Array.isArray(data)
      ? sections[0].items
      : Object.fromEntries(sections.map(section => [section.name, section.items])),
    null,
    2,
  );

  return { content: formatToonScalarHeader(data, sections) + body, encodedJson };
}

/**
 * Render the payload's scalar fields as a leading comment.
 *
 * TOON encodes arrays only, so without this line facts like `truncated` or
 * `nextCursor` — the handle needed to fetch the next page — would be dropped
 * from the output entirely.
 */
export function formatToonScalarHeader(data: unknown, sections: ToonSection[]): string {
  const parts = collectScalarFields(data, sections).map(([key, value]) => `${key}=${String(value)}`);
  return parts.length === 0 ? "" : `# ${parts.join(" ")}\n`;
}

/**
 * The payload's scalar fields that no section encodes, as `[key, value]` pairs.
 * Small scalar records such as `omitted: { nodes, edges }` become `omitted.nodes`.
 */
export function collectScalarFields(data: unknown, sections: ToonSection[]): Array<[string, unknown]> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [];
  }

  const encoded = new Set(sections.map(section => section.name));
  return Object.entries(data as Record<string, unknown>).flatMap(([key, value]): Array<[string, unknown]> => {
    if (encoded.has(key) || Array.isArray(value) || value === undefined || value === null) {
      return [];
    }
    if (typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => typeof nested !== "object")
        .map(([nestedKey, nested]) => [`${key}.${nestedKey}`, nested]);
    }
    return [[key, value]];
  });
}

/**
 * Collect every array worth encoding, not just the first one found.
 *
 * A payload like graph context carries `nodes` and `edges` side by side, and
 * returning only `nodes` silently dropped every relation — the substance of the
 * result — while the savings figure counted the loss as a win.
 */
export function collectToonSections(data: unknown, rootName?: string): ToonSection[] {
  if (Array.isArray(data)) {
    return data.length === 0 ? [] : [{ name: rootName ?? inferObjectName(data), items: data }];
  }

  if (typeof data !== "object" || data === null) {
    return [];
  }

  const obj = data as Record<string, unknown>;
  const topLevel = collectSectionsFrom(obj);
  if (topLevel.length > 0) {
    return topLevel;
  }

  // check-dependencies splits its two arrays across outgoing/incoming, one level
  // below the top-level scan, so merge them into one tagged array first.
  const dependencyCheck = extractDependencyCheckArrayForToon(data);
  if (dependencyCheck && dependencyCheck.length > 0) {
    return [{ name: "dependencies", items: dependencyCheck }];
  }

  // Shapes like explain's { graph: { nodes, edges } }, one level deeper.
  for (const value of Object.values(obj)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const nested = collectSectionsFrom(value as Record<string, unknown>);
    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

function collectSectionsFrom(obj: Record<string, unknown>): ToonSection[] {
  return Object.entries(obj).flatMap(([key, value]) => (
    Array.isArray(value) && value.length > 0 ? [{ name: key, items: toRows(value) }] : []
  ));
}

/**
 * TOON rows must be objects. A nested list of paths or of cycles becomes a
 * single-column section instead of failing the whole encoding.
 */
function toRows(items: unknown[]): unknown[] {
  return items.map(item => (isRecord(item) && !Array.isArray(item) ? item : { value: item }));
}

/**
 * check-dependencies returns { outgoing: { dependencies }, incoming: { referencingFiles } } —
 * both nested one level deeper than the top-level key scan can see.
 * Flatten them into one tagged array so TOON encoding doesn't silently fall back to JSON.
 */
function extractDependencyCheckArrayForToon(data: unknown): unknown[] | null {
  if (typeof data !== "object" || data === null) return null;

  const obj = data as Record<string, unknown>;
  const dependencies = readDependencyArray(obj["outgoing"], "dependencies");
  const referencingFiles = readDependencyArray(obj["incoming"], "referencingFiles");

  if (!dependencies && !referencingFiles) {
    return null;
  }

  const tagged: unknown[] = [];
  appendTaggedItems(tagged, dependencies, "outgoing");
  appendTaggedItems(tagged, referencingFiles, "incoming");
  return tagged;
}

function readDependencyArray(container: unknown, key: "dependencies" | "referencingFiles"): unknown[] | undefined {
  if (typeof container !== "object" || container === null) {
    return undefined;
  }

  const record = container as Record<string, unknown>;
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function appendTaggedItems(target: unknown[], items: unknown[] | undefined, direction: "outgoing" | "incoming"): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    target.push(isRecord(item) ? { direction, ...item } : item);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inferObjectName(data: unknown[]): string {
  const first = data[0];
  if (typeof first !== "object" || first === null) return "data";

  const keys = Object.keys(first);
  if (keys.includes("direction") && keys.includes("path")) return "dependencies";
  if (keys.includes("file") || keys.includes("filePath")) return "files";
  if (keys.includes("symbolName") || keys.includes("symbol")) return "symbols";
  if (keys.includes("source") && keys.includes("target")) return "edges";
  if (keys.includes("node") || keys.includes("id")) return "nodes";
  if (keys.includes("caller")) return "callers";
  if (keys.includes("dependency")) return "dependencies";

  return "data";
}
