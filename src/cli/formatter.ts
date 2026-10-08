/**
 * CLI Output Formatter
 *
 * Formats command output in text, json, toon, markdown, and mermaid formats.
 * Re-uses existing TOON utilities from shared/toon.ts.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { normalizePath } from "../shared/path";
import { estimateTokenSavings } from "../shared/toon";
import { encodeToonSections, formatToonScalarHeader } from "../shared/toonSections";
import { sessionStats } from "../shared/sessionStats";
import { compactOutput } from "../shared/compactOutput";

export type CliOutputFormat = "text" | "json" | "toon" | "markdown" | "mermaid" | "html";

export const CLI_OUTPUT_FORMATS: readonly CliOutputFormat[] = ["text", "json", "toon", "markdown", "mermaid", "html"];

/** Commands that can produce graph / mermaid output */
const GRAPH_COMMANDS = new Set(["trace", "path", "scan", "architecture"]);

const MAX_GENERIC_DEPTH = 3;
const MAX_GENERIC_ITEMS_PER_LEVEL = 20;
const MAX_GENERIC_NODES = 220;
const MAX_MERMAID_LABEL_LENGTH = 120;
const MAX_MERMAID_LINES = 700;
const MAX_GRAPH_NODES = 260;
const MAX_GRAPH_EDGES = 500;
const MAX_TRACE_EDGES = 500;
const MAX_CALLCHAIN_EDGES = 500;
const MAX_DEPENDENCY_RELATIONS = 400;

/**
 * Check whether a format is valid for the given command.
 * Throws CliError with UNSUPPORTED_FORMAT if not.
 */
export function validateFormatForCommand(format: CliOutputFormat, _command: string): void {
  if (format === "mermaid") {
    return;
  }
}

/**
 * Format any data payload for CLI output.
 */
export function formatOutput(
  data: unknown,
  format: CliOutputFormat,
  command: string,
  workspaceRoot?: string,
): string {
  validateFormatForCommand(format, command);

  switch (format) {
    case "json":
      return formatJson(data);
    case "toon":
      // TOON is the token-optimized format; `json` stays a stable, uncompacted contract.
      return formatToon(compactOutput(data), command);
    case "text":
      return formatText(data, command);
    case "markdown":
      return formatMarkdown(data, command, workspaceRoot);
    case "mermaid":
      return formatMermaid(data, command, workspaceRoot);
    case "html":
      throw new Error('Format "html" must be handled before formatOutput — use runExportHtml directly.');
  }
}

// ============================================================================
// Format implementations
// ============================================================================

function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function formatToon(data: unknown, command: string): string {
  try {
    const encoded = encodeToonSections(data);
    if (!encoded) {
      // No rows (e.g. check with no unused symbols): the scalar header still
      // carries the result. Fall back to JSON only when there is nothing to show.
      const header = formatToonScalarHeader(data, []);
      return header ? header.trimEnd() : JSON.stringify(data, null, 2);
    }
    const savings = estimateTokenSavings(encoded.encodedJson, encoded.content);

    // Session stats: TOON encoding size vs JSON equivalent (estimated, chars/4
    // heuristic). Recorded only on successful TOON conversion, like the MCP side.
    sessionStats.record({
      toolName: command,
      jsonTokens: savings.jsonTokens,
      toonTokens: savings.toonTokens,
      savings: savings.savings,
      truncated: false,
      timestamp: Date.now(),
    });
    return encoded.content;
  } catch {
    // Fallback to JSON if TOON fails
    return JSON.stringify(data, null, 2);
  }
}

function formatText(data: unknown, command: string): string {
  if (data === null || data === undefined) {
    return "";
  }

  if (typeof data === "string") {
    return data;
  }

  if (command === "trace" && typeof data === "object" && data !== null && !Array.isArray(data)) {
    return formatTrace(data as Record<string, unknown>);
  }

  if (command === "architecture" && typeof data === "object" && data !== null && !Array.isArray(data)) {
    return formatArchitecture(data as Record<string, unknown>);
  }

  if (Array.isArray(data)) {
    return data.map((item, i) => formatTextItem(item, i)).join("\n");
  }

  if (typeof data === "object") {
    return formatTextObject(data as Record<string, unknown>, 0);
  }

  // Remaining non-object, non-string values (e.g. number/boolean/bigint/symbol/function)
  switch (typeof data) {
    case "number":
    case "bigint":
    case "boolean":
      return `${data}`;
    case "symbol":
      return data.description ?? "symbol";
    case "function":
      return "[function]";
    default:
      return "value";
  }
}

