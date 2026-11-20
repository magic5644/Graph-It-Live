/**
 * Results of the architecture analysis (src/analyzer/architecture): what the CLI, MCP tools and
 * the extension's Architecture view report, and the webview draws. The analyzer functions are
 * annotated with these types, so the compiler keeps them in sync with what they return.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic and imports nothing
 * outside src/shared.
 */

import type { CommunityMode } from "./graph-types";

// ---------------------------------------------------------------------------
// Graph and community groups
// ---------------------------------------------------------------------------

/** What an architecture graph was built from; group ids are only valid for its `revision`. */
export interface ArchitectureGraphContext {
  communityMode: CommunityMode;
  revision: string;
  graphKind: string;
  scope: string;
  exclusions: string;
  indexedAt: string | undefined;
  maxFiles: number | undefined;
  truncated: boolean;
  failedFiles: number;
}

export interface CommunityGroup {
  id: number;
  key: string;
  /** Legend label; the communityKey today, kept separate so renderers never parse keys. */
  label: string;
  fileCount: number;
  /** Distinct directed file pairs with both ends in this group. */
  internalEdgeCount: number;
}

export interface CommunityGroupEdge {
  from: number;
  to: number;
  /** Distinct directed file pairs from a file of `from` to a file of `to`. */
  fileEdgeCount: number;
}

export interface CommunityGroupAggregation {
  groups: CommunityGroup[];
  /** Files with communityId 0 (no domain, or isolated under Louvain). */
  unassigned: { fileCount: number; internalEdgeCount: number };
  /** Inter-group edges; group 0 stands for the unassigned files. */
  groupEdges: CommunityGroupEdge[];
  /** intraGroupEdges + interGroupEdges === fileEdges; unassigned→unassigned pairs count as intra. */
  totals: { files: number; fileEdges: number; intraGroupEdges: number; interGroupEdges: number };
}

/** A group edge with both group labels, so renderers never look groups up. */
export interface LabelledGroupEdge extends CommunityGroupEdge {
  fromLabel: string;
  toLabel: string;
}

/** Every group edge between the largest groups (overviewArchitecture). */
export interface ArchitectureOverview {
  context: ArchitectureGraphContext;
  provenance: { facts: string; grouping: string; interpretation: string };
  scannedFiles: number;
  analyzedFiles: number;
  totals: CommunityGroupAggregation["totals"];
  unassigned: CommunityGroupAggregation["unassigned"];
  groups: CommunityGroup[];
  groupEdges: LabelledGroupEdge[];
  totalGroups: number;
  hiddenGroups: number;
  hiddenGroupEdges: number;
}

/** One page of a group's files with the file pairs across its boundary (groupDetail). */
export interface ArchitectureGroupDetail {
  context: ArchitectureGraphContext;
  group: CommunityGroup;
  files: { relativePath: string; dependencyCount: number; dependentCount: number }[];
  internalPairs: { source: string; target: string }[];
  outgoingPairs: { source: string; target: string; toGroup: number }[];
  outgoing: { relativePath: string; toGroup: number; fileEdgeCount: number }[];
  incoming: { relativePath: string; fromGroup: number; fileEdgeCount: number }[];
  page: { total: number; offset: number; returned: number; truncated: boolean; nextOffset: number | undefined; limit: number };
}

// ---------------------------------------------------------------------------
// Units and roles
// ---------------------------------------------------------------------------

/** In priority order: a unit matching several roles takes the first. */
export const UNIT_ROLES = ["application", "function", "micro-frontend", "frontend", "service", "library", "test", "fixture", "tooling", "unknown"] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];

export interface UnitRoleEvidence {
  /** The role this piece of evidence points to; the unit's role is the first by priority. */
  role: UnitRole;
  detail: string;
}

export interface UnitRoleInfo {
  role: UnitRole;
  /** `declared` in graphit.architecture.json, else `inferred` from the evidence. */
  confidence: "inferred" | "declared";
  evidence: UnitRoleEvidence[];
}

/** One rule's result on a unit edge, or on the pairs leaving a unit. */
export interface UnitRuleCheck {
  name: string;
  kind: ArchitectureRuleKind;
  severity: "error" | "warning";
  /** File pairs of the edge (or leaving the unit) the rule checks. */
  checkedPairs: number;
  violations: number;
  newViolations: number;
  /** violated: a new violation; accepted: violations, all in the baseline; pass: none. */
  verdict: "pass" | "accepted" | "violated";
}

