import * as fs from "node:fs";
import * as path from "node:path";
import {
  exploreArchitecture,
  exploreArchitectureCheck,
  exploreUnitEvidence,
  groupDetail,
  overviewArchitecture,
  type ArchitectureOverview,
} from "@/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { groupMatrix, matrixDigest, unitMatrix, type ArchitectureMatrix } from "@/analyzer/architecture/architectureMatrix";
import {
  ARCHITECTURE_BASELINE_FILE,
  ARCHITECTURE_CONFIG_FILE,
  checkWorkspaceArchitecture,
  loadDeclaredRoles,
  rulesByEdge,
  type WorkspaceArchitectureCheck,
} from "@/analyzer/architecture/architectureRules";
import {
  assignUnits,
  buildArchitectureUnits,
  groupByUnit,
  layerGroupsWithinUnits,
  type ArchitectureUnits,
  type UnitAssignment,
} from "@/analyzer/architecture/architectureUnits";
import type { DeclaredRoles } from "@/analyzer/architecture/unitRoles";
import { aggregateCommunityGroups } from "@/analyzer/community/groupAggregation";
import type { IndexerStatusSnapshot } from "@/analyzer/IndexerStatus";
import {
  DEFAULT_RENDERED_GROUPS,
  MAX_RENDERED_GROUPS,
  type ArchitectureControlsMessage,
  type ArchitectureDetailRenderedCommand,
  type ArchitectureEnterFolderCommand,
  type ArchitectureEvidenceCommand,
  type ArchitectureExtensionMessage,
  type ArchitectureFindCommand,
  type ArchitectureInteractedCommand,
  type ArchitectureMatrixCommand,
  type ArchitectureMatrixRenderedCommand,
  type ArchitectureOpenFileCommand,
  type ArchitectureRenderedCommand,
  type ArchitectureRuleEvidenceCommand,
  type ArchitectureRulesView,
  type ArchitectureSummaryMessage,
  type ArchitectureUnitEvidenceCommand,
  type ArchitectureWebviewCommand,
} from "@/shared/architecture-types";
import type { CommunityMode } from "@/shared/graph-types";
import { normalizePath } from "@/shared/path";
import { validateWorkspacePath } from "@/shared/pathSecurity";

const PROGRESS_INTERVAL_MS = 250;
const BUSY_INDEX_STATES = new Set<IndexerStatusSnapshot["state"]>(["counting", "indexing", "validating"]);

export interface ArchitectureViewServiceOptions {
  workspaceRoot: string;
  analyzeFile: AnalyzeFile;
  readCommunityMode: () => CommunityMode;
  subscribeToIndexStatus: (callback: (snapshot: IndexerStatusSnapshot) => void) => () => void;
  post: (message: ArchitectureExtensionMessage) => void;
  /** Opens a validated absolute path in an editor. */
  openFile: (absolutePath: string) => Promise<void>;
  warn: (message: string) => void;
}

/** Masks the workspace root in every separator form a Node error message may use on Windows. */
export function maskWorkspaceRoot(message: string, workspaceRoot: string): string {
  if (!workspaceRoot) return message;
  const forms = new Set([
    workspaceRoot,
    workspaceRoot.replaceAll("\\", "/"),
    workspaceRoot.replaceAll("/", "\\"),
    normalizePath(workspaceRoot),
  ]);
  return [...forms].reduce((text, form) => text.replaceAll(form, "<workspace>"), message);
}

/** Resolves once the reverse index is not being built, so both do not compete for the Spider. */
function waitForIdleIndex(
  options: ArchitectureViewServiceOptions,
  signal: AbortSignal,
  onBusy: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Architecture build aborted"));
    signal.addEventListener("abort", onAbort);
    // subscribe notifies the current state synchronously, possibly before it returns.
    let notifiedBusy = false;
    unsubscribe = options.subscribeToIndexStatus((snapshot) => {
      if (!BUSY_INDEX_STATES.has(snapshot.state)) finish();
      else if (!notifiedBusy) {
        notifiedBusy = true;
        onBusy();
      }
    });
    if (done) unsubscribe();
  });
}

