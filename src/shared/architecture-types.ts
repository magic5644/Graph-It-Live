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
import type { DependentFile, DependentGroup } from "../analyzer/architecture/groupDependents";

/** Groups drawn per level (per unit in path mode) until Show more groups; the largest first. */
export const DEFAULT_RENDERED_GROUPS = 50;
/** Groups drawn per level once Show more groups was clicked; beyond, they are counted in hiddenGroups. */
export const MAX_RENDERED_GROUPS = 150;

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
  /** By unit key: the unit's groups, and its groups and group edges left out by the cap. */
  groupsByUnit: Record<string, { totalGroups: number; hiddenGroups: number; hiddenGroupEdges: number }>;
  /** Unit keys of every cycle (strongly connected component of two or more units): each is drawn as one block. */
  cycleUnits?: string[][];
};

/** The declared rules (graphit.architecture.json) checked against one level, as graph-it check-architecture reports them. */
export interface ArchitectureRulesView {
  configFile: string;
  /** context.revision of the check (code, rules and baseline): a new one redraws the violations. */
  revision?: string;
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
  /** Groups drawn per level (per unit in path mode), largest first: DEFAULT_RENDERED_GROUPS until Show more groups. */
  maxGroups?: number;
  /** Drawn groups (the unassigned files included, id 0) with no drawn edge to a group of their level: drawn apart, below the graph. */
  isolatedGroups?: number[];
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

/** The groups left out by the cap that a find matches (answers architectureFind). */
export interface ArchitectureFoundMessage {
  type: "architectureFound";
  /** Revision, folder and unit of the request. */
  revision: string;
  folder?: string;
  unit?: string;
  query: string;
  /** Labels of the first matching hidden groups, largest first. */
  matches: string[];
  /** Every matching hidden group. */
  total: number;
}

/**
 * What "Dependents by group" starts from: a file of the graph, a group of the drawn level (its id
 * is only valid with the request's revision and folder), or a unit (path mode, all its files).
 */
export type ArchitectureDependentsSeed =
  | { kind: "file"; relativePath: string }
  | { kind: "group"; groupId: number }
  | { kind: "unit"; key: string };

/**
 * The files depending on a seed through static imports, grouped as the request's level draws
 * them (answers architectureDependents): by unit at the units level, else by the level's groups,
 * the files outside an entered folder by the summary's groups. Group keys, not ids, name them.
 */
export interface ArchitectureDependentsResultMessage {
  type: "architectureDependentsResult";
  /** Revision, folder, unit and seed of the request. */
  revision: string;
  folder?: string;
  unit?: string;
  seed: ArchitectureDependentsSeed;
  seedLabel: string;
  /** Group keys of the seed's files, reported apart in insideSeedGroup. */
  seedGroups: string[];
  /** Every file reached, the seed's own groups included. */
  reachedFiles: number;
  /** Reached files and groups outside the seed's own groups: the panel's header. */
  totals: { files: number; groups: number };
  groups: DependentGroup[];
  insideSeedGroup: { directFiles: number; transitiveFiles: number };
  maxDepthReached: boolean;
  provenance: string;
}

/** One page of a dependent group's files (answers architectureDependentFiles). */
export interface ArchitectureDependentFilesPageMessage {
  type: "architectureDependentFilesPage";
  revision: string;
  folder?: string;
  unit?: string;
  seed: ArchitectureDependentsSeed;
  groupKey: string;
  files: DependentFile[];
  page: { total: number; offset: number; returned: number; truncated: boolean; nextOffset?: number };
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
  /** Clicks this role in the units' role legend: only its units stay drawn, a second click shows them all. */
  role?: string;
  /** Clicks Show more groups. */
  showMoreGroups?: boolean;
  /** Selects this drawn group or unit key, or this drawn file, then runs Dependents by group on it. */
  dependentsOf?: string;
  /** Selects this drawn file, then runs Show in Dependency Graph on it. */
  revealFile?: string;
  /** Clears the dependents highlight and panel. */
  clearDependents?: boolean;
  /** Clicks this zoom control of the canvas overlay. */
  zoom?: "fit" | "in" | "out";
  /** Focuses the canvas, then presses these keys on it, one after the other (keyboard navigation). */
  keys?: string[];
  /** Clicks this unit in the units legend (it is selected and centred). */
  legendUnit?: string;
  /** Clicks the header's cycle count: the first cycle block is selected and fitted. */
  cycleCount?: boolean;
}

export type ArchitectureExtensionMessage =
  | ArchitectureStateMessage
  | ArchitectureSummaryMessage
  | ArchitectureFolderLevelMessage
  | ArchitectureGroupDetailMessage
  | ArchitectureEvidencePageMessage
  | ArchitectureMatrixMessage
  | ArchitectureFoundMessage
  | ArchitectureDependentsResultMessage
  | ArchitectureDependentFilesPageMessage
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

/** Opens the extension's settings (the empty state's action). */
export interface ArchitectureOpenSettingsCommand {
  command: "architectureOpenSettings";
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
    /** Units drawn with a role badge, and with their role's evidence in the tooltip. */
    roleBadges: number;
    roleTooltips: number;
    /** Units left by the role filter. */
    shownUnits: number;
    /** Layer bands drawn behind the rows, and units whose centre lies outside their layer's band. */
    layerBands?: number;
    unitsOutsideBand?: number;
    /** Cycle blocks drawn, and cycle members drawn outside their block. */
    cycleBlocks?: number;
    cycleMembersOutside?: number;
    /** Lowest WCAG contrast of a unit label over its fill blended on the view background. */
    minLabelContrast?: number;
    /** Drawn upward and cycle edges showing their count without a hover. */
    labelledRedEdges?: number;
  };
  /** Drawn edges breaking a declared rule. */
  violationEdges?: number;
  /** The Rules panel as drawn: `name=count` per rule. */
  rules?: string[];
  /** The role legend as drawn: `role=count` per role, `*` after the filtered one. */
  roles?: string[];
  /** Height of everything above the canvas (header, controls, breadcrumb), and of the whole view. */
  headerHeightPx?: number;
  viewHeightPx?: number;
  /** The legend overlay reaches past the canvas instead of scrolling, and its list scrolls inside it. */
  legendOverflowing?: boolean;
  legendScrolls?: boolean;
  /** `width=…`, then the height of each row above the canvas (`label=px`). */
  headerRows?: string[];
  /** Zoom of the canvas once fitted. */
  zoom?: number;
  /** A group level (not the units), as its header and canvas show it once laid out. */
  groupLevel?: {
    /** The header's `shown of total` groups, and the groups and group edges it says are hidden. */
    shownGroups: number;
    totalGroups: number;
    hiddenGroups: number;
    hiddenGroupEdges: number;
    /** Groups the header announces without cross-group imports, and how many of them are drawn below every other group. */
    isolatedGroups: number;
    isolatedBelow: number;
    /** On-screen size of the node labels. */
    minLabelPx: number;
  };
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
  /** Groups selected (click, arrow keys) and found (Find), and those of them drawn with their focus ring. */
  selectedGroups?: number;
  foundGroups?: number;
  ringedGroups?: number;
  /** Text of the canvas's live region (what a screen reader announces). */
  announcement?: string;
  /** The canvas has the keyboard focus. */
  canvasFocused?: boolean;
  /** Zoom of the canvas. */
  zoom?: number;
}

