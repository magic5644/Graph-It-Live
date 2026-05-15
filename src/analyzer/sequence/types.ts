export type SequenceConfidence = "high" | "medium" | "low" | "unresolved";

export type SequenceRelationType = "CALLS" | "USES" | "RETURNS" | "THROWS";

export interface SequenceRoot {
  id: string;
  symbolName: string;
  filePath: string;
}

export interface SequenceParticipant {
  id: string;
  label: string;
  filePath: string | null;
  external: boolean;
}

export interface SequenceMessage {
  id: string;
  fromParticipantId: string;
  toParticipantId: string;
  label: string;
  relationType: SequenceRelationType;
  async: boolean;
  confidence: SequenceConfidence;
  sourceFile: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  sequenceNumber?: number;
}

export type SequenceWarningCode =
  | "UNRESOLVED_TARGET"
  | "TRUNCATED"
  | "AMBIGUOUS_TARGET";

export interface SequenceWarning {
  code: SequenceWarningCode;
  message: string;
  sourceFile?: string;
  startLine?: number;
}

export interface SequenceStats {
  participantsCount: number;
  messagesCount: number;
  maxDepthReached: number;
  analysisTimeMs: number;
}

export interface SequenceModel {
  root: SequenceRoot;
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  warnings: SequenceWarning[];
  truncated: boolean;
  stats: SequenceStats;
}

export interface SequenceGenerationParams {
  workspaceRoot: string;
  filePath: string;
  symbolName: string;
  maxDepth: number;
  maxSteps: number;
  includeExternal: boolean;
  includeAnnotations: boolean;
  useCache: boolean;
  resolveSymbolGraph?: (
    filePath: string,
  ) => Promise<{
    symbols: Array<{ id: string; name: string; parentSymbolId?: string }>;
    dependencies: Array<{
      sourceSymbolId: string;
      targetSymbolId: string;
      targetFilePath: string;
    }>;
  }>;
}
