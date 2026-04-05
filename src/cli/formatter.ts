/**
 * CLI Output Formatter
 *
 * Formats command output in text, json, toon, markdown, and mermaid formats.
 * Re-uses existing TOON utilities from shared/toon.ts.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { estimateTokenSavings, jsonToToon } from "../shared/toon";
import { CliError, ExitCode } from "./errors";

export type CliOutputFormat = "text" | "json" | "toon" | "markdown" | "mermaid";

export const CLI_OUTPUT_FORMATS: readonly CliOutputFormat[] = ["text", "json", "toon", "markdown", "mermaid"];

/** Commands that can produce graph / mermaid output */
const GRAPH_COMMANDS = new Set(["trace", "path", "scan"]);

/** Commands that support mermaid */
const MERMAID_COMMANDS = new Set(["trace", "path"]);

/**
 * Check whether a format is valid for the given command.
 * Throws CliError with UNSUPPORTED_FORMAT if not.
 */
export function validateFormatForCommand(format: CliOutputFormat, command: string): void {
  if (format === "mermaid" && !MERMAID_COMMANDS.has(command)) {
    throw new CliError(
      `Format "mermaid" is not supported for command "${command}". ` +
        `Mermaid output is available for: ${[...MERMAID_COMMANDS].join(", ")}`,
      ExitCode.UNSUPPORTED_FORMAT,
    );
  }
}

/**
 * Format any data payload for CLI output.
 */
export function formatOutput(data: unknown, format: CliOutputFormat, command: string): string {
  validateFormatForCommand(format, command);

  switch (format) {
    case "json":
      return formatJson(data);
    case "toon":
      return formatToon(data);
    case "text":
      return formatText(data, command);
    case "markdown":
      return formatMarkdown(data, command);
    case "mermaid":
      return formatMermaid(data, command);
  }
}

// ============================================================================
// Format implementations
// ============================================================================

function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function formatToon(data: unknown): string {
  // Extract array data for TOON
  const arrayData = extractArrayForToon(data);
  if (!arrayData || arrayData.length === 0) {
    // Fallback to JSON for non-array / empty data
    return JSON.stringify(data, null, 2);
  }

  try {
    const objectName = inferObjectName(arrayData);
    const toonContent = jsonToToon(arrayData, { objectName });
    const jsonStr = JSON.stringify(data, null, 2);
    const savings = estimateTokenSavings(jsonStr, toonContent);

    return (
      toonContent +
      `\n\n# Token Savings: ${savings.savings} tokens (${savings.savingsPercent.toFixed(1)}%)`
    );
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

  if (Array.isArray(data)) {
    return data.map((item, i) => formatTextItem(item, i)).join("\n");
  }

  if (typeof data === "object") {
    return formatTextObject(data as Record<string, unknown>, 0);
  }

  // data is a primitive at this point (number, boolean, bigint, symbol)
  return String(data as number | boolean | bigint | symbol);
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
  return String(item);
}

function formatTextValue(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(String).join(", ")}]`;
  }
  if (typeof v === "object" && v !== null) {
    return JSON.stringify(v);
  }
  return String(v);
}

function formatTextObject(obj: Record<string, unknown>, indent: number): string {
  const prefix = "  ".repeat(indent);
  return Object.entries(obj)
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

function formatMarkdown(data: unknown, command: string): string {
  const heading = `## graph-it ${command}\n\n`;

  // For graph commands, embed mermaid if applicable
  if (GRAPH_COMMANDS.has(command)) {
    const mermaid = tryBuildMermaid(data);
    if (mermaid) {
      return heading + "```mermaid\n" + mermaid + "\n```\n\n" + "```json\n" + JSON.stringify(data, null, 2) + "\n```";
    }
  }

  return heading + "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

function formatMermaid(data: unknown, _command: string): string {
  const mermaid = tryBuildMermaid(data);
  if (!mermaid) {
    throw new CliError(
      "Could not generate Mermaid diagram from the data. The response must contain nodes/edges or a trace structure.",
      ExitCode.UNSUPPORTED_FORMAT,
    );
  }
  return mermaid;
}

