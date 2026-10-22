/**
 * Extension ↔ webview message protocol for the Architecture view mode.
 *
 * Convention matches src/shared/callgraph-types.ts:
 *   - extension → webview: discriminated union on `type`
 *   - webview → extension: discriminated union on `command`
 *
 * Group ids are only valid for the `revision` they were computed with (Louvain ids
 * change between builds), so every message carrying ids carries it.
 */

import type { ArchitectureGroupDetail, ArchitectureOverview } from "../analyzer/architecture/ArchitectureExplorer";
import type { ArchitectureMatrix } from "../analyzer/architecture/architectureMatrix";
import type { ArchitectureRuleSummary, WorkspaceArchitectureCheck } from "../analyzer/architecture/architectureRules";
import type { ArchitectureUnitEdgeKind, ArchitectureUnits } from "../analyzer/architecture/architectureUnits";

/** The units level of a path-mode summary: what `graph-it architecture --level units` reports, plus the unit of each group. */
export type ArchitectureUnitLevel = Omit<ArchitectureUnits, "context"> & {
  /** Unit key of every group id of the summary. */
  groupUnits: Record<number, string>;
  /** Layer of every group within its unit. */
  groupLayers: Record<number, number>;
  /** Kind of every group edge inside a unit, keyed `from>to`. */
  groupEdgeKinds: Record<string, ArchitectureUnitEdgeKind>;
  /** Groups holding sub-folders: entering one asks for its level (architectureEnterFolder). */
  nestedGroups: number[];
};

