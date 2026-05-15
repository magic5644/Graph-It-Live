import type { SequenceModel } from "@/analyzer/sequence/types";
import { renderMermaidSequence } from "@/analyzer/sequence/renderers/mermaidSequenceRenderer";

export function renderSequenceMarkdown(model: SequenceModel): string {
  const mermaidDiagram = renderMermaidSequence(model);
  const warningsSection = model.warnings.length === 0
    ? "- none"
    : model.warnings.map((warning) => `- ${warning.code}: ${warning.message}`).join("\n");

  return [
    "## Sequence Diagram",
    "",
    "```mermaid",
    mermaidDiagram,
    "```",
    "",
    "## Warnings",
    warningsSection,
  ].join("\n");
}