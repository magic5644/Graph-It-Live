import type { SequenceModel } from "@/analyzer/sequence/types";

function summarizeWarnings(model: SequenceModel): string {
  const countsByCode = new Map<string, number>();
  for (const warning of model.warnings) {
    countsByCode.set(warning.code, (countsByCode.get(warning.code) ?? 0) + 1);
  }

  return Array.from(countsByCode.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => count === 1 ? code : `${code} x${count}`)
    .join(", ");
}

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

  const rootParticipantId = model.participants[0]?.id ?? "p1";

  if (model.warnings.length > 0) {
    lines.push(`Note over ${rootParticipantId}: Warnings: ${summarizeWarnings(model)}`);
  }

  if (model.truncated) {
    lines.push(`Note over ${rootParticipantId}: truncated output for readability`);
  }

  return lines.join("\n");
}