/** The declared rules (graphit.architecture.json) checked against one level, as graph-it check-architecture reports them. */
export interface ArchitectureRulesView {
  configFile: string;
  /** Why the config was refused (JSON paths of its errors); nothing else is set then. */
  error?: string;
  totals?: WorkspaceArchitectureCheck["totals"];
  rules: ArchitectureRuleSummary[];
  configWarnings: string[];
  /** Rule names of every violating unit edge, keyed `from>to` by unit key. */
  unitEdges: Record<string, string[]>;
  /** Rule names of every violating group edge of the level, keyed `from>to` by group id. */
  groupEdges: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Extension → Webview messages
// ---------------------------------------------------------------------------

/** Build progress, or why there is no summary to show. */
export interface ArchitectureStateMessage {
  type: "architectureState";
  status: "building" | "empty" | "error";
  message?: string;
  /** 0-100, analysed / total files */
  percent?: number;
}

/** Collapsed groups of one build; every count comes from the full aggregation. */
export interface ArchitectureSummaryMessage extends ArchitectureOverview {
  type: "architectureSummary";
  /** context.revision of the build */
  revision: string;
  /** Source files changed since the build; only Refresh rebuilds. */
  stale: boolean;
  /** Path mode only: units drawn on top, each entered to show its groups. */
  units?: ArchitectureUnitLevel;
  /** With a graphit.architecture.json at the workspace root: its rules checked against this level. */
  rules?: ArchitectureRulesView;
}

/** The level below a unit or folder (answers architectureEnterFolder); its revision and folder go with every request made there. */
export interface ArchitectureFolderLevelMessage {
  type: "architectureFolderLevel";
  /** Revision of the summary the folder was entered from. */
  revision: string;
  /** Unit or folder key whose sub-folders and own files `level` draws. */
  folder: string;
  level: Omit<ArchitectureSummaryMessage, "type" | "stale">;
}

/** One page of an expanded group (answers architectureExpandGroup). */
export interface ArchitectureGroupDetailMessage {
  type: "architectureGroupDetail";
  revision: string;
  /** Entered folder of the request, if any. */
  folder?: string;
  detail: ArchitectureGroupDetail;
}

/** Workspace-relative file pairs behind one edge (answers architectureEvidence, architectureUnitEvidence and architectureRuleEvidence). */
export interface ArchitectureEvidencePageMessage {
  type: "architectureEvidencePage";
  revision: string;
  /** The violations of this rule, instead of an edge (from and to are then empty). */
  rule?: string;
  /** Group ids, or unit keys for a unit edge. */
  from: number | string;
  to: number | string;
  sourceFile?: string;
  targetFile?: string;
  pairs: { source: string; target: string }[];
  page: { total: number; offset: number; returned: number; truncated: boolean; nextOffset?: number };
}

/** The dependency structure matrix of one level (answers architectureMatrix); row ids are group ids, or unit keys at the units level. */
export interface ArchitectureMatrixMessage {
  type: "architectureMatrix";
  /** Revision and folder of the level the request named. */
  revision: string;
  folder?: string;
  /** Entered unit of the request, if any. */
  unit?: string;
  matrix: ArchitectureMatrix;
  /** matrixDigest of `matrix`, echoed by the webview's paint report (E2E). */
  digest: string;
  /** Rows holding sub-folders: a click on their header enters them (architectureEnterFolder). */
  nestedGroups: number[];
  /** Rule names of every cell breaking a declared rule, keyed `rowId>columnId`. */
  violations?: Record<string, string[]>;
}

/** Answers a request made with another revision: the webview drops its detail and asks for the summary again. */
export interface ArchitectureRevisionChangedMessage {
  type: "architectureRevisionChanged";
  currentRevision: string;
}

/** Drives the controls as a user would (E2E driver only); groups are named by key, `expand` enters a group as a double-click does. */
export interface ArchitectureControlsMessage {
  type: "architectureControls";
  /** Enters this unit, as a double-click on it does ("": back to the units); the other controls wait for the next message. */
  unit?: string;
  /** Enters this folder of the drawn level, as a double-click on it does ("": back up one level); the other controls wait. */
  folder?: string;
  find?: string;
  minImports?: number;
  expand?: string;
  collapse?: string;
  /** Focuses this group, as a click does (empty: back to the overview). */
  focus?: string;
  /** Selects the first edge of this expanded group (or, at the units level, of this unit), which opens its evidence. */
  evidenceOf?: string;
  /** Clicks the source of this evidence row. */
  openEvidenceRow?: number;
  /** Shows the graph or the matrix of the drawn level, as the toolbar toggle does. */
  view?: "graph" | "matrix";
  /** Clicks the matrix cell of these row and column keys (the evidence opens). */
  matrixCell?: { row: string; column: string };
  /** Clicks the matrix header of this row key (a unit or a folder holding sub-folders is entered). */
  matrixHeader?: string;
  /** Clicks this rule in the Rules panel (its violations open in the evidence panel). */
  rule?: string;
}

export type ArchitectureExtensionMessage =
  | ArchitectureStateMessage
  | ArchitectureSummaryMessage
  | ArchitectureFolderLevelMessage
  | ArchitectureGroupDetailMessage
  | ArchitectureEvidencePageMessage
  | ArchitectureMatrixMessage
  | ArchitectureRevisionChangedMessage
  | ArchitectureControlsMessage;

// ---------------------------------------------------------------------------
// Webview → Extension messages
// ---------------------------------------------------------------------------

/** The webview listens: the extension sends the cached summary or starts a build. */
export interface ArchitectureMountedCommand {
  command: "architectureMounted";
}

/** Rebuild now (Refresh, Retry). */
export interface ArchitectureRefreshCommand {
  command: "architectureRefresh";
}

/** What the webview rendered for a summary (E2E observability only). */
export interface ArchitectureRenderedCommand {
  command: "architectureRendered";
  revision: string;
  /** Group nodes drawn, the unassigned node included. */
  renderedGroups: number;
  renderedGroupEdges: number;
  communityMode: ArchitectureOverview["context"]["communityMode"];
  stale: boolean;
  /** Pairs of group nodes whose boxes intersect. */
  overlappingGroups: number;
  /** Group nodes whose label is drawn outside the node box. */
  overflowingLabels: number;
  /** Sorted `key@x,y` of every group node, to compare layouts across renders. */
  positions: string;
  /** Entered unit; undefined at the units level or without units. */
  unit?: string;
  /** Entered folder within the unit; undefined at the unit's top level. */
  folder?: string;
  /** What the units level draws, measured on the canvas once fitted. */
  unitLevel?: {
    units: number;
    /** Distinct unit colours. */
    colors: number;
    /** Drawn upward and cycle edges. */
    redEdges: number;
    /** Drawn down edges whose target is not below their source. */
    edgesNotDown: number;
    /** Drawn edges on their ELK route: the layout ran in its worker. */
    routedEdges: number;
    /** Unit edges hidden by the cap or the min-imports filter. */
    hiddenEdges: number;
    /** On-screen size of the node labels after the fit. */
    minLabelPx: number;
  };
  /** Drawn edges breaking a declared rule. */
  violationEdges?: number;
  /** The Rules panel as drawn: `name=count` per rule. */
  rules?: string[];
}

/** The graph was re-fitted to a resized view (E2E observability only). */
export interface ArchitectureResizedCommand {
  command: "architectureResized";
  width: number;
  height: number;
}

/** What the highlight and edge filter draw after an interaction (E2E observability only). */
export interface ArchitectureInteractedCommand {
  command: "architectureInteracted";
  /** Groups in the highlighted neighbourhood; 0 when nothing is highlighted. */
  highlightedGroups: number;
  fadedGroups: number;
  /** Group edges drawn with their count label. */
  labelledEdges: number;
  /** Group edges drawn, after the min-imports filter and the focus. */
  shownGroupEdges: number;
  /** File edges drawn: only those of the hovered or selected file. */
  shownFileEdges: number;
}

/** Asks for the level below a unit or folder key (path mode). */
export interface ArchitectureEnterFolderCommand {
  command: "architectureEnterFolder";
  /** The summary's revision. */
  revision: string;
  folder: string;
}

/** Asks for one page of a group's files (offset 0 expands it); `folder` and `revision` name the level the group id comes from. */
export interface ArchitectureExpandGroupCommand {
  command: "architectureExpandGroup";
  revision: string;
  folder?: string;
  groupId: number;
  offset?: number;
}

/** Asks for the file pairs behind an edge; a file restricts one end. */
export interface ArchitectureEvidenceCommand {
  command: "architectureEvidence";
  revision: string;
  folder?: string;
  from: number;
  to: number;
  sourceFile?: string;
  targetFile?: string;
  offset?: number;
}

/** Asks for the file pairs behind a unit edge, by unit key (path mode, units level). */
export interface ArchitectureUnitEvidenceCommand {
  command: "architectureUnitEvidence";
  /** The summary's revision. */
  revision: string;
  from: string;
  to: string;
  offset?: number;
}

/** Asks for the violating file pairs of one declared rule (the Rules panel). */
export interface ArchitectureRuleEvidenceCommand {
  command: "architectureRuleEvidence";
  /** The summary's revision. */
  revision: string;
  rule: string;
  offset?: number;
}

/** Asks for the matrix of the drawn level: `revision` and `folder` as for evidence, `unit` the entered unit (path mode). */
export interface ArchitectureMatrixCommand {
  command: "architectureMatrix";
  revision: string;
  folder?: string;
  unit?: string;
}

/** What the matrix shows (E2E and benchmark observability only). */
export interface ArchitectureMatrixRenderedCommand {
  command: "architectureMatrixRendered";
  revision: string;
  unit?: string;
  folder?: string;
  rows: number;
  /** Non-zero cells, the diagonal included, and the sum of their file pairs. */
  cells: number;
  fileEdges: number;
  upwardCells: number;
  cycles: number;
  /** Cell buttons in the DOM: the virtualised window, not the whole matrix. */
  renderedCells: number;
  /** Sorted `rowKey>columnKey=count` of every non-zero cell, to compare with the CLI. */
  digest: string;
  /** From the matrix's arrival (or the last scroll) to the next frame after the commit. */
  paintMs: number;
  /** What triggered the paint. */
  cause: "matrix" | "scroll";
  /** Cell buttons drawn as breaking a declared rule. */
  violationCells?: number;
}

/** Opens a workspace-relative file of the graph; never an absolute path. */
export interface ArchitectureOpenFileCommand {
  command: "architectureOpenFile";
  revision: string;
  folder?: string;
  relativePath: string;
}

/** What the expanded groups and the evidence panel show (E2E observability only). */
export interface ArchitectureDetailRenderedCommand {
  command: "architectureDetailRendered";
  expandedGroups: number;
  /** Files of the expanded groups, loaded or not. */
  expandedFileCount: number;
  renderedFiles: number;
  /** Edges with no file end. */
  groupLevelEdges: number;
  /** Groups drawn, collapsed or entered, after the focus. */
  visibleGroups: number;
  /** Group of the focus; undefined shows the whole architecture. */
  focusedGroup?: string;
  /** The 500-file cap message is shown. */
  capReached: boolean;
  /** `pairs`: the rows of the aria-label="Evidence" region, as `source → target`. */
  evidence?: { edgeCount: number; total: number; shown: number; firstSource?: string; title: string; pairs: string[] };
}

export type ArchitectureWebviewCommand =
  | ArchitectureMountedCommand
  | ArchitectureRefreshCommand
  | ArchitectureRenderedCommand
  | ArchitectureResizedCommand
  | ArchitectureInteractedCommand
  | ArchitectureEnterFolderCommand
  | ArchitectureExpandGroupCommand
  | ArchitectureEvidenceCommand
  | ArchitectureUnitEvidenceCommand
  | ArchitectureRuleEvidenceCommand
  | ArchitectureMatrixCommand
  | ArchitectureMatrixRenderedCommand
  | ArchitectureOpenFileCommand
  | ArchitectureDetailRenderedCommand;
