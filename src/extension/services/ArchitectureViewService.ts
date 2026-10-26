import * as fs from "node:fs";
import * as path from "node:path";
import { exploreArchitecture, exploreArchitectureCheck, exploreUnitEvidence, groupDetail } from "@/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { matrixDigest } from "@/analyzer/architecture/architectureMatrix";
import {
  ARCHITECTURE_BASELINE_FILE,
  ARCHITECTURE_CONFIG_FILE,
  checkWorkspaceArchitecture,
  loadDeclaredRoles,
  type WorkspaceArchitectureCheck,
} from "@/analyzer/architecture/architectureRules";
import {
  findHiddenGroups,
  levelMatrix,
  levelViolations,
  viewArchitecture,
  viewDependents,
  viewLevel,
  viewUnitLevel,
  type HiddenGroup,
  type UnitSource,
} from "@/analyzer/architecture/architectureView";
import type { IndexerStatusSnapshot } from "@/analyzer/IndexerStatus";
import {
  DEFAULT_RENDERED_GROUPS,
  MAX_RENDERED_GROUPS,
  type ArchitectureControlsMessage,
  type ArchitectureDependentFilesCommand,
  type ArchitectureDependentsCommand,
  type ArchitectureDependentsRenderedCommand,
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
  type ArchitectureRevealInFileGraphCommand,
  type ArchitectureRuleEvidenceCommand,
  type ArchitectureRulesView,
  type ArchitectureSummaryMessage,
  type ArchitectureUnitEvidenceCommand,
  type ArchitectureWebviewCommand,
} from "@/shared/architecture-types";
import { RESOLVER_CONFIG_FILE_REGEX } from "@/shared/constants";
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
  /** Opens a validated absolute path and shows it in the file Dependency Graph (view mode file). */
  revealInFileGraph: (absolutePath: string) => Promise<void>;
  /** Opens the extension's settings. */
  openSettings: () => void;
  warn: (message: string) => void;
  /** Indexed files whose unresolved imports may resolve to `filePath` once it exists. */
  unresolvedImportersOf: (filePath: string) => string[];
}

/**
 * True for a create or change event of content written before a build started: that build read
 * it. macOS delivers watcher events late, after the Refresh that already drew those files.
 * shortcut: mtime against the local clock misses an edit restored with an older mtime (rsync -t, tar), made within the mtime
 * granularity of the build start (1 s on HFS+, 2 s on FAT), or on a remote file system whose clock runs late; Refresh still
 * rebuilds, compare content hashes if that matters.
 */
export function writtenBefore(filePath: string | undefined, eventType: "create" | "change" | "delete" | undefined, startedAt: number | undefined): boolean {
  if (filePath === undefined || eventType === "delete" || startedAt === undefined) return false;
  try {
    return fs.statSync(filePath).mtimeMs < startedAt;
  } catch {
    return false;
  }
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

/**
 * Resolves once the reverse index is not being built, so both do not compete for the Spider.
 * `onIdle` runs in the status notification itself: an index run starting later sees the build reading.
 */
function waitForIdleIndex(
  options: ArchitectureViewServiceOptions,
  signal: AbortSignal,
  onBusy: () => void,
  onIdle: () => void,
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
      if (!BUSY_INDEX_STATES.has(snapshot.state)) {
        onIdle();
        finish();
      } else if (!notifiedBusy) {
        notifiedBusy = true;
        onBusy();
      }
    });
    if (done) unsubscribe();
  });
}

interface LevelGraph {
  graph: ArchitectureGraph;
  files: Set<string>;
  hidden: HiddenGroup[];
}

/** Keys the E2E driver may press on the canvas: navigation and zoom only. */
const CANVAS_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "0", "+", "-"]);

