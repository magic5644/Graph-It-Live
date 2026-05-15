import type { SequenceMessage } from "@/analyzer/sequence/types";

export function orderMessages(messages: SequenceMessage[]): SequenceMessage[] {
  return [...messages].sort((a, b) => {
    if (a.sourceFile !== b.sourceFile) {
      return a.sourceFile.localeCompare(b.sourceFile);
    }

    if (a.startLine !== b.startLine) {
      return a.startLine - b.startLine;
    }

    if (a.startCol !== b.startCol) {
      return a.startCol - b.startCol;
    }

    return a.id.localeCompare(b.id);
  });
}