// ============================================================================
// Mermaid helpers
// ============================================================================

interface GraphLike {
  nodes?: { id?: string; file?: string; filePath?: string; name?: string }[];
  edges?: { source?: string; target?: string; from?: string; to?: string }[];
}

interface TraceLike {
  trace?: { caller?: string; callee?: string; from?: string; to?: string; file?: string; depth?: number }[];
  steps?: { caller?: string; callee?: string; from?: string; to?: string }[];
}

function tryBuildMermaid(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Graph-like data (nodes + edges)
  if (Array.isArray(obj["nodes"]) && Array.isArray(obj["edges"])) {
    return buildMermaidFromGraph(obj as unknown as GraphLike);
  }

  // Trace-like data (generic)
  if (Array.isArray(obj["trace"]) || Array.isArray(obj["steps"])) {
    return buildMermaidFromTrace(obj as unknown as TraceLike);
  }

  // Trace result with callChain (from executeTraceFunctionExecution)
  if (Array.isArray(obj["callChain"])) {
    return buildMermaidFromCallChain(
      obj["callChain"] as { callerSymbolId: string; calledSymbolId: string }[],
    );
  }

  return null;
}

function sanitizeMermaidId(id: string): string {
  return id.replaceAll(/\W/g, "_");
}

function buildMermaidFromGraph(graph: GraphLike): string | null {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0 && edges.length === 0) return null;

  const lines = ["graph LR"];

  for (const node of nodes) {
    const id = node.id ?? node.file ?? node.filePath ?? node.name ?? "unknown";
    const safeId = sanitizeMermaidId(id);
    const label = node.name ?? node.file ?? node.filePath ?? id;
    lines.push(`  ${safeId}["${label}"]`);
  }

  for (const edge of edges) {
    const src = sanitizeMermaidId(String(edge.source ?? edge.from ?? "?"));
    const tgt = sanitizeMermaidId(String(edge.target ?? edge.to ?? "?"));
    lines.push(`  ${src} --> ${tgt}`);
  }

  return lines.join("\n");
}

function buildMermaidFromTrace(trace: TraceLike): string | null {
  const steps = trace.trace ?? trace.steps ?? [];
  if (steps.length === 0) return null;

  const lines = ["graph TD"];

  for (const step of steps) {
    const from = sanitizeMermaidId(String(step.caller ?? step.from ?? "?"));
    const to = sanitizeMermaidId(String(step.callee ?? step.to ?? "?"));
    lines.push(`  ${from} --> ${to}`);
  }

  return lines.join("\n");
}

function buildMermaidFromCallChain(
  chain: { callerSymbolId: string; calledSymbolId: string }[],
): string | null {
  if (chain.length === 0) return null;

  const lines = ["graph TD"];
  const seen = new Set<string>();

  for (const entry of chain) {
    const from = sanitizeMermaidId(entry.callerSymbolId.split(":").pop() ?? entry.callerSymbolId);
    const to = sanitizeMermaidId(entry.calledSymbolId.split(":").pop() ?? entry.calledSymbolId);
    const edge = `  ${from} --> ${to}`;
    if (!seen.has(edge)) {
      lines.push(edge);
      seen.add(edge);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// TOON helpers
// ============================================================================

function extractArrayForToon(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;

  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const arrayKeys = [
      "items", "results", "data", "nodes", "edges",
      "dependencies", "symbols", "callers", "files", "callChain",
    ];
    for (const key of arrayKeys) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }

  return null;
}

function inferObjectName(data: unknown[]): string {
  if (data.length === 0) return "data";

  const first = data[0];
  if (typeof first !== "object" || first === null) return "data";

  const keys = Object.keys(first);
  if (keys.includes("file") || keys.includes("filePath")) return "files";
  if (keys.includes("symbolName") || keys.includes("symbol")) return "symbols";
  if (keys.includes("source") && keys.includes("target")) return "edges";
  if (keys.includes("node") || keys.includes("id")) return "nodes";
  if (keys.includes("caller")) return "callers";
  if (keys.includes("dependency")) return "dependencies";

  return "data";
}