/** The canvas controls of an E2E driver call, checked: any extension can call it. */
function canvasControls(controls: Omit<ArchitectureControlsMessage, "type"> | undefined): Partial<ArchitectureControlsMessage> {
  const { zoom, keys, legendUnit, cycleCount } = controls ?? {};
  return {
    zoom: zoom === "fit" || zoom === "in" || zoom === "out" ? zoom : undefined,
    keys: Array.isArray(keys) ? keys.filter((key) => CANVAS_KEYS.has(key)).slice(0, 20) : undefined,
    legendUnit: typeof legendUnit === "string" ? legendUnit.slice(0, 256) : undefined,
    cycleCount: cycleCount === true ? true : undefined,
  };
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
  return {
    rules: {
      configFile: check.configFile,
      revision: check.context.revision,
      totals: check.totals,
      rules: check.rules,
      configWarnings: check.configWarnings,
      ...levelViolations(check.violations, graph, unitOf),
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

/** The matrix of the level a request names, with its violating cells. */
function matrixMessage(
  graph: ArchitectureGraph,
  source: UnitSource | undefined,
  rules: RulesState,
  request: ArchitectureMatrixCommand,
): ArchitectureExtensionMessage {
  const { revision, folder } = request;
  const unit = request.unit === undefined ? undefined : String(request.unit);
  const { matrix, nestedGroups, unitsLevel } = levelMatrix(graph, source, folder, unit);
  // Rows are unit keys at the units level, else the group ids of the level's graph.
  const { rules: view } = rulesView(rules, graph, source?.assignment.unitOf);
  const violations = view?.totals === undefined ? {} : { violations: unitsLevel ? view.unitEdges : view.groupEdges };
  return { type: "architectureMatrix", revision, folder, unit, matrix, digest: matrixDigest(matrix), nestedGroups, ...violations };
}

/** A workspace-relative file of the graph; anything else (absolute, outside, unknown) is refused. */
function graphFile(files: ReadonlySet<string>, relativePath: unknown): string {
  const relative = normalizePath(String(relativePath));
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || !files.has(relative)) {
    throw new Error(`not a file of the architecture graph: ${relative}`);
  }
  return relative;
}

type DependentsRequest = ArchitectureDependentsCommand | ArchitectureDependentFilesCommand;

/**
 * The dependents of a request's seed, grouped as the request's level draws them: by unit at the
 * units level, else by the level's groups. A file seed must be a file of the summary's graph.
 */
function dependentsOf(full: LevelGraph, level: ArchitectureGraph, source: UnitSource | undefined, request: DependentsRequest) {
  const { seed, folder, unit } = request;
  const checked = seed?.kind === "file" ? { kind: "file" as const, relativePath: graphFile(full.files, seed.relativePath) } : seed;
  return viewDependents(full.graph, level, source, checked, folder === undefined && unit === undefined);
}

function dependentsMessage(full: LevelGraph, level: ArchitectureGraph, source: UnitSource | undefined, request: ArchitectureDependentsCommand): ArchitectureExtensionMessage {
  const { revision, folder, unit, seed } = request;
  const dependents = dependentsOf(full, level, source, request);
  return {
    type: "architectureDependentsResult", revision, folder, unit, seed, seedLabel: dependents.seedLabel,
    seedGroups: dependents.seed.groups,
    reachedFiles: dependents.reachedFiles,
    totals: dependents.totals,
    groups: dependents.groups,
    insideSeedGroup: dependents.insideSeedGroup,
    maxDepthReached: dependents.maxDepthReached,
    provenance: dependents.provenance,
  };
}

function dependentFilesPage(full: LevelGraph, level: ArchitectureGraph, source: UnitSource | undefined, request: ArchitectureDependentFilesCommand): ArchitectureExtensionMessage {
  const { revision, folder, unit, seed, groupKey, offset } = request;
  // shortcut: each page walks the graph again (O(file pairs), milliseconds); cache per revision and seed if pages lag.
  const { files, page } = dependentsOf(full, level, source, request).filesOf(String(groupKey), { offset: validOffset(offset) });
  return { type: "architectureDependentFilesPage", revision, folder, unit, seed, groupKey: String(groupKey), files, page };
}

/**
 * Builds the workspace architecture on demand for the sidebar's Architecture view mode.
 * A build is O(files): file changes only mark the cached summary stale.
 */
export class ArchitectureViewService {
  private summary: ArchitectureSummaryMessage | null = null;
  /** The graph of `summary`, which group detail and evidence pages are read from, and of each entered folder. */
  private graph: (LevelGraph & { source?: UnitSource; rules: RulesState; folders: Map<string, LevelGraph>; startedAt: number }) | null = null;
  /**
   * The running build; `reading` once the index it waited for is idle, `indexRan` when an index run started since.
   * Unlike `changedDuringBuild`, an aborted build's index run is not carried: the next build waits for it.
   */
  private running: { controller: AbortController; communityMode: CommunityMode; startedAt: number; reading: boolean; indexRan: boolean } | null = null;
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
  private lastDependents: ArchitectureDependentsRenderedCommand | null = null;
  /** A source file changed while the running build was analysing. */
  private changedDuringBuild: { files: Set<string>; any: boolean } = { files: new Set(), any: false };
  private disposed = false;
  private readonly unsubscribeIndexStatus: () => void;

  constructor(private readonly options: ArchitectureViewServiceOptions) {
    // A build reads the index: an index run (a resolver config re-index, a full re-index) starting after it read changes what it drew (#478).
    this.unsubscribeIndexStatus = options.subscribeToIndexStatus((snapshot) => {
      if (snapshot.state !== "counting") return;
      if (!this.running) this.markStale();
      else if (this.running.reading) this.running.indexRan = true;
    });
  }

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
        return this.openFile(message, this.options.openFile);
      case "architectureRevealInFileGraph":
        return this.openFile(message, this.options.revealInFileGraph);
      case "architectureDependents":
        this.answer(message.revision, message.folder, (level) => dependentsMessage(this.graph!, level, this.graph!.source, message));
        return Promise.resolve();
      case "architectureDependentFiles":
        this.answer(message.revision, message.folder, (level) => dependentFilesPage(this.graph!, level, this.graph!.source, message));
        return Promise.resolve();
      case "architectureDependentsRendered":
        this.lastDependents = message;
        return Promise.resolve();
      case "architectureOpenSettings":
        this.options.openSettings();
        return Promise.resolve();
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
    const { graph: _graph, hidden, ...overview } = viewLevel(cached.graph, cached.source, this.maxGroups);
    cached.hidden = hidden;
    this.summary = { ...this.summary, ...overview };
    this.options.post(this.summary);
    for (const key of cached.folders.keys()) this.postFolderLevel(revision, key);
  }

  /** The hidden groups of a level whose label or key holds the query (case-insensitive), the drawn ones being found in the webview. */
  private find({ revision, folder, unit, query }: ArchitectureFindCommand): void {
    const cached = this.graphFor(revision, folder);
    if (!cached) return;
    const found = findHiddenGroups(cached.hidden, String(query), unit === undefined ? undefined : String(unit));
    this.options.post({ type: "architectureFound", revision, folder, unit, query: String(query), ...found });
  }

  /**
   * Opens a file of the cached graph with `open`. The path comes from the webview: it must be
   * relative, one of the graph's files, and stay in the workspace once symlinks are resolved (CWE-22).
   */
  private async openFile(
    { revision, folder, relativePath }: ArchitectureOpenFileCommand | ArchitectureRevealInFileGraphCommand,
    open: (absolutePath: string) => Promise<void>,
  ): Promise<void> {
    const cached = this.graphFor(revision, folder);
    if (!cached) return;
    const { workspaceRoot } = this.options;
    try {
      const relative = graphFile(cached.files, relativePath);
      const absolutePath = validateWorkspacePath(path.join(workspaceRoot, relative), workspaceRoot);
      await open(absolutePath);
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
   * output, ignored folders) leave it as it is; the rule files at the root and resolver configs
   * count too. During a build, the build's own summary carries it.
   * ponytail: any created file counts, ignored ones included; check the collector's ignore rules if that shows the banner for nothing.
   */
  markStale(filePath?: string, eventType?: "create" | "change" | "delete"): void {
    if (this.disposed) return;
    const relative = filePath === undefined ? undefined : normalizePath(path.relative(this.options.workspaceRoot, filePath));
    const configFile = RESOLVER_CONFIG_FILE_REGEX.test(relative ?? "") || relative === ARCHITECTURE_CONFIG_FILE || relative === ARCHITECTURE_BASELINE_FILE;
    if (this.running) {
      if (this.readByBuild(filePath, eventType, this.running.startedAt)) return;
      if (relative === undefined || eventType === "create" || configFile) this.changedDuringBuild.any = true;
      else this.changedDuringBuild.files.add(relative);
      return;
    }
    if (relative !== undefined && eventType !== "create" && !configFile && !this.graph?.files.has(relative)) return;
    if (!this.summary || this.summary.stale || this.readByBuild(filePath, eventType, this.graph?.startedAt)) return;
    this.summary = { ...this.summary, stale: true };
    this.options.post(this.summary);
  }

  /**
   * A late event for content the build already read. A created file still counts while indexed
   * files import it unresolved: only their pending re-analysis adds those edges (#387). A resolver
   * config the index has yet to apply starts a re-index, which marks the view stale once it reads.
   */
  private readByBuild(filePath: string | undefined, eventType: "create" | "change" | "delete" | undefined, startedAt: number | undefined): boolean {
    if (!writtenBefore(filePath, eventType, startedAt)) return false;
    return eventType !== "create" || this.options.unresolvedImportersOf(filePath!).length === 0;
  }

  /** A new build aborts the running one; an aborted build never posts anything. */
  async build(): Promise<void> {
    if (this.disposed) return;
    this.running?.controller.abort();
    const controller = new AbortController();
    const communityMode = this.options.readCommunityMode();
    const startedAt = Date.now();
    const running = { controller, communityMode, startedAt, reading: false, indexRan: false };
    this.running = running;
    const { signal } = controller;
    // Every message of this build goes through here: once aborted (replaced or disposed), it posts nothing, progress included.
    const post = (message: ArchitectureExtensionMessage) => {
      if (!signal.aborted) this.options.post(message);
    };
    try {
      post({ type: "architectureState", status: "building", message: "Building architecture…" });
      await waitForIdleIndex(this.options, signal, () =>
        post({ type: "architectureState", status: "building", message: "Waiting for indexing to finish…" }), () => {
        running.reading = true;
      });
      let lastProgressAt = Number.NEGATIVE_INFINITY;
      const graph = await buildArchitectureGraph(this.options.workspaceRoot, this.options.analyzeFile, {
        communityMode,
        signal,
        onProgress: (analyzed, total) => {
          const now = Date.now();
          if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          const percent = Math.round((analyzed / total) * 100);
          post({ type: "architectureState", status: "building", message: `Building architecture: ${analyzed} of ${total} files`, percent });
        },
      });
      signal.throwIfAborted();
      this.buildCount += 1;
      if (graph.scannedFiles === 0) {
        this.summary = null;
        this.graph = null;
        const folder = path.basename(this.options.workspaceRoot);
        post({
          type: "architectureState",
          status: "empty",
          message: `No supported source file in "${folder}". Files excluded by .graphitignore or the Graph-It-Live settings are not analysed.`,
        });
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
        stale: running.indexRan || any || [...changed].some(file => files.has(file)),
        ...overview,
        ...rulesView(rules, viewGraph, source?.assignment.unitOf),
      };
      this.graph = { graph: viewGraph, files, hidden, source, rules, folders: new Map(), startedAt };
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
      rendered: this.lastRender,
      dependents: this.lastDependents,
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
      dependentsOf: text(controls?.dependentsOf),
      revealFile: text(controls?.revealFile),
      clearDependents: controls?.clearDependents === true ? true : undefined,
      ...canvasControls(controls),
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeIndexStatus();
    this.running?.controller.abort();
    this.running = null;
  }
}