function formatArchitecture(data: Record<string, unknown>): string {
  const workspaceRootRaw = data["workspaceRoot"];
  const workspaceRoot = typeof workspaceRootRaw === "string" ? workspaceRootRaw : "unknown";
  const scannedFiles = Number(data["scannedFiles"] ?? 0);
  const analyzedFiles = Number(data["analyzedFiles"] ?? 0);
  const skippedFiles = Number(data["skippedFiles"] ?? 0);
  const nodeCount = Number(data["nodeCount"] ?? 0);
  const edgeCount = Number(data["edgeCount"] ?? 0);

  const nodes = Array.isArray(data["nodes"])
    ? (data["nodes"] as Array<Record<string, unknown>>)
    : [];

  const topDependents = [...nodes]
    .sort((a, b) => Number(b["dependentCount"] ?? 0) - Number(a["dependentCount"] ?? 0))
    .slice(0, 8)
    .map((node) => {
      const relCandidate = node["relativePath"] ?? node["path"] ?? node["id"];
      const rel = typeof relCandidate === "string" ? relCandidate : "unknown";
      const deps = Number(node["dependencyCount"] ?? 0);
      const usedBy = Number(node["dependentCount"] ?? 0);
      return `  - ${rel}  deps:${deps}  usedBy:${usedBy}`;
    });

  const lines = [
    "Workspace Architecture",
    `  root: ${workspaceRoot}`,
    `  scanned files: ${scannedFiles}`,
    `  analyzed files: ${analyzedFiles}`,
    `  skipped files: ${skippedFiles}`,
    `  nodes: ${nodeCount}`,
    `  edges: ${edgeCount}`,
  ];

  if (topDependents.length > 0) {
    lines.push("", "Top files by incoming dependencies:", ...topDependents);
  }

  if (skippedFiles > 0) {
    lines.push("", "Note: some files were skipped (details available with --format json). ");
  }

  return lines.join("\n");
}

function formatTextItem(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>;
    const rawLabel = obj["file"] ?? obj["filePath"] ?? obj["name"] ?? obj["symbolName"] ?? `[${index}]`;
    const label = typeof rawLabel === "string" || typeof rawLabel === "number" ? String(rawLabel) : `[${index}]`;
    const rest = Object.entries(obj)
      .filter(([k]) => k !== "file" && k !== "filePath" && k !== "name" && k !== "symbolName")
      .map(([k, v]) => `${k}=${formatTextValue(v)}`)
      .join(" ");
    return rest ? `${label}  ${rest}` : label;
  }
  return formatScalar(item);
}

