/**
 * CLI Command: sequence
 *
 * Generates a sequence diagram from an entry symbol.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { generateSequence } from "../../analyzer/sequence/SequenceEngine";
import { renderSequenceMarkdown } from "../../analyzer/sequence/renderers/markdownSequenceRenderer";
import { renderMermaidSequence } from "../../analyzer/sequence/renderers/mermaidSequenceRenderer";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";
import { parseSymbolRef } from "../symbols";

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  if (args.length === 0) {
    throw new CliError(
      "Usage: graph-it sequence <file#SymbolName> [--maxDepth N] [--maxSteps N]",
      ExitCode.GENERAL_ERROR,
    );
  }

  const ref = parseSymbolRef(args[0], runtime.workspaceRoot);
  if (!ref.symbolName) {
    throw new CliError(
      "sequence requires a symbol name: file.ts#FunctionName",
      ExitCode.GENERAL_ERROR,
    );
  }

  let maxDepth = 6;
  let maxSteps = 200;

  const depthIdx = args.indexOf("--maxDepth");
  if (depthIdx >= 0 && args[depthIdx + 1]) {
    maxDepth = Number.parseInt(args[depthIdx + 1], 10);
  }

  const stepsIdx = args.indexOf("--maxSteps");
  if (stepsIdx >= 0 && args[stepsIdx + 1]) {
    maxSteps = Number.parseInt(args[stepsIdx + 1], 10);
  }

  const model = await generateSequence({
    workspaceRoot: runtime.workspaceRoot,
    filePath: ref.filePath,
    symbolName: ref.symbolName,
    maxDepth,
    maxSteps,
    includeExternal: true,
    includeAnnotations: true,
    useCache: true,
  });

  if (format === "mermaid") return renderMermaidSequence(model);
  if (format === "markdown") return renderSequenceMarkdown(model);
  return formatOutput(model, format, "sequence");
}
