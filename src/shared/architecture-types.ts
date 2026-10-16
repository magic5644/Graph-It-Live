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

import type { ArchitectureOverview } from "../analyzer/architecture/ArchitectureExplorer";

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
}

/** Sets the find and min-imports controls as a user would (E2E driver only). */
export interface ArchitectureControlsMessage {
  type: "architectureControls";
  find?: string;
  minImports?: number;
}

export type ArchitectureExtensionMessage = ArchitectureStateMessage | ArchitectureSummaryMessage | ArchitectureControlsMessage;

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
  /** Group edges drawn, after the min-imports filter. */
  shownGroupEdges: number;
}

export type ArchitectureWebviewCommand =
  | ArchitectureMountedCommand
  | ArchitectureRefreshCommand
  | ArchitectureRenderedCommand
  | ArchitectureResizedCommand
  | ArchitectureInteractedCommand;
