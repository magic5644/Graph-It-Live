/**
 * MCP Tool: generate_sequence_diagram
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { generateSequence } from "../../analyzer/sequence/SequenceEngine";
import { renderMermaidSequence } from "../../analyzer/sequence/renderers/mermaidSequenceRenderer";
import { workerState } from "../shared/state";
import type {
  GenerateSequenceDiagramParams,
  GenerateSequenceDiagramResult,
} from "../types";

// ============================================================================
// Tool Executor
// ============================================================================

export async function executeGenerateSequenceDiagram(
  params: GenerateSequenceDiagramParams,
): Promise<GenerateSequenceDiagramResult> {
  const startedAt = Date.now();

  const config = workerState.config;
  const workspaceRoot = config?.rootDir ?? process.cwd();

  const model = await generateSequence({
    workspaceRoot,
    filePath: params.filePath,
    symbolName: params.symbolName,
    maxDepth: params.maxDepth ?? 6,
    maxSteps: params.maxSteps ?? 200,
    includeExternal: params.includeExternal ?? true,
    includeAnnotations: params.includeAnnotations ?? true,
    useCache: true,
  });

  const diagramFormat = params.diagram_format ?? "mermaid";
  const diagram =
    diagramFormat === "json"
      ? JSON.stringify(model, null, 2)
      : renderMermaidSequence(model);

  return {
    diagram,
    rootSymbol: `${params.filePath}:${params.symbolName}`,
    participantsCount: model.participants.length,
    messagesCount: model.messages.length,
    maxDepthReached: model.stats.maxDepthReached,
    truncated: model.truncated,
    warnings: model.warnings.map((w) => ({ code: w.code, message: w.message })),
    analysisTimeMs: Date.now() - startedAt,
  };
}