function formatTextValue(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map((item) => formatScalar(item)).join(", ")}]`;
  }
  if (typeof v === "object" && v !== null) {
    return JSON.stringify(v);
  }
  return formatScalar(v);
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ?? "symbol";
  }
  return JSON.stringify(value);
}

function formatTextObject(obj: Record<string, unknown>, indent: number): string {
  const prefix = "  ".repeat(indent);
  return Object.entries(obj)
    // An absent optional field reads as missing information, not as the literal
    // text "undefined".
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        return `${prefix}${k}:\n${formatTextObject(v as Record<string, unknown>, indent + 1)}`;
      }
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
        const items = v.map((item, i) =>
          `${prefix}  [${i}]:\n${formatTextObject(item as Record<string, unknown>, indent + 2)}`
        );
        return `${prefix}${k}:\n${items.join("\n")}`;
      }
      return `${prefix}${k}: ${formatTextValue(v)}`;
    })
    .join("\n");
}

function formatTrace(data: Record<string, unknown>): string {
  const root = data["rootSymbol"] as { relativePath?: string; symbolName?: string } | undefined;
  type ChainEntry = { depth: number; callerSymbolId: string; calledSymbolId: string; resolvedRelativePath: string | null };
  const callChain = (data["callChain"] as ChainEntry[] | undefined) ?? [];
  const visitedSymbols = (data["visitedSymbols"] as string[] | undefined) ?? [];

  const header = root ? `Trace: ${root.relativePath} :: ${root.symbolName}` : "Trace";
  const callCount = typeof data["callCount"] === "number" ? data["callCount"] : callChain.length;
  const uniqueCount = typeof data["uniqueSymbolCount"] === "number" ? data["uniqueSymbolCount"] : visitedSymbols.length;
  const maxDepthReached = typeof data["maxDepthReached"] === "boolean" ? data["maxDepthReached"] : false;
  const stats = `calls: ${callCount}  unique symbols: ${uniqueCount}  maxDepthReached: ${maxDepthReached}`;

  const chainLines = callChain.map((entry) => {
    const callerSymbol = entry.callerSymbolId.split(":").pop() ?? entry.callerSymbolId;
    const calledSymbol = entry.calledSymbolId.split(":").pop() ?? entry.calledSymbolId;
    const where = entry.resolvedRelativePath ? `  (${entry.resolvedRelativePath})` : "";
    return `  depth ${entry.depth}  ${callerSymbol} → ${calledSymbol}${where}`;
  });

  const visitedLines = visitedSymbols.map((sym) => {
    const colon = sym.lastIndexOf(":");
    return colon >= 0 ? `  - ${sym.slice(colon + 1)}  (${sym.slice(0, colon)})` : `  - ${sym}`;
  });

  return [
    header,
    `  ${stats}`,
    "",
    callChain.length > 0 ? `Call Chain:\n${chainLines.join("\n")}` : "Call Chain: (empty)",
    "",
    visitedSymbols.length > 0 ? `Visited Symbols:\n${visitedLines.join("\n")}` : "Visited Symbols: (none)",
  ].join("\n");
}

function formatMarkdown(data: unknown, command: string, workspaceRoot?: string): string {
  const heading = `## graph-it ${command}\n\n`;

  const mermaid = tryBuildMermaid(data, workspaceRoot) ?? buildMermaidFromGenericJson(data, command);
  if (mermaid) {
    return heading + "```mermaid\n" + mermaid + "\n```\n\n" + "```json\n" + JSON.stringify(data, null, 2) + "\n```";
  }

  if (GRAPH_COMMANDS.has(command)) {
    return heading + "```json\n" + JSON.stringify(data, null, 2) + "\n```";
  }

  return heading + "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

function formatMermaid(data: unknown, command: string, workspaceRoot?: string): string {
  const mermaid = tryBuildMermaid(data, workspaceRoot) ?? buildMermaidFromGenericJson(data, command);
  return mermaid;
}

// ============================================================================
// Mermaid helpers
// ============================================================================

interface GraphLike {
  nodes?: unknown[];
  edges?: unknown[];
}

interface TraceLike {
  trace?: unknown[];
  steps?: unknown[];
}

interface DependencyCheckLike {
  filePath?: string;
  relativePath?: string;
  outgoing?: {
    dependencies?: Array<Record<string, unknown>>;
  };
  incoming?: {
    referencingFiles?: Array<Record<string, unknown>>;
  };
}

function tryBuildMermaid(data: unknown, workspaceRoot?: string): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Graph-like data (nodes + edges)
  if (Array.isArray(obj["nodes"]) && Array.isArray(obj["edges"])) {
    const graph: GraphLike = {
      nodes: obj["nodes"],
      edges: obj["edges"],
    };
    return buildMermaidFromGraph(graph);
  }

  // Trace-like data (generic)
  if (Array.isArray(obj["trace"]) || Array.isArray(obj["steps"])) {
    const trace: TraceLike = {
      trace: Array.isArray(obj["trace"]) ? obj["trace"] : undefined,
      steps: Array.isArray(obj["steps"]) ? obj["steps"] : undefined,
    };
    return buildMermaidFromTrace(trace, workspaceRoot);
  }

  // Trace result with callChain (from executeTraceFunctionExecution)
  if (Array.isArray(obj["callChain"])) {
    const chain = obj["callChain"]
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        callerSymbolId: pickMermaidString([entry["callerSymbolId"]], "?"),
        calledSymbolId: pickMermaidString([entry["calledSymbolId"]], "?"),
      }));
    return buildMermaidFromCallChain(chain, workspaceRoot);
  }

  // check-dependencies result (incoming + outgoing)
  if (
    typeof obj["filePath"] === "string"
    && typeof obj["outgoing"] === "object"
    && obj["outgoing"] !== null
    && typeof obj["incoming"] === "object"
    && obj["incoming"] !== null
  ) {
    const dependencyCheck: DependencyCheckLike = {
      filePath: obj["filePath"],
      relativePath: typeof obj["relativePath"] === "string" ? obj["relativePath"] : undefined,
      outgoing: obj["outgoing"],
      incoming: obj["incoming"],
    };
    return buildMermaidFromDependencyCheck(dependencyCheck);
  }

  return null;
}