/** Inside a unit or folder, a group is named by its sub-folder; the parent's own files by the parent. */
function groupLabel(group: { key: string }, parent: string, parentName: string): string {
  return group.key === parent ? parentName : group.key.slice(parent.length + 1);
}

/** A group the cap leaves out: named for the find only. */
interface HiddenGroup {
  key: string;
  label: string;
  /** Unit key in path mode, else "". */
  unit: string;
}

interface LevelGraph {
  graph: ArchitectureGraph;
  files: Set<string>;
  hidden: HiddenGroup[];
}

type ViewLevel = Omit<ArchitectureSummaryMessage, "type" | "stale"> & { graph: ArchitectureGraph; hidden: HiddenGroup[] };

type OverviewGroup = ArchitectureOverview["groups"][number];
type OverviewEdge = ArchitectureOverview["groupEdges"][number];

/**
 * Keeps the `maxGroups` largest groups of each unit ("" for every group without units) and the
 * edges between kept groups, the unassigned files (id 0) always kept. A kept group with no kept
 * edge to a group of its unit is isolated (drawn apart); the others are hidden, counted per unit.
 */
function capGroups(groups: readonly OverviewGroup[], edges: readonly OverviewEdge[], maxGroups: number, unitOf: (id: number) => string, unassigned: boolean) {
  // Groups come largest first.
  const perUnit = new Map<string, number>();
  const kept = groups.filter((group) => {
    const count = (perUnit.get(unitOf(group.id)) ?? 0) + 1;
    perUnit.set(unitOf(group.id), count);
    return count <= maxGroups;
  });
  const keptIds = new Set([0, ...kept.map((group) => group.id)]);
  const isKept = (edge: OverviewEdge) => keptIds.has(edge.from) && keptIds.has(edge.to);
  const groupEdges = edges.filter(isKept);
  const linked = new Set(groupEdges.filter((edge) => unitOf(edge.from) === unitOf(edge.to)).flatMap((edge) => [edge.from, edge.to]));
  const drawn = unassigned ? [...kept.map((group) => group.id), 0] : kept.map((group) => group.id);
  const hidden = groups.filter((group) => !keptIds.has(group.id)).map(({ id, key, label }) => ({ key, label, unit: unitOf(id) }));
  const hiddenByUnit: Record<string, { groups: number; groupEdges: number }> = {};
  const bump = (unit: string) => (hiddenByUnit[unit] ??= { groups: 0, groupEdges: 0 });
  for (const { unit } of hidden) bump(unit).groups += 1;
  for (const edge of edges) if (!isKept(edge) && unitOf(edge.from) === unitOf(edge.to)) bump(unitOf(edge.from)).groupEdges += 1;
  return { groups: kept, groupEdges, isolatedGroups: drawn.filter((id) => !linked.has(id)), hidden, hiddenByUnit };
}

/** What a path-mode build keeps to answer a folder level later. */
interface UnitSource {
  graph: ArchitectureGraph;
  units: ArchitectureUnits;
  assignment: UnitAssignment;
}

/**
 * In path mode, the units on top and their unit-scoped folder groups below: the groups (and
 * the graph group detail and evidence read) never mix files of two units. Each unit keeps its
 * `maxGroups` largest groups (hiddenGroups counts the others), with their layers.
 * With a folder: that folder's sub-folders and own files, the level below.
 */