/** Draws up to MAX_RENDERED_GROUPS groups per level from now on (Show more groups); the summary and entered levels are sent again. */
export interface ArchitectureShowMoreGroupsCommand {
  command: "architectureShowMoreGroups";
  revision: string;
}

/** Asks which groups left out by the cap match a find, at the level `revision`, `folder` and `unit` name. */
export interface ArchitectureFindCommand {
  command: "architectureFind";
  revision: string;
  folder?: string;
  unit?: string;
  query: string;
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
  /** Non-zero cells breaking a declared rule, in the whole matrix. */
  violationCells?: number;
}

/** Opens a workspace-relative file of the graph; never an absolute path. */
export interface ArchitectureOpenFileCommand {
  command: "architectureOpenFile";
  revision: string;
  folder?: string;
  relativePath: string;
}

/** Opens a file of the graph (as architectureOpenFile) and shows it in the file Dependency Graph. */
export interface ArchitectureRevealInFileGraphCommand {
  command: "architectureRevealInFileGraph";
  revision: string;
  folder?: string;
  relativePath: string;
}

/** Asks which groups depend on a seed; `revision`, `folder` and `unit` name the drawn level. */
export interface ArchitectureDependentsCommand {
  command: "architectureDependents";
  revision: string;
  folder?: string;
  unit?: string;
  seed: ArchitectureDependentsSeed;
}

/** Asks for one page of a dependent group's files, by group key. */
export interface ArchitectureDependentFilesCommand {
  command: "architectureDependentFiles";
  revision: string;
  folder?: string;
  unit?: string;
  seed: ArchitectureDependentsSeed;
  groupKey: string;
  offset?: number;
}

/** What the dependents panel and highlight show (E2E observability only). */
export interface ArchitectureDependentsRenderedCommand {
  command: "architectureDependentsRendered";
  /** Empty once cleared. */
  seedLabel: string;
  /** The panel's rows as drawn: `key=direct/transitive@minDepth`. */
  rows: string[];
  /** Drawn groups (or matrix rows) highlighted as dependents. */
  highlightedGroups: number;
  view: "graph" | "matrix";
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
  /** The find's result line, as drawn (empty without one). */
  findStatus?: string;
  /** `zoom@x,y` of the canvas after the render and its fit. */
  viewport?: string;
  /** `pairs`: the rows of the aria-label="Evidence" region, as `source → target`. */
  evidence?: { edgeCount: number; total: number; shown: number; firstSource?: string; title: string; pairs: string[] };
}

export type ArchitectureWebviewCommand =
  | ArchitectureMountedCommand
  | ArchitectureRefreshCommand
  | ArchitectureOpenSettingsCommand
  | ArchitectureRenderedCommand
  | ArchitectureResizedCommand
  | ArchitectureInteractedCommand
  | ArchitectureEnterFolderCommand
  | ArchitectureShowMoreGroupsCommand
  | ArchitectureFindCommand
  | ArchitectureExpandGroupCommand
  | ArchitectureEvidenceCommand
  | ArchitectureUnitEvidenceCommand
  | ArchitectureRuleEvidenceCommand
  | ArchitectureMatrixCommand
  | ArchitectureMatrixRenderedCommand
  | ArchitectureOpenFileCommand
  | ArchitectureRevealInFileGraphCommand
  | ArchitectureDependentsCommand
  | ArchitectureDependentFilesCommand
  | ArchitectureDependentsRenderedCommand
  | ArchitectureDetailRenderedCommand;