function valueToMermaidString(value: unknown, fallback = "?"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function pickMermaidString(values: unknown[], fallback: string): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return String(value);
    }
  }
  return fallback;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Returns the synthetic id (`<prefix>0`, `<prefix>1`, …) of `key`, declaring the node on first use.
 *
 * Ids derived from names or paths collide (`a$b` and `a_b`, or two `helper`
 * functions in different files) and can hit Mermaid reserved words such as
 * `end`, which break the parser. Synthetic ids avoid both; the readable text
 * lives in the escaped label.
 */
function declareMermaidNode(
  ids: Map<string, string>,
  lines: string[],
  prefix: string,
  key: string,
  label: string,
  external = false,
): string {
  const existing = ids.get(key);
  if (existing) return existing;
  const id = prefix + String(ids.size);
  ids.set(key, id);
  const escaped = escapeMermaidLabel(label);
  lines.push(external ? `  ${id}(["${escaped}"]):::external` : `  ${id}["${escaped}"]`);
  return id;
}

// Matches POSIX (`/x`), Windows drive (`c:/x`, `C:\x`) and UNC (`\\host`) paths.
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:)?[\\/]/;

function toDisplayPath(filePath: string, workspaceRoot: string | undefined): string {
  const normalized = normalizePath(filePath);
  return workspaceRoot ? relativizeWorkspacePaths(normalized, workspaceRoot) : normalized;
}

/**
 * Label for a `<file>:<name>` symbol id. A file part that is not an absolute
 * path (`node:fs`, a bare package) marks a symbol outside the workspace.
 */
function describeSymbolId(
  symbolId: string,
  workspaceRoot: string | undefined,
): { label: string; external: boolean } {
  const separator = symbolId.lastIndexOf(":");
  if (separator <= 0) return { label: symbolId, external: false };
  const file = symbolId.slice(0, separator);
  const name = symbolId.slice(separator + 1);
  if (!ABSOLUTE_PATH_PATTERN.test(file)) return { label: `${name} · ${file}`, external: true };
  return { label: `${name} · ${toDisplayPath(file, workspaceRoot)}`, external: false };
}

function escapeMermaidLabel(label: string): string {
  // Replace double-quotes to avoid breaking Mermaid node syntax.
  // Strip ASCII control characters (U+0000–U+001F and U+007F) that break diagram structure.
  // eslint-disable-next-line no-control-regex
  const cleaned = label.replaceAll('"', "'").replaceAll(/[\x00-\x1F\x7F]/g, ' ').trim();
  if (cleaned.length <= MAX_MERMAID_LABEL_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_MERMAID_LABEL_LENGTH - 1) + "…";
}

// Node declarations precede edges, so an entry is added only while its two
// nodes, its edge, a classDef and the truncation comment still fit in
// MAX_MERMAID_LINES; otherwise finalizeMermaid would cut every edge.
const SYMBOL_GRAPH_LINE_BUDGET = MAX_MERMAID_LINES - 5;

function finalizeMermaid(lines: string[]): string {
  if (lines.length <= MAX_MERMAID_LINES) {
    return lines.join("\n");
  }

  return lines.slice(0, MAX_MERMAID_LINES).join("\n");
}