function viewUnitLevel({ graph, units, assignment }: UnitSource, maxGroups: number, folder?: string): ViewLevel {
  const { graph: grouped, groupUnits, nestedGroups } = groupByUnit(graph, units, assignment, folder);
  const { context: _context, ...unitLevel } = units;
  const overview = overviewArchitecture(grouped, Number.POSITIVE_INFINITY);
  const names = new Map(units.units.map((unit) => [unit.key, unit.name]));
  const labelled = overview.groups.map((group) => {
    const unit = groupUnits[group.id];
    const parent = folder ?? unit;
    return { ...group, label: groupLabel(group, parent, folder === undefined ? names.get(unit) ?? unit : parent.slice(parent.lastIndexOf("/") + 1)) };
  });
  const capped = capGroups(labelled, overview.groupEdges, maxGroups, (id) => groupUnits[id] ?? "", false);
  const labels = new Map(capped.groups.map((group) => [group.id, group.label]));
  const groupEdges = capped.groupEdges.map((edge) => ({ ...edge, fromLabel: labels.get(edge.from) ?? "", toLabel: labels.get(edge.to) ?? "" }));
  const shownUnits = Object.fromEntries(capped.groups.map((group) => [group.id, groupUnits[group.id]]));
  return {
    graph: grouped,
    revision: grouped.context.revision,
    ...overview,
    groups: capped.groups,
    groupEdges,
    hiddenGroups: capped.hidden.length,
    hiddenGroupEdges: overview.groupEdges.length - groupEdges.length,
    maxGroups,
    isolatedGroups: capped.isolatedGroups,
    hidden: capped.hidden,
    units: {
      ...unitLevel,
      groupUnits: shownUnits,
      ...layerGroupsWithinUnits(groupEdges, shownUnits),
      nestedGroups: nestedGroups.filter((id) => labels.has(id)),
      hiddenByUnit: capped.hiddenByUnit,
    },
  };
}

/** Louvain groups: the `maxGroups` largest are drawn. */
function viewGroups(graph: ArchitectureGraph, maxGroups: number): ViewLevel {
  const overview = overviewArchitecture(graph, Number.POSITIVE_INFINITY);
  const capped = capGroups(overview.groups, overview.groupEdges, maxGroups, () => "", overview.unassigned.fileCount > 0);
  return {
    graph,
    revision: graph.context.revision,
    ...overview,
    groups: capped.groups,
    groupEdges: capped.groupEdges,
    hiddenGroups: capped.hidden.length,
    hiddenGroupEdges: overview.groupEdges.length - capped.groupEdges.length,
    maxGroups,
    isolatedGroups: capped.isolatedGroups,
    hidden: capped.hidden,
  };
}

function viewArchitecture(graph: ArchitectureGraph, workspaceRoot: string, maxGroups: number, declaredRoles?: DeclaredRoles): ViewLevel & { source?: UnitSource } {
  if (graph.context.communityMode !== "path") return viewGroups(graph, maxGroups);
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const source = { graph, units: buildArchitectureUnits(graph, workspaceRoot, assignment, declaredRoles), assignment };
  return { ...viewUnitLevel(source, maxGroups), source };
}

/** The rules check of a build: none without a config at the root, or why the config was refused. */
type RulesState = { check: WorkspaceArchitectureCheck } | { configFile: string; error: string } | undefined;

async function checkRules(graph: ArchitectureGraph, workspaceRoot: string): Promise<RulesState> {
  if (!fs.existsSync(path.join(workspaceRoot, ARCHITECTURE_CONFIG_FILE))) return undefined;
  try {
    return { check: await checkWorkspaceArchitecture(graph, workspaceRoot) };
  } catch (error) {
    return { configFile: ARCHITECTURE_CONFIG_FILE, error: maskWorkspaceRoot(error instanceof Error ? error.message : String(error), workspaceRoot) };
  }
}

/** The rules as one level shows them: its violating group edges keyed by its group ids, and the units' edges. */
function rulesView(rules: RulesState, graph: ArchitectureGraph, unitOf?: ReadonlyMap<string, string>): { rules?: ArchitectureRulesView } {
  if (!rules) return {};
  if ("error" in rules) return { rules: { ...rules, rules: [], configWarnings: [], unitEdges: {}, groupEdges: {} } };
  const { check } = rules;
  const groupOf = new Map(graph.nodes.map((node) => [node.relativePath, node.communityId]));
  return {
    rules: {
      configFile: check.configFile,
      revision: check.context.revision,
      totals: check.totals,
      rules: check.rules,
      configWarnings: check.configWarnings,
      unitEdges: unitOf ? rulesByEdge(check.violations, (file) => unitOf.get(file)) : {},
      groupEdges: rulesByEdge(check.violations, (file) => groupOf.get(file)),
    },
  };
}

