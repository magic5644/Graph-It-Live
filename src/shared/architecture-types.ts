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
import type { ArchitectureUnitEdgeKind, ArchitectureUnits } from "../analyzer/architecture/architectureUnits";

/** The units level of a path-mode summary: what `graph-it architecture --level units` reports, plus the unit of each group. */
export type ArchitectureUnitLevel = Omit<ArchitectureUnits, "context"> & {
  /** Unit key of every group id of the summary. */
  groupUnits: Record<number, string>;
  /** Layer of every group within its unit. */
  groupLayers: Record<number, number>;
  /** Kind of every group edge inside a unit, keyed `from>to`. */
  groupEdgeKinds: Record<string, ArchitectureUnitEdgeKind>;
};

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
}

/** One page of an expanded group (answers architectureExpandGroup). */
export interface ArchitectureGroupDetailMessage {
  type: "architectureGroupDetail";
  revision: string;
  detail: ArchitectureGroupDetail;
}

/** Workspace-relative file pairs behind one edge (answers architectureEvidence). */
export interface ArchitectureEvidencePageMessage {
  type: "architectureEvidencePage";
  revision: string;
  from: number;
  to: number;
  sourceFile?: string;
  targetFile?: string;
  pairs: { source: string; target: string }[];
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
  find?: string;
  minImports?: number;
  expand?: string;
  collapse?: string;
  /** Focuses this group, as a click does (empty: back to the overview). */
  focus?: string;
  /** Selects the first edge of this expanded group, which opens its evidence. */
  evidenceOf?: string;
  /** Clicks the source of this evidence row. */
  openEvidenceRow?: number;
}

export type ArchitectureExtensionMessage =
  | ArchitectureStateMessage
  | ArchitectureSummaryMessage
  | ArchitectureGroupDetailMessage
  | ArchitectureEvidencePageMessage
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

/** Asks for one page of a group's files (offset 0 expands it). */
export interface ArchitectureExpandGroupCommand {
  command: "architectureExpandGroup";
  revision: string;
  groupId: number;
  offset?: number;
}

/** Asks for the file pairs behind an edge; a file restricts one end. */
export interface ArchitectureEvidenceCommand {
  command: "architectureEvidence";
  revision: string;
  from: number;
  to: number;
  sourceFile?: string;
  targetFile?: string;
  offset?: number;
}

/** Opens a workspace-relative file of the graph; never an absolute path. */
export interface ArchitectureOpenFileCommand {
  command: "architectureOpenFile";
  revision: string;
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
  evidence?: { edgeCount: number; total: number; shown: number; firstSource?: string };
}

export type ArchitectureWebviewCommand =
  | ArchitectureMountedCommand
  | ArchitectureRefreshCommand
  | ArchitectureRenderedCommand
  | ArchitectureResizedCommand
  | ArchitectureInteractedCommand
  | ArchitectureExpandGroupCommand
  | ArchitectureEvidenceCommand
  | ArchitectureOpenFileCommand
  | ArchitectureDetailRenderedCommand;