function buildMermaidFromGraph(graph: GraphLike): string | null {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0 && edges.length === 0) return null;

  // Map original node id → short numeric id to keep Mermaid IDs compact
  const idMap = new Map<string, string>();
  const lines = ["graph LR"];

  const visibleNodeCount = Math.min(nodes.length, MAX_GRAPH_NODES);
  for (let i = 0; i < visibleNodeCount; i += 1) {
    const node = toRecord(nodes[i]);
    const originalId = pickMermaidString(
      [node?.["id"], node?.["file"], node?.["filePath"], node?.["path"], node?.["name"]],
      "unknown",
    );
    const label = pickMermaidString(
      [node?.["relativePath"], node?.["name"], node?.["file"], node?.["filePath"], originalId],
      originalId,
    );
    declareMermaidNode(idMap, lines, "N", originalId, label);
  }

  if (nodes.length > visibleNodeCount) {
    lines.push("  NTRUNC[\"… " + String(nodes.length - visibleNodeCount) + " more node(s)\"]");
  }

  const visibleEdgeCount = Math.min(edges.length, MAX_GRAPH_EDGES);
  for (let i = 0; i < visibleEdgeCount; i += 1) {
    const edge = toRecord(edges[i]);
    const srcOriginal = pickMermaidString([edge?.["source"], edge?.["from"]], "?");
    const tgtOriginal = pickMermaidString([edge?.["target"], edge?.["to"]], "?");
    const src = declareMermaidNode(idMap, lines, "N", srcOriginal, srcOriginal);
    const tgt = declareMermaidNode(idMap, lines, "N", tgtOriginal, tgtOriginal);
    lines.push(`  ${src} --> ${tgt}`);
  }

  if (edges.length > visibleEdgeCount) {
    lines.push(`%% edge list truncated (${edges.length - visibleEdgeCount} hidden edge(s))`);
  }

  return finalizeMermaid(lines);
}

function buildMermaidFromTrace(trace: TraceLike, workspaceRoot?: string): string | null {
  const steps = trace.trace ?? trace.steps ?? [];
  if (steps.length === 0) return null;

  const nodeLines = ["graph TD"];
  const edgeLines: string[] = [];
  const ids = new Map<string, string>();
  const declare = (raw: string): string =>
    declareMermaidNode(ids, nodeLines, "S", raw, workspaceRoot ? relativizeWorkspacePaths(raw, workspaceRoot) : raw);

  const maxStepCount = Math.min(steps.length, MAX_TRACE_EDGES);
  let visibleStepCount = 0;
  while (visibleStepCount < maxStepCount && nodeLines.length + edgeLines.length <= SYMBOL_GRAPH_LINE_BUDGET) {
    const step = toRecord(steps[visibleStepCount]);
    const from = declare(valueToMermaidString(step?.["caller"] ?? step?.["from"], "?"));
    const to = declare(valueToMermaidString(step?.["callee"] ?? step?.["to"], "?"));
    edgeLines.push(`  ${from} --> ${to}`);
    visibleStepCount += 1;
  }
  const lines = [...nodeLines, ...edgeLines];

  if (steps.length > visibleStepCount) {
    lines.push(`%% trace truncated (${steps.length - visibleStepCount} hidden step(s))`);
  }

  return finalizeMermaid(lines);
}

function buildMermaidFromCallChain(
  chain: { callerSymbolId: string; calledSymbolId: string }[],
  workspaceRoot?: string,
): string | null {
  if (chain.length === 0) return null;

  const nodeLines = ["graph TD"];
  const edgeLines = new Set<string>();
  const ids = new Map<string, string>();
  let hasExternal = false;
  const declare = (symbolId: string): string => {
    const { label, external } = describeSymbolId(symbolId, workspaceRoot);
    hasExternal ||= external;
    return declareMermaidNode(ids, nodeLines, "S", symbolId, label, external);
  };

  const maxEntryCount = Math.min(chain.length, MAX_CALLCHAIN_EDGES);
  let visibleEntryCount = 0;
  while (visibleEntryCount < maxEntryCount && nodeLines.length + edgeLines.size <= SYMBOL_GRAPH_LINE_BUDGET) {
    const entry = chain[visibleEntryCount];
    const from = declare(entry.callerSymbolId);
    const to = declare(entry.calledSymbolId);
    edgeLines.add(`  ${from} --> ${to}`);
    visibleEntryCount += 1;
  }

  const lines = [...nodeLines, ...edgeLines];
  if (hasExternal) {
    lines.push("  classDef external stroke-dasharray: 4 2");
  }

  if (chain.length > visibleEntryCount) {
    lines.push(`%% call chain truncated (${chain.length - visibleEntryCount} hidden edge(s))`);
  }

  return finalizeMermaid(lines);
}

