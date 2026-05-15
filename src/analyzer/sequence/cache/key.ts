import { createHash } from "node:crypto";

import { normalizePath } from "@/shared/path";

export interface SequenceCacheKeyInput {
  workspaceRoot: string;
  filePath: string;
  symbolName: string;
  maxDepth: number;
  maxSteps: number;
  includeExternal: boolean;
  includeAnnotations: boolean;
  engineVersion: string;
}

function normalizeBoolean(value: boolean): "1" | "0" {
  return value ? "1" : "0";
}

function canonicalize(input: SequenceCacheKeyInput): string {
  return [
    `v=${input.engineVersion}`,
    `ws=${normalizePath(input.workspaceRoot)}`,
    `file=${normalizePath(input.filePath)}`,
    `symbol=${input.symbolName}`,
    `depth=${input.maxDepth}`,
    `steps=${input.maxSteps}`,
    `external=${normalizeBoolean(input.includeExternal)}`,
    `annotations=${normalizeBoolean(input.includeAnnotations)}`,
  ].join("|");
}

export function buildSequenceCacheKey(input: SequenceCacheKeyInput): string {
  return createHash("sha256").update(canonicalize(input), "utf8").digest("hex");
}