export interface ArchitectureUnit {
  /** manifests: folder or "(root)"; elements: element name, "element (instance)" with each, or "(unmatched)". */
  key: string;
  /** Manifest name (package.json `name`...), else the folder; for elements the element name. */
  name: string;
  /** Folder holding every file of the unit; "" for (root), (unmatched) or files across top-level folders. Paths for commands come from here, never from key. */
  folder: string;
  fileCount: number;
  /** Distinct directed file pairs with both ends in this unit. */
  internalEdgeCount: number;
  /** 0 = depends on no other unit; units in one cycle share a layer. */
  layer: number;
  role: UnitRole;
  confidence: UnitRoleInfo["confidence"];
  evidence: UnitRoleInfo["evidence"];
  /** forbid/allowOnly rules whose `from` names this unit's element, over the pairs leaving it. */
  rules?: UnitRuleCheck[];
}

/** `upward`: to a unit at the same or a higher layer; `cycle`: both units in one cycle. */
export type ArchitectureUnitEdgeKind = "down" | "upward" | "cycle";

/**
 * How a unit cycle runs: `type-only` when every import between its units is type-only (#740),
 * `lazy` when the units no longer form a cycle without their dynamic import() pairs (#741).
 */
export type UnitCycleKind = "runtime" | "type-only" | "lazy";

export interface ArchitectureUnitEdge {
  from: string;
  to: string;
  /** Distinct directed file pairs from a file of `from` to a file of `to`. */
  fileEdgeCount: number;
  kind: ArchitectureUnitEdgeKind;
  /** File pairs whose every import is type-only (#745); absent when none. */
  typeOnlyEdgeCount?: number;
  /** Cycle edges only: how the cycle the edge belongs to runs (#745). */
  cycleKind?: UnitCycleKind;
  /** Rules that check at least one pair of this edge, by config order. */
  rules?: UnitRuleCheck[];
  /** Worst verdict of `rules`; absent without rules. */
  ruleVerdict?: UnitRuleCheck["verdict"];
}

/** Units, layers and unit → unit edges of an architecture graph (buildArchitectureUnits). */
export interface ArchitectureUnits {
  context: ArchitectureGraphContext;
  units: ArchitectureUnit[];
  unitEdges: ArchitectureUnitEdge[];
  upwardEdges: number;
  /** Groups of two or more units that depend on each other. */
  cycles: number;
  /** Distinct layers of the units. */
  layerCount: number;
  /** Units per role, in role priority order; roles no unit has are left out. */
  roleCounts: Partial<Record<UnitRole, number>>;
  totals: { files: number; fileEdges: number; intraUnitEdges: number; interUnitEdges: number };
  /** elements: the declared elements of graphit.architecture.json; manifests: the detected projects. */
  unitsFrom: "elements" | "manifests";
  configFile?: string;
  baselineFile?: string;
  /** Present whenever a config was read; the check's warnings plus (unmatched) and overlap warnings. */
  configWarnings?: string[];
  /** Every rule of the config with its totals; absent without rules. */
  rules?: ArchitectureRuleSummary[];
}

// ---------------------------------------------------------------------------
// Dependency structure matrix
// ---------------------------------------------------------------------------

/** Formulas stated with the numbers, never a verdict (#300). */
export const MATRIX_FORMULAS = {
  order: "Rows and columns share one order: layer 0 first (depends on no other row), the rows of a cycle together, then by label.",
  cell: "Cell (row, column) = distinct file pairs where a file of the row imports a file of the column; the diagonal counts the pairs inside the row.",
  upward: "In this order every dependency sits below the diagonal; a cell above it (upward) belongs to a cycle.",
  instability: "I = Ce / (Ca + Ce), Ce = outgoingPairs (efferent), Ca = incomingPairs (afferent), diagonal excluded; null when both are 0.",
};

export interface MatrixNode<Id> {
  id: Id;
  key: string;
  label: string;
  /** Distinct file pairs with both ends in this node: its diagonal cell. */
  internalEdgeCount: number;
}