function pickPathLikeValue(item: Record<string, unknown>): string | undefined {
  const candidates = ["path", "filePath", "relativePath", "id", "name"] as const;
  for (const key of candidates) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function toNodeLabel(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.at(-1) ?? normalized;
}

function buildMermaidFromDependencyCheck(data: DependencyCheckLike): string | null {
  const centerRaw = data.relativePath ?? data.filePath;
  if (!centerRaw) return null;

  const outgoing = data.outgoing?.dependencies ?? [];
  const incoming = data.incoming?.referencingFiles ?? [];
  if (outgoing.length === 0 && incoming.length === 0) {
    return null;
  }

  const lines = ["graph LR"];
  const nodes = new Map<string, string>();
  const centerId = declareMermaidNode(nodes, lines, "D", centerRaw, toNodeLabel(centerRaw));

  const visibleOutgoingCount = Math.min(outgoing.length, MAX_DEPENDENCY_RELATIONS);
  for (let i = 0; i < visibleOutgoingCount; i += 1) {
    const dep = outgoing[i];
    const depPath = pickPathLikeValue(dep);
    if (!depPath) continue;
    const depId = declareMermaidNode(nodes, lines, "D", depPath, toNodeLabel(depPath));
    lines.push(`  ${centerId} --> ${depId}`);
  }

  const visibleIncomingCount = Math.min(incoming.length, MAX_DEPENDENCY_RELATIONS);
  for (let i = 0; i < visibleIncomingCount; i += 1) {
    const ref = incoming[i];
    const refPath = pickPathLikeValue(ref);
    if (!refPath) continue;
    const refId = declareMermaidNode(nodes, lines, "D", refPath, toNodeLabel(refPath));
    lines.push(`  ${refId} --> ${centerId}`);
  }

  if (outgoing.length > visibleOutgoingCount) {
    lines.push(`%% outgoing dependencies truncated (${outgoing.length - visibleOutgoingCount} hidden item(s))`);
  }

  if (incoming.length > visibleIncomingCount) {
    lines.push(`%% incoming references truncated (${incoming.length - visibleIncomingCount} hidden item(s))`);
  }

  return finalizeMermaid(lines);
}

function toPrimitiveLabel(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return `${value}`;
    case "undefined":
      return "undefined";
    case "symbol":
      return value.description ?? "symbol";
    default:
      return value === null ? "null" : "value";
  }
}

function summarizeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return "object";
  return toPrimitiveLabel(value);
}

interface GenericMermaidState {
  rootId: string;
  nodeIndex: number;
  nodeLines: string[];
  edges: string[];
}

function createGenericMermaidState(): GenericMermaidState {
  return {
    rootId: "G0",
    nodeIndex: 1,
    nodeLines: [],
    edges: [],
  };
}

function pushGenericNode(state: GenericMermaidState, label: string): string {
  const nodeId = `G${state.nodeIndex}`;
  state.nodeIndex += 1;
  state.nodeLines.push(`  ${nodeId}["${escapeMermaidLabel(label)}"]`);
  return nodeId;
}

function addGenericEdge(state: GenericMermaidState, fromId: string, toId: string): void {
  state.edges.push(`  ${fromId} --> ${toId}`);
}

function appendArrayNodes(state: GenericMermaidState, values: unknown[]): void {
  const limit = Math.min(values.length, Math.min(MAX_GENERIC_ITEMS_PER_LEVEL, MAX_GENERIC_NODES));
  for (let i = 0; i < limit; i += 1) {
    const nodeId = pushGenericNode(state, `[${i}] ${summarizeValue(values[i])}`);
    addGenericEdge(state, state.rootId, nodeId);
  }
  if (values.length > limit) {
    const truncId = pushGenericNode(state, `… ${values.length - limit} more item(s)`);
    addGenericEdge(state, state.rootId, truncId);
  }
}

