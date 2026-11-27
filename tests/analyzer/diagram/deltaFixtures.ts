import type { ArchitectureStructureDiff, StructureCount, StructureCycleDiff, StructureEdgeDiff, StructureItemDiff } from "@/shared/architecture-model";
import type { ArchitectureReview, ArchitectureRuleReview } from "@/analyzer/architecture/architectureReview";
import type { ArchitectureDeltaSource } from "@/analyzer/ReviewGateAnalyzer";

export interface DeltaParts {
  items?: StructureItemDiff[];
  edges?: StructureEdgeDiff[];
  cycles?: StructureCycleDiff[];
  movedFiles?: number;
  unchangedEdges?: number;
  rules?: Partial<ArchitectureRuleReview>[];
  warnings?: string[];
  verdict?: "changed" | "unchanged";
}

/** `count` on the side the status has (ADDED after, REMOVED before); a matched item goes from `count` to `changed`. */
function sided(status: string, count: number, changed: number): StructureCount {
  if (status === "ADDED") return { after: count };
  if (status === "REMOVED") return { before: count };
  return { before: count, after: changed };
}

export const item = (status: StructureItemDiff["status"], key: string, extra: Partial<StructureItemDiff> = {}): StructureItemDiff => ({
  status, key, name: key,
  fileCount: sided(status, 3, 4),
  ...extra,
});

export const edge = (status: StructureEdgeDiff["status"], from: string, to: string, extra: Partial<StructureEdgeDiff> = {}): StructureEdgeDiff => ({
  status, from, to, pairs: sided(status, 2, 5), ...extra,
});

const pair = (from: string, to: string) => ({ source: `${from}/a.ts`, target: `${to}/b.ts`, from, to });

export const rule = (name: string, extra: { new?: [string, string, boolean?][]; resolved?: [string, string][] }): Partial<ArchitectureRuleReview> => ({
  name, kind: "forbid", severity: "error", reason: "r",
  newViolations: (extra.new ?? []).map(([from, to, accepted]) => ({ ...pair(from, to), accepted: accepted === true })),
  resolvedViolations: (extra.resolved ?? []).map(([from, to]) => pair(from, to)),
  unchanged: 0,
});

export function deltaSource(parts: DeltaParts = {}): ArchitectureDeltaSource {
  const items = parts.items ?? [];
  const edges = parts.edges ?? [];
  const structure = {
    verdict: parts.verdict ?? "changed",
    units: {
      items, edges, cycles: parts.cycles ?? [],
      movedFiles: Array.from({ length: parts.movedFiles ?? 0 }, (_, index) => ({ file: `f${index}.ts`, from: "a", to: "b" })),
      compared: { items: { before: items.length, after: items.length }, edges: { before: edges.length, after: edges.length }, unchangedItems: 0, unchangedEdges: parts.unchangedEdges ?? 0 },
    },
    groups: { items: [], edges: [], cycles: [], movedFiles: [], compared: { items: {}, edges: {}, unchangedItems: 0, unchangedEdges: 0 } },
    files: { before: 1, after: 1 }, renames: { mapped: 0, complete: true }, warnings: parts.warnings ?? [],
  } as ArchitectureStructureDiff;
  const rules = (parts.rules ?? []) as ArchitectureRuleReview[];
  const architecture = {
    verdict: "unchanged", configFile: "graphit.architecture.json", newErrors: 0, rules,
    unitCycles: { newViolations: [], resolvedViolations: [], unchanged: 0 },
  } as ArchitectureReview;
  return { baseRef: "main", headRef: "feature", structure, architecture, limitations: [] };
}
