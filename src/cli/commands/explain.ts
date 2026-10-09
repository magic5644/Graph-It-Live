/**
 * CLI Command: explain
 *
 * Explains the logic of a file using its AST-based intra-file call hierarchy.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { executeAnalyzeFileLogic } from "../../mcp/tools";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";
import { parseSymbolRef } from "../symbols";

/** LSP SymbolKind names, indexed by kind number - 1 (the spec numbers them from 1). */
const LSP_SYMBOL_KIND_NAMES = [
  "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
  "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
  "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
  "Event", "Operator", "TypeParameter",
];

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  if (args.length === 0) {
    throw new CliError(
      "Usage: graph-it explain <file>",
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);

  const result = await executeAnalyzeFileLogic({
    filePath: ref.filePath,
  });

  // MCP and the webview keep the LSP number; a CLI reader needs its name.
  const nodes = result.graph.nodes.map((node) => ({
    ...node,
    kind: LSP_SYMBOL_KIND_NAMES[node.kind - 1] ?? node.kind,
  }));
  return formatOutput({ ...result, graph: { ...result.graph, nodes } }, format, "explain");
}