function appendNestedObjectNodes(
  state: GenericMermaidState,
  parentId: string,
  value: Record<string, unknown>,
): void {
  const nestedEntries = Object.entries(value).slice(0, Math.max(0, MAX_GENERIC_ITEMS_PER_LEVEL - 5));
  for (const [nestedKey, nestedValue] of nestedEntries) {
    if (state.nodeIndex >= MAX_GENERIC_NODES) return;
    const nestedId = pushGenericNode(state, `${nestedKey}: ${summarizeValue(nestedValue)}`);
    addGenericEdge(state, parentId, nestedId);
  }
}

function appendObjectNodes(state: GenericMermaidState, value: Record<string, unknown>): void {
  const entries = Object.entries(value);
  const limit = Math.min(entries.length, Math.min(MAX_GENERIC_ITEMS_PER_LEVEL, MAX_GENERIC_NODES));

  for (let i = 0; i < limit; i += 1) {
    const [key, entryValue] = entries[i];
    const nodeId = pushGenericNode(state, `${key}: ${summarizeValue(entryValue)}`);
    addGenericEdge(state, state.rootId, nodeId);

    if (MAX_GENERIC_DEPTH > 1 && typeof entryValue === "object" && entryValue !== null && !Array.isArray(entryValue)) {
      appendNestedObjectNodes(state, nodeId, entryValue as Record<string, unknown>);
    }
  }

  if (entries.length > limit && state.nodeIndex < MAX_GENERIC_NODES) {
    const truncId = pushGenericNode(state, `… ${entries.length - limit} more key(s)`);
    addGenericEdge(state, state.rootId, truncId);
  }
}

function buildMermaidFromGenericJson(data: unknown, command: string): string {
  const lines = ["graph TD"];
  const state = createGenericMermaidState();
  lines.push(`  ${state.rootId}["${escapeMermaidLabel(command)}"]`);

  if (Array.isArray(data)) {
    appendArrayNodes(state, data);
  } else if (typeof data === "object" && data !== null) {
    appendObjectNodes(state, data as Record<string, unknown>);
  } else {
    const primitiveId = pushGenericNode(state, summarizeValue(data));
    addGenericEdge(state, state.rootId, primitiveId);
  }

  lines.push(...state.nodeLines, ...state.edges);
  return finalizeMermaid(lines);
}

// ============================================================================
// Workspace-relative rewriting
// ============================================================================

/**
 * Strip the workspace root from every absolute path in a rendered output string.
 *
 * Symbol ids carry their file's absolute path (`<absPath>:<symbol>`), so a
 * result with N rows repeats the workspace root N times — on this repo that is
 * roughly a quarter of the bytes of a TOON payload, all of it machine-specific
 * noise that an LLM cannot use.
 *
 * Applied to TOON only: `--format json` is a stable contract for scripts, which
 * may legitimately depend on `filePath` being absolute.
 */
export function relativizeWorkspacePaths(output: string, workspaceRoot: string): string {
  // Every path in the index goes through normalizePath (forward slashes,
  // lowercased Windows drive letter), so matching that one canonical form is
  // enough — no separate native-separator handling is needed.
  const normalizedRoot = normalizePath(workspaceRoot);
  if (normalizedRoot.length === 0) {
    return output;
  }

  // The trailing slash keeps a sibling like "/repo-backup" from matching "/repo".
  return output.replaceAll(`${normalizedRoot}/`, "");
}

/**
 * Final rendering step before the CLI writes to stdout.
 *
 * Lives here rather than inline in the entry point so the rule it applies is
 * testable without driving `main()`.
 */
export function renderCliOutput(
  output: string,
  format: CliOutputFormat,
  workspaceRoot: string,
): string {
  // TOON is the token-optimized format, so the repeated workspace root — noise
  // no model can use — is dropped there. `json` is a stable contract for
  // scripts and keeps absolute paths.
  const rendered = format === "toon" ? relativizeWorkspacePaths(output, workspaceRoot) : output;
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}
