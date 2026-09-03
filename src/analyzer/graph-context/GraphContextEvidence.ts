import type {
  GraphContextConfidence,
  GraphContextEdge,
  GraphContextRelation,
} from '@/shared/graph-context-types';
import { normalizePath } from '@/shared/path';

export interface GraphContextEvidenceInput {
  source: string;
  target: string;
  relation: GraphContextRelation;
  origin: 'AST' | 'MODULE_RESOLUTION' | 'INFERENCE';
  workspaceRoot: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  ambiguous?: boolean;
  stale?: boolean;
}

export function toEvidence(input: GraphContextEvidenceInput): GraphContextEdge {
  const sourcePath = toWorkspaceRelativePath(input.sourcePath, input.workspaceRoot);
  const sourceLine = normalizeLine(input.sourceLine);
  const sourceEndLine = sourceLine === undefined
    ? undefined
    : normalizeEndLine(input.sourceEndLine, sourceLine);
  const confidence = confidenceFor(input);
  const evidence = {
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(sourceLine === undefined ? {} : { sourceLine }),
    ...(sourceEndLine === undefined ? {} : { sourceEndLine }),
    reason: reasonFor(input, confidence),
  };

  return {
    source: input.source,
    target: input.target,
    relation: input.relation,
    confidence,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(sourceLine === undefined ? {} : { sourceLine }),
    ...(sourceEndLine === undefined ? {} : { sourceEndLine }),
    evidence,
  };
}

function confidenceFor(input: GraphContextEvidenceInput): GraphContextConfidence {
  if (input.ambiguous) return 'AMBIGUOUS';
  if (input.stale) return 'STALE';
  if (input.origin === 'MODULE_RESOLUTION') return 'RESOLVED';
  if (input.origin === 'INFERENCE') return 'INFERRED';
  return 'EXTRACTED';
}

function reasonFor(
  input: GraphContextEvidenceInput,
  confidence: GraphContextConfidence,
): string {
  if (confidence === 'AMBIGUOUS') {
    return `Unresolved ${input.relation} target has multiple resolver candidates.`;
  }
  if (confidence === 'STALE') return 'Source changed after this relation was indexed.';
  if (input.origin === 'MODULE_RESOLUTION') {
    return 'Import target resolved to a workspace file.';
  }
  if (input.origin === 'INFERENCE') {
    return `${input.relation} relation inferred from graph analysis.`;
  }
  return `${input.relation} relation extracted from the AST.`;
}

function toWorkspaceRelativePath(
  sourcePath: string | undefined,
  workspaceRoot: string,
): string | undefined {
  if (!sourcePath) return undefined;
  const normalizedPath = normalizePath(sourcePath);
  const normalizedRoot = normalizePath(workspaceRoot).replace(/\/$/, '');
  let relativePath = normalizedPath;

  if (isAbsolutePath(normalizedPath)) {
    if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return undefined;
    relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  }

  const normalizedRelativePath = normalizePath(relativePath).replace(/^\.\//, '');
  if (
    !normalizedRelativePath
    || normalizedRelativePath === '.'
    || normalizedRelativePath === '..'
    || normalizedRelativePath.startsWith('../')
    || isAbsolutePath(normalizedRelativePath)
  ) {
    return undefined;
  }
  return normalizedRelativePath;
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[a-zA-Z]:\//.test(filePath);
}

function normalizeLine(line: number | undefined): number | undefined {
  return Number.isInteger(line) && (line ?? 0) > 0 ? line : undefined;
}

function normalizeEndLine(endLine: number | undefined, startLine: number): number | undefined {
  return Number.isInteger(endLine) && (endLine ?? 0) >= startLine ? endLine : undefined;
}
