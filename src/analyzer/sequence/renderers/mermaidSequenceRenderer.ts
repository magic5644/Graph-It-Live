import type { SequenceModel } from "@/analyzer/sequence/types";

export function renderMermaidSequence(model: SequenceModel): string {
  const lines: string[] = ["sequenceDiagram"];

  for (const participant of model.participants) {
    lines.push(`participant ${participant.id} as ${participant.label}`);
  }

  let sequenceNumber = 1;
  for (const message of model.messages) {
    const arrow = message.async ? "-->>" : "->>";
    const label =
      typeof message.sequenceNumber === "number"
        ? `${message.sequenceNumber}. ${message.label}`
        : message.label;

    lines.push(`${message.fromParticipantId}${arrow}${message.toParticipantId}: ${label}`);

    if (message.relationType === "RETURNS") {
      const returnLabel = `${sequenceNumber}. return`;
      lines.push(
        `${message.toParticipantId}-->>${message.fromParticipantId}: ${returnLabel}`,
      );
      sequenceNumber++;
    } else {
      sequenceNumber++;
    }
  }

  for (const warning of model.warnings) {
    lines.push(`Note over ${model.root.id}: ${warning.code} ${warning.message}`);
  }

  if (model.truncated) {
    lines.push("Note over root: truncated output for readability");
  }

  return lines.join("\n");
}