/** One page of a rule's violating file pairs, for the evidence panel. */
function ruleEvidencePage(rules: RulesState, request: ArchitectureRuleEvidenceCommand): ArchitectureExtensionMessage {
  if (!rules || !("check" in rules)) throw new Error("no architecture rules were checked");
  const { revision, rule, offset } = request;
  const { violations, page } = exploreArchitectureCheck(rules.check, { rule: String(rule).slice(0, 128), offset: validOffset(offset) });
  return { type: "architectureEvidencePage", revision, rule, from: "", to: "", pairs: violations.map(({ source, target }) => ({ source, target })), page };
}

/** A page offset from the webview; anything but a non-negative integer reads the first page. */
const validOffset = (offset: unknown) => (Number.isSafeInteger(offset) && Number(offset) >= 0 ? Number(offset) : undefined);

/** One evidence page for an edge, echoing the request's file filters. */
function evidencePage(graph: ArchitectureGraph, request: ArchitectureEvidenceCommand): ArchitectureExtensionMessage {
  const { revision, from, to, sourceFile, targetFile, offset } = request;
  // from and to always select the evidence view.
  const evidence = exploreArchitecture(graph, { from, to, sourceFile, targetFile, offset: validOffset(offset), revision }) as
    Extract<ReturnType<typeof exploreArchitecture>, { view: "evidence" }>;
  return { type: "architectureEvidencePage", revision, from, to, sourceFile, targetFile, pairs: evidence.pairs, page: evidence.page };
}

/** One evidence page for a unit edge, read from every file pair of the units' graph. */
function unitEvidencePage(source: UnitSource | undefined, request: ArchitectureUnitEvidenceCommand): ArchitectureExtensionMessage {
  if (!source) throw new Error("unit edges only exist in path mode");
  const { revision, from, to, offset } = request;
  const evidence = exploreUnitEvidence(source.graph, source.units, source.assignment.unitOf,
    { from: String(from), to: String(to), offset: validOffset(offset), revision });
  return { type: "architectureEvidencePage", revision, from, to, pairs: evidence.pairs, page: evidence.page };
}

/**
 * The matrix of the level a request names, read from that level's graph: the units (path mode,
 * nothing entered), an entered unit's groups (group ids of the summary), else every group of
 * the graph (an entered folder, or Louvain). Unit groups are regrouped as the summary was, so
 * their ids match it.
 */
function matrixMessage(
  graph: ArchitectureGraph,
  source: UnitSource | undefined,
  rules: RulesState,
  request: ArchitectureMatrixCommand,
): ArchitectureExtensionMessage {
  const { revision, folder } = request;
  const unit = request.unit === undefined ? undefined : String(request.unit);
  const unitsLevel = source !== undefined && folder === undefined && unit === undefined;
  // Rows are unit keys at the units level, else the group ids of the level's graph.
  const { rules: view } = rulesView(rules, graph, source?.assignment.unitOf);
  const violations = view?.totals === undefined ? {} : { violations: unitsLevel ? view.unitEdges : view.groupEdges };
  const reply = (matrix: ArchitectureMatrix, nestedGroups: number[]) =>
    ({ type: "architectureMatrix" as const, revision, folder, unit, matrix, digest: matrixDigest(matrix), nestedGroups, ...violations });
  if (source && unitsLevel) return reply(unitMatrix(source.units), []);
  const aggregation = aggregateCommunityGroups(graph.graphData);
  if (!source) return reply(groupMatrix(aggregation), []);
  const { groupUnits, nestedGroups } = groupByUnit(source.graph, source.units, source.assignment, folder);
  const inLevel = folder === undefined ? (id: number) => groupUnits[id] === unit : () => true;
  const matrix = groupMatrix(aggregation, inLevel);
  // Named as the graph names them, once ordered: the order stays the CLI's.
  const parent = folder ?? unit ?? "";
  const parentName = folder === undefined ? source.units.units.find((entry) => entry.key === unit)?.name ?? parent : parent.slice(parent.lastIndexOf("/") + 1);
  const rows = matrix.rows.map((row) => ({ ...row, label: groupLabel(row, parent, parentName) }));
  return reply({ ...matrix, rows }, nestedGroups.filter(inLevel));
}

/**
 * Builds the workspace architecture on demand for the sidebar's Architecture view mode.
 * A build is O(files): file changes only mark the cached summary stale.
 */
export class ArchitectureViewService {
  private summary: ArchitectureSummaryMessage | null = null;
  /** The graph of `summary`, which group detail and evidence pages are read from, and of each entered folder. */
  private graph: (LevelGraph & { source?: UnitSource; rules: RulesState; folders: Map<string, LevelGraph> }) | null = null;
  private running: { controller: AbortController; communityMode: CommunityMode } | null = null;
  /** Groups drawn per level; Show more groups raises it for the rest of the session. */
  private maxGroups = DEFAULT_RENDERED_GROUPS;
  private buildCount = 0;
  private renderCount = 0;
  private lastRender: ArchitectureRenderedCommand | null = null;
  private resizeCount = 0;
  private viewSize = { width: 0, height: 0 };
  private interactionCount = 0;
  private lastInteraction: ArchitectureInteractedCommand | null = null;
  private detailCount = 0;
  private lastDetail: ArchitectureDetailRenderedCommand | null = null;
  private matrixCount = 0;
  private lastMatrix: ArchitectureMatrixRenderedCommand | null = null;
  /** A source file changed while the running build was analysing. */
  private changedDuringBuild: { files: Set<string>; any: boolean } = { files: new Set(), any: false };
  private disposed = false;

  constructor(private readonly options: ArchitectureViewServiceOptions) {}

  handleWebviewMessage(message: ArchitectureWebviewCommand): Promise<void> {
    switch (message.command) {
      case "architectureMounted":
        return this.show();
      case "architectureRefresh":
        return this.build();
      case "architectureRendered":
        this.renderCount += 1;
        this.lastRender = message;
        return Promise.resolve();
      case "architectureResized":
        this.resizeCount += 1;
        this.viewSize = { width: message.width, height: message.height };
        return Promise.resolve();
      case "architectureInteracted":
        this.interactionCount += 1;
        this.lastInteraction = message;
        return Promise.resolve();
      case "architectureDetailRendered":
        this.detailCount += 1;
        this.lastDetail = message;
        return Promise.resolve();
      case "architectureMatrixRendered":
        this.matrixCount += 1;
        this.lastMatrix = message;
        return Promise.resolve();
      case "architectureMatrix":
        this.answer(message.revision, message.folder, (graph) => matrixMessage(graph, this.graph?.source, this.graph?.rules, message));
        return Promise.resolve();
      case "architectureEnterFolder":
        this.enterFolder(message);
        return Promise.resolve();
      case "architectureShowMoreGroups":
        this.showMoreGroups(message.revision);
        return Promise.resolve();
      case "architectureFind":
        this.find(message);
        return Promise.resolve();
      case "architectureExpandGroup":
        this.answer(message.revision, message.folder, (graph) => ({
          type: "architectureGroupDetail",
          revision: message.revision,
          folder: message.folder,
          detail: groupDetail(graph, message.groupId, { offset: validOffset(message.offset) }),
        }));
        return Promise.resolve();
      case "architectureEvidence":
        this.answer(message.revision, message.folder, (graph) => evidencePage(graph, message));
        return Promise.resolve();
      case "architectureUnitEvidence":
        this.answer(message.revision, undefined, () => unitEvidencePage(this.graph?.source, message));
        return Promise.resolve();
      case "architectureRuleEvidence":
        this.answer(message.revision, undefined, () => ruleEvidencePage(this.graph?.rules, message));
        return Promise.resolve();
      case "architectureOpenFile":
        return this.openFile(message);
    }
  }

  /**
   * The graph a request's revision points at (an entered folder's when `folder` is set), or null
   * once it is gone (stale request, rebuild, empty workspace).
   */
  private graphFor(revision: string, folder?: string) {
    const cached = folder === undefined ? this.graph : this.graph?.folders.get(String(folder));
    if (cached?.graph.context.revision === revision) return cached;
    this.options.post({ type: "architectureRevisionChanged", currentRevision: this.summary?.revision ?? "" });
    return null;
  }

  private answer(revision: string, folder: string | undefined, read: (graph: ArchitectureGraph) => ArchitectureExtensionMessage): void {
    const cached = this.graphFor(revision, folder);
    if (!cached) return;
    try {
      this.options.post(read(cached.graph));
    } catch (error) {
      // Only an unknown group or unit gets here: the ids and keys come from this revision's summary.
      this.options.warn(`Architecture view: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Answers the level below a unit or folder of the summary's units (path mode), keeping its graph for the requests made there. */
  private enterFolder({ revision, folder }: ArchitectureEnterFolderCommand): void {
    if (!this.graphFor(revision) || !this.graph?.source) return;
    const key = String(folder);
    if (!this.postFolderLevel(revision, key)) this.options.warn(`Architecture view: no file below "${key.slice(0, 256)}"`);
  }

  /** Computes and posts a folder level with the current cap, keeping its graph; false when no file lies below. */
  private postFolderLevel(revision: string, key: string): boolean {
    const { source, folders, rules } = this.graph!;
    const { graph, hidden, ...unitLevel } = viewUnitLevel(source!, this.maxGroups, key);
    if (graph.nodes.length === 0) return false;
    const level = { ...unitLevel, ...rulesView(rules, graph, source!.assignment.unitOf) };
    // ponytail: every entered folder's graph stays until the next build (≈ files × depth); evict the oldest if memory matters.
    folders.set(key, { graph, files: new Set(graph.nodes.map((node) => node.relativePath)), hidden });
    this.options.post({ type: "architectureFolderLevel", revision, folder: key, level });
    return true;
  }

  /**
   * Show more groups: from now on every level draws MAX_RENDERED_GROUPS groups. The summary and
   * the entered levels are sent again with the same revision, so the webview keeps its context.
   */
  private showMoreGroups(revision: string): void {
    if (!this.graphFor(revision) || !this.summary || this.maxGroups === MAX_RENDERED_GROUPS) return;
    this.maxGroups = MAX_RENDERED_GROUPS;
    const cached = this.graph!;
    const { graph: _graph, hidden, ...overview } = cached.source ? viewUnitLevel(cached.source, this.maxGroups) : viewGroups(cached.graph, this.maxGroups);
    cached.hidden = hidden;
    this.summary = { ...this.summary, ...overview };
    this.options.post(this.summary);
    for (const key of cached.folders.keys()) this.postFolderLevel(revision, key);
  }

  /** The hidden groups of a level whose label or key holds the query (case-insensitive), the drawn ones being found in the webview. */
  private find({ revision, folder, unit, query }: ArchitectureFindCommand): void {
    const cached = this.graphFor(revision, folder);
    if (!cached) return;
    const needle = String(query).trim().toLowerCase().slice(0, 256);
    const matches = needle === "" ? [] : cached.hidden.filter((group) =>
      (unit === undefined || group.unit === String(unit)) && `${group.label}\n${group.key}`.toLowerCase().includes(needle));
    this.options.post({
      type: "architectureFound", revision, folder, unit, query: String(query),
      matches: matches.slice(0, 10).map((group) => group.label), total: matches.length,
    });
  }

  /**
   * Opens a file of the cached graph. The path comes from the webview: it must be relative,
   * one of the graph's files, and stay in the workspace once symlinks are resolved (CWE-22).
   */
  private async openFile({ revision, folder, relativePath }: ArchitectureOpenFileCommand): Promise<void> {
    const cached = this.graphFor(revision, folder);
    if (!cached) return;
    const relative = normalizePath(String(relativePath));
    const { workspaceRoot } = this.options;
    try {
      if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || !cached.files.has(relative)) {
        throw new Error(`not a file of the architecture graph: ${relative}`);
      }
      const absolutePath = validateWorkspacePath(path.join(workspaceRoot, relative), workspaceRoot);
      await this.options.openFile(absolutePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.warn(`Architecture view: refused to open a file (${maskWorkspaceRoot(reason, workspaceRoot)})`);
    }
  }

  /** Posts the cached summary when it matches the communityMode setting, else builds. */
  show(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const communityMode = this.options.readCommunityMode();
    if (this.running?.communityMode === communityMode) {
      // The running build posts its summary when done.
      this.options.post({ type: "architectureState", status: "building" });
      return Promise.resolve();
    }
    if (!this.running && this.summary?.context.communityMode === communityMode) {
      this.options.post(this.summary);
      return Promise.resolve();
    }
    return this.build();
  }

  /** Rebuilds when the communityMode setting no longer matches what is shown or being built. */
  async handleCommunityModeChange(): Promise<void> {
    const current = this.running?.communityMode ?? this.summary?.context.communityMode;
    if (current !== undefined && current !== this.options.readCommunityMode()) await this.build();
  }

  /**
   * Marks the cached summary stale when the change can alter it: a file of the graph changed or
   * was deleted, or a file was created (no path: any change). Files the graph never read (build
   * output, ignored folders) leave it as it is; the rule files at the root always count. During a
   * build, the build's own summary carries it.
   * ponytail: any created file counts, ignored ones included; check the collector's ignore rules if that shows the banner for nothing.
   */
  markStale(filePath?: string, eventType?: "create" | "change" | "delete"): void {
    if (this.disposed) return;
    const relative = filePath === undefined ? undefined : normalizePath(path.relative(this.options.workspaceRoot, filePath));
    const rulesFile = relative === ARCHITECTURE_CONFIG_FILE || relative === ARCHITECTURE_BASELINE_FILE;
    if (this.running) {
      if (relative === undefined || eventType === "create" || rulesFile) this.changedDuringBuild.any = true;
      else this.changedDuringBuild.files.add(relative);
      return;
    }
    if (relative !== undefined && eventType !== "create" && !rulesFile && !this.graph?.files.has(relative)) return;
    if (!this.summary || this.summary.stale) return;
    this.summary = { ...this.summary, stale: true };
    this.options.post(this.summary);
  }

  /** A new build aborts the running one; an aborted build never posts anything. */
  async build(): Promise<void> {
    if (this.disposed) return;
    this.running?.controller.abort();
    const controller = new AbortController();
    const communityMode = this.options.readCommunityMode();
    this.running = { controller, communityMode };
    const { signal } = controller;
    // Every message of this build goes through here: once aborted (replaced or disposed), it posts nothing, progress included.
    const post = (message: ArchitectureExtensionMessage) => {
      if (!signal.aborted) this.options.post(message);
    };
    try {
      post({ type: "architectureState", status: "building", message: "Building architecture…" });
      await waitForIdleIndex(this.options, signal, () =>
        post({ type: "architectureState", status: "building", message: "Waiting for indexing to finish…" }));
      let lastProgressAt = Number.NEGATIVE_INFINITY;
      const graph = await buildArchitectureGraph(this.options.workspaceRoot, this.options.analyzeFile, {
        communityMode,
        signal,
        onProgress: (analyzed, total) => {
          const now = Date.now();
          if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          const percent = Math.round((analyzed / total) * 100);
          post({ type: "architectureState", status: "building", message: `Analysing files (${analyzed}/${total})…`, percent });
        },
      });
      signal.throwIfAborted();
      this.buildCount += 1;
      if (graph.scannedFiles === 0) {
        this.summary = null;
        this.graph = null;
        post({ type: "architectureState", status: "empty", message: "No source file found in the workspace folder." });
        return;
      }
      const rules = await checkRules(graph, this.options.workspaceRoot);
      // A refused config is reported by the rules panel: the roles are then only inferred.
      const declaredRoles = await loadDeclaredRoles(this.options.workspaceRoot).catch(() => undefined);
      signal.throwIfAborted();
      const { graph: viewGraph, source, hidden, ...overview } = viewArchitecture(graph, this.options.workspaceRoot, this.maxGroups, declaredRoles);
      const files = new Set(viewGraph.nodes.map(node => node.relativePath));
      const { files: changed, any } = this.changedDuringBuild;
      this.summary = {
        type: "architectureSummary",
        stale: any || [...changed].some(file => files.has(file)),
        ...overview,
        ...rulesView(rules, viewGraph, source?.assignment.unitOf),
      };
      this.graph = { graph: viewGraph, files, hidden, source, rules, folders: new Map() };
      // Cleared only once posted: a change seen by an aborted build still applies to the next one.
      this.changedDuringBuild = { files: new Set(), any: false };
      post(this.summary);
    } catch (error) {
      if (signal.aborted) return;
      // Only workspace-level failures get here (per-file ones are counted in failedFiles); keep the root out of the view.
      const message = maskWorkspaceRoot(error instanceof Error ? error.message : String(error), this.options.workspaceRoot);
      post({ type: "architectureState", status: "error", message });
    } finally {
      if (this.running?.controller === controller) this.running = null;
    }
  }

  /** E2E observability: what was built and what the webview last rendered. */
  getE2EState() {
    return {
      buildCount: this.buildCount,
      renderCount: this.renderCount,
      groupCount: this.lastRender?.renderedGroups ?? 0,
      groupEdgeCount: this.lastRender?.renderedGroupEdges ?? 0,
      revision: this.lastRender?.revision,
      communityMode: this.lastRender?.communityMode,
      stale: this.lastRender?.stale ?? false,
      overlappingGroups: this.lastRender?.overlappingGroups ?? 0,
      overflowingLabels: this.lastRender?.overflowingLabels ?? 0,
      positions: this.lastRender?.positions,
      unit: this.lastRender?.unit,
      folder: this.lastRender?.folder,
      unitLevel: this.lastRender?.unitLevel,
      groupLevel: this.lastRender?.groupLevel,
      violationEdges: this.lastRender?.violationEdges ?? 0,
      rules: this.lastRender?.rules ?? [],
      roles: this.lastRender?.roles ?? [],
      resizeCount: this.resizeCount,
      viewSize: this.viewSize,
      interactionCount: this.interactionCount,
      interaction: this.lastInteraction,
      detailCount: this.detailCount,
      detail: this.lastDetail,
      matrixCount: this.matrixCount,
      matrix: this.lastMatrix,
    };
  }

  /** E2E driver: sets the webview's controls; any extension can call it, so check the values. */
  setControls(controls: Omit<ArchitectureControlsMessage, "type"> | undefined): void {
    const { unit, folder, find, minImports, focus, expand, collapse, evidenceOf, openEvidenceRow, view, matrixCell, matrixHeader, rule, role, showMoreGroups } = controls ?? {};
    const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 256) : undefined);
    const row = text(matrixCell?.row);
    const column = text(matrixCell?.column);
    this.options.post({
      type: "architectureControls",
      unit: text(unit),
      folder: text(folder),
      find: text(find),
      minImports: Number.isSafeInteger(minImports) && Number(minImports) >= 1 ? minImports : undefined,
      focus: text(focus),
      expand: text(expand),
      collapse: text(collapse),
      evidenceOf: text(evidenceOf),
      openEvidenceRow: Number.isSafeInteger(openEvidenceRow) && Number(openEvidenceRow) >= 0 ? openEvidenceRow : undefined,
      view: view === "graph" || view === "matrix" ? view : undefined,
      matrixCell: row === undefined || column === undefined ? undefined : { row, column },
      matrixHeader: text(matrixHeader),
      rule: text(rule),
      role: text(role),
      showMoreGroups: showMoreGroups === true ? true : undefined,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.running?.controller.abort();
    this.running = null;
  }
}