export interface MatrixRow<Id> extends MatrixNode<Id> {
  layer: number;
  /** Index in `cycles` of the cycle this row belongs to. */
  cycle?: number;
  /** Ce: file pairs from this row to the other rows, and the rows they reach. */
  outgoingPairs: number;
  outgoingGroups: number;
  /** Ca: file pairs from the other rows to this row, and the rows they come from. */
  incomingPairs: number;
  incomingGroups: number;
  /** Ce / (Ca + Ce), rounded to 2 decimals; null without any pair across the row's boundary. */
  instability: number | null;
}

export interface MatrixCell {
  /** Row and column indexes in `rows`. */
  row: number;
  column: number;
  fileEdgeCount: number;
  /** Of `fileEdgeCount`, the pairs whose every import is type-only (#745); absent when none. */
  typeOnlyEdgeCount?: number;
  /** Above the diagonal: the row imports a row placed after it. */
  upward: boolean;
}

export interface ArchitectureMatrix<Id extends number | string = number | string> {
  rows: MatrixRow<Id>[];
  /** Non-zero cells only, the diagonal included, by row then column. */
  cells: MatrixCell[];
  /** Groups of two or more rows that depend on each other; their rows are contiguous. */
  cycles: { firstRow: number; lastRow: number; members: string[] }[];
  totals: { rows: number; cells: number; fileEdges: number; intraEdges: number; interEdges: number; upwardCells: number };
  formulas: typeof MATRIX_FORMULAS;
}

// ---------------------------------------------------------------------------
// Coupling: most coupled pairs and bridging files (#342)
// ---------------------------------------------------------------------------

export const COUPLING_FORMULAS = {
  coupledPair: "Pair weight fileEdgeCount = aToB + bToA, the distinct file pairs between the two rows in both directions; mutual when both are above 0.",
  bridgingFile: "A file bridges when its import pairs (imports or importedBy) cross into 2 or more rows other than its own; groupCount = those rows, fileEdgeCount = their pairs.",
  evidence: "The first file pairs (source, target) by path, at most 3 per item; the counts cover every pair.",
};

export interface FilePair {
  source: string;
  target: string;
}

/** Two rows of the level coupled by file pairs, `a` before `b` in the matrix order. */
export interface CoupledPair<Id> {
  a: Id;
  b: Id;
  aLabel: string;
  bLabel: string;
  aToB: number;
  bToA: number;
  fileEdgeCount: number;
  mutual: boolean;
  evidence: FilePair[];
}

export interface BridgingFile<Id> {
  file: string;
  group: Id;
  groupLabel: string;
  groupCount: number;
  fileEdgeCount: number;
  /** One entry per other row the file touches, in the matrix order. */
  links: { group: Id; label: string; imports: number; importedBy: number; evidence: FilePair[] }[];
}

export interface ArchitectureCoupling<Id extends number | string = number | string> {
  /** Heaviest first; every pair of rows joined by at least one file pair. */
  coupledPairs: CoupledPair<Id>[];
  /** Most rows touched first, then most pairs, then by path. */
  bridgingFiles: BridgingFile<Id>[];
  formulas: typeof COUPLING_FORMULAS;
}

// ---------------------------------------------------------------------------
// Declared rules (graphit.architecture.json)
// ---------------------------------------------------------------------------

export const ARCHITECTURE_RULE_KINDS = ["forbid", "allowOnly", "noCycles"] as const;
export type ArchitectureRuleKind = (typeof ARCHITECTURE_RULE_KINDS)[number];

export interface ArchitectureRuleSummary {
  name: string;
  kind: ArchitectureRuleKind;
  severity: "error" | "warning" | "off";
  reason?: string;
  /** Violating file pairs, and those absent from the baseline. */
  violations: number;
  newViolations: number;
  /** Distinct element (or unit) pairs of the violations, most pairs first. */
  elementPairs: { from: string; to: string; count: number }[];
}

export interface ArchitectureCheckTotals {
  files: number;
  unmatchedFiles: number;
  rules: number;
  brokenRules: number;
  violations: number;
  newViolations: number;
  errors: number;
  newErrors: number;
  warnings: number;
  resolved: number;
}

// ---------------------------------------------------------------------------
// Dependents by group
// ---------------------------------------------------------------------------

export interface DependentGroup {
  /** Group key ("" for the unassigned files). */
  key: string;
  label: string;
  /** Files importing a seed file directly (depth 1). */
  directFiles: number;
  /** Every reached file of the group. */
  transitiveFiles: number;
  minDepth: number;
}

export interface DependentFile {
  relativePath: string;
  /** 1 = imports a seed file directly. */
  depth: number;
}
