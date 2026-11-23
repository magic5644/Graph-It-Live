import * as fs from "node:fs";
import * as path from "node:path";
import { exploreArchitecture, exploreArchitectureCheck, exploreUnitEvidence, groupDetail } from "@/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { matrixDigest } from "@/analyzer/architecture/architectureMatrix";
import { ARCHITECTURE_BASELINE_FILE, ARCHITECTURE_CONFIG_FILE, type WorkspaceArchitectureCheck } from "@/analyzer/architecture/architectureRules";
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
import { directoryFolderChain } from "@/analyzer/architecture/architectureUnits";
import { loadWorkspaceUnits, type WorkspaceUnits } from "@/analyzer/architecture/workspaceUnits";
import { architectureDiagramInput, capNodes, MAX_DIAGRAM_NODES } from "@/analyzer/diagram/architectureDiagram";
import { diagramLevel, type DiagramTheme } from "@/analyzer/diagram/diagramStyle";
import { renderSourceDiagram } from "@/analyzer/diagram/workspaceDiagram";
import type { IndexerStatusSnapshot } from "@/analyzer/IndexerStatus";
import { isProjectMarker } from "@/analyzer/utils/workspaceBoundary";
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
  type ArchitectureExportDiagramCommand,
  type ArchitectureExportTarget,
  type ArchitectureExtensionMessage,
  type ArchitectureFindCommand,
  type ArchitectureInteractedCommand,
  type ArchitectureMatrixCommand,
  type ArchitectureMatrixRenderedCommand,
  type ArchitectureOpenFileCommand,
  type ArchitectureRasterizedCommand,
  type ArchitectureRenderedCommand,
  type ArchitectureRevealInFileGraphCommand,
  type ArchitectureRuleEvidenceCommand,
  type ArchitectureRulesView,
  type ArchitectureScopeMessage,
  type ArchitectureSummaryMessage,
  type ArchitectureUnitEvidenceCommand,
  type ArchitectureWebviewCommand,
} from "@/shared/architecture-types";
import type { CommunityMode } from "@/shared/graph-types";
import { normalizePath } from "@/shared/path";
import { validateWorkspacePath } from "@/shared/pathSecurity";
import { untilCancelled, type CancelToken } from "./untilCancelled";

const PROGRESS_INTERVAL_MS = 250;
/** How long the webview may take to draw a PNG export. */
const RASTERIZE_TIMEOUT_MS = 30_000;
/** The export formats the save dialog offers, by file extension. */
const EXPORT_FORMATS: Readonly<Record<string, "svg" | "html" | "png" | "diagram-spec">> = {
  ".svg": "svg", ".html": "html", ".htm": "html", ".png": "png", ".json": "diagram-spec",
};
const BUSY_INDEX_STATES = new Set<IndexerStatusSnapshot["state"]>(["counting", "indexing", "validating"]);

export interface ArchitectureViewServiceOptions {
  workspaceRoot: string;
  analyzeFile: AnalyzeFile;
  /** Whether a change to the file can alter import resolution: a tsconfig / package.json or a config they extend. */
  isResolverConfig: (filePath: string) => boolean;
  readCommunityMode: () => CommunityMode;
  subscribeToIndexStatus: (callback: (snapshot: IndexerStatusSnapshot) => void) => () => void;
  /** Resolves once the startup index is neither scheduled nor restoring: the index status reads `idle` until it starts. */
  whenStartupIndexSettled: () => Promise<void>;
  post: (message: ArchitectureExtensionMessage) => void;
  /** Opens a validated absolute path in an editor. */
  openFile: (absolutePath: string) => Promise<void>;
  /** Opens a validated absolute path and shows it in the file Dependency Graph (view mode file). */
  revealInFileGraph: (absolutePath: string) => Promise<void>;
  /** Opens the extension's settings. */
  openSettings: () => void;
  warn: (message: string) => void;
  /** Shows a message to the user. */
  notify: (message: string, level: "info" | "error") => void;
  /** Colours of the exported SVG and PNG: the editor's theme. */
  diagramTheme: () => DiagramTheme;
  /** Asks where to save a diagram, starting at `defaultPath`; undefined when cancelled. */
  pickDiagramFile: (defaultPath: string) => Promise<string | undefined>;
  writeClipboard: (text: string) => Promise<void>;
  /** Indexed files whose unresolved imports may resolve to `filePath` once it exists. */
  unresolvedImportersOf: (filePath: string) => string[];
  /** Asks for one unit of the units level (Show Folder Diagram without a folder); undefined on Escape. */
  pickUnit?: (units: { key: string; role: string }[]) => Promise<string | undefined>;
}

/** The file an export writes: the E2E driver's `output` once checked to stay in the workspace (CWE-22), else the user's pick. */
export function workspaceExportFile(output: string | undefined, workspaceRoot: string, pick: () => Promise<string | undefined>): Promise<string | undefined> {
  if (output === undefined) return pick();
  return Promise.resolve(validateWorkspacePath(path.resolve(workspaceRoot, output), workspaceRoot));
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
 * The startup index is waited for first: `idle` before it starts is not an index ready to read (#433).
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
    let indexIdle = false;
    let startupSettled = false;
    const readIfReady = () => {
      if (!indexIdle || !startupSettled || done) return;
      onIdle();
      finish();
    };
    // subscribe notifies the current state synchronously, possibly before it returns.
    let notifiedBusy = false;
    unsubscribe = options.subscribeToIndexStatus((snapshot) => {
      indexIdle = !BUSY_INDEX_STATES.has(snapshot.state);
      if (indexIdle) readIfReady();
      else if (!notifiedBusy) {
        notifiedBusy = true;
        onBusy();
      }
    });
    if (done) unsubscribe();
    void options.whenStartupIndexSettled().then(() => {
      startupSettled = true;
      readIfReady();
    }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

interface LevelGraph {
  graph: ArchitectureGraph;
  files: Set<string>;
  hidden: HiddenGroup[];
}

/** The units the units level draws when it has more than the diagram cap: the export's ranking, so both draw the same units. */
function unitCap(source: UnitSource | undefined, workspaceRoot: string): Pick<ArchitectureSummaryMessage, "unitCap"> {
  if (!source) return {};
  const input = architectureDiagramInput(source, workspaceRoot);
  if (input.nodes.length <= MAX_DIAGRAM_NODES) return {};
  return { unitCap: { drawnUnits: capNodes(input).nodes.map((node) => node.key), totalUnits: input.nodes.length, cap: MAX_DIAGRAM_NODES } };
}

/** Keys the E2E driver may press on the canvas or the Flow tab (Tab enters its steps): navigation and zoom only. */
const CANVAS_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "0", "+", "-"]);

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

/** The export the commands or the E2E driver ask for, checked; its E2E `output` stays in the extension. */
type ExportControl = { target: ArchitectureExportTarget; output?: string };

function exportControl(control: ExportControl | undefined): ArchitectureControlsMessage["exportDiagram"] {
  return control?.target === "file" || control?.target === "clipboard" ? { target: control.target } : undefined;
}

/** The rules check of a build: none without a config at the root, or why the config was refused. */
type RulesState = { check: WorkspaceArchitectureCheck; configWarnings: string[] } | { configFile: string; error: string } | undefined;

/**
 * The units of a build (declared elements, else detected projects) and its rules check. A refused
 * config is never silent: the Rules panel shows why, and the units are the detected projects.
 */
async function loadUnits(graph: ArchitectureGraph, workspaceRoot: string): Promise<{ source: WorkspaceUnits; rules: RulesState }> {
  try {
    const source = await loadWorkspaceUnits(graph, workspaceRoot);
    const { check } = source;
    return { source, rules: check && { check, configWarnings: source.units.configWarnings ?? check.configWarnings } };
  } catch (error) {
    const rules = { configFile: ARCHITECTURE_CONFIG_FILE, error: maskWorkspaceRoot(error instanceof Error ? error.message : String(error), workspaceRoot) };
    return { source: await loadWorkspaceUnits(graph, workspaceRoot, { config: false }), rules };
  }
}

/** The rules as one level shows them: its violating group edges keyed by its group ids, and the units' edges. */
function rulesView(rules: RulesState, graph: ArchitectureGraph, unitOf?: ReadonlyMap<string, string>): { rules?: ArchitectureRulesView } {
  if (!rules) return {};
  if ("error" in rules) return { rules: { ...rules, rules: [], configWarnings: [], unitEdges: {}, groupEdges: {} } };
  const { check, configWarnings } = rules;
  return {
    rules: {
      configFile: check.configFile,
      revision: check.context.revision,
      totals: check.totals,
      rules: check.rules,
      configWarnings,
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

/** The level and filters an export request names, checked: it comes from the webview. */
function exportLevel({ view, folder, role, minImports }: ArchitectureExportDiagramCommand) {
  return {
    ...diagramLevel(view === "matrix" ? "matrix" : undefined, folder === undefined ? undefined : String(folder)),
    role: role === undefined ? undefined : String(role),
    minImports: Number.isSafeInteger(minImports) && Number(minImports) >= 1 ? Number(minImports) : undefined,
  };
}

/** The format of an export file, by its extension. */
function exportFormat(file: string): "svg" | "html" | "png" | "diagram-spec" {
  const format = EXPORT_FORMATS[path.extname(file).toLowerCase()];
  if (format === undefined) throw new Error(`${path.basename(file)}: save as .svg, .html, .png or .json`);
  return format;
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
  private running: { controller: AbortController; communityMode: CommunityMode; startedAt: number; reading: boolean; indexRan: boolean; done: Promise<void> } | null = null;
  /** The last build ended in an error: its `architectureState` replaced the older summary in the view. */
  private buildFailed = false;
  /** A scope a command asked for before the Architecture mode mounted: posted once its summary is. */
  private pendingScope: (() => void) | null = null;
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
  /** PNG exports waiting for the webview's raster, by request id. */
  private readonly rasterRequests = new Map<number, (reply: Partial<ArchitectureRasterizedCommand>) => void>();
  private rasterCount = 0;
  /** The file the E2E driver's next file export writes, without the save dialog. */
  private exportOutput: string | undefined;
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
        return this.show().then(() => this.postPendingScope());
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
      case "architectureExportDiagram":
        return this.exportDiagram(message);
      case "architectureRasterized":
        this.rasterRequests.get(Number(message.requestId))?.(message);
        return Promise.resolve();
      // GraphProvider routes the diagram tabs' commands to the flow service, showDirectory, showUnits and showMatrix.
      case "flowOpenLocation":
      case "flowExportDiagram":
      case "flowRefresh":
      case "flowShowCallGraph":
      case "flowDrawCandidate":
      case "flowDrawAtCursor":
      case "diagramRescope":
      case "diagramFollow":
      case "diagramShown":
        return Promise.resolve();
    }
  }

  /**
   * Resolves once a summary for the communityMode setting is cached, waiting for a running build (and
   * the newer one that replaced it) or starting one: true with a summary, false on cancel (the build
   * goes on) or when the build ended empty or in an error (its `architectureState` is already posted).
   */
  private async whenSummary(token?: CancelToken): Promise<boolean> {
    const running = this.running;
    if (running) return (await untilCancelled(running.done, token)) && this.whenSummary(token);
    if (this.summary?.context.communityMode !== this.options.readCommunityMode() && !(await untilCancelled(this.build(), token))) return false;
    return this.summary !== null && !this.buildFailed && !this.disposed;
  }

  /** Posts a scope now, or once the Architecture mode mounts (`whenMounted`): it must follow the summary. */
  private postScope(post: () => void, whenMounted: boolean | undefined): void {
    if (whenMounted) this.pendingScope = post;
    else post();
  }

  private async postPendingScope(): Promise<void> {
    const post = this.pendingScope;
    this.pendingScope = null;
    if (post && (await this.whenSummary())) post();
  }

  /**
   * Shows the level that draws a workspace directory (relative, "/"-separated): its unit, then the folder
   * levels down to it, then `architectureScope`. No directory: asks for a unit. The workspace root draws
   * the units. False when nothing was scoped; the reason is told unless `quiet` (Follow cursor).
   */
  async showDirectory(
    relativeDir: string | undefined,
    options: { quiet?: boolean; token?: CancelToken; whenMounted?: boolean } = {},
  ): Promise<boolean> {
    if (relativeDir === "") return this.showUnits(options);
    if (!(await this.whenSummary(options.token))) return false;
    if (!this.graph?.source) {
      if (!options.quiet) this.options.notify("Graph-It-Live: the Folder diagram draws units: set graph-it-live.communityMode to path.", "info");
      return false;
    }
    const chain = relativeDir === undefined ? await this.pickUnit() : this.folderChain(relativeDir, options.quiet);
    if (chain === undefined) return false;
    this.postScope(() => {
      const revision = this.summary!.revision;
      // Every level of the chain, so the webview's breadcrumb and Back walk them as a double-click does.
      for (const key of chain) this.postFolderLevel(revision, key);
      this.options.post({ type: "architectureScope", revision, tab: "folder", unit: chain[0], folders: chain.slice(1) });
    }, options.whenMounted);
    return true;
  }

  /** The keys down to a directory, or undefined once the reason is told (unless quiet). */
  private folderChain(directory: string, quiet: boolean | undefined): string[] | undefined {
    const tell = (message: string) => {
      if (!quiet) this.options.notify(`Graph-It-Live: ${message}`, "info");
      return undefined;
    };
    try {
      const chain = directoryFolderChain(this.graph!.source!.assignment, directory);
      return chain.length > 0 ? chain : tell(`"${directory}" holds several units: right-click the folder of one of them, or pick Units.`);
    } catch (error) {
      return tell(error instanceof Error ? error.message : String(error));
    }
  }

  /** The chain of the unit the user picks (a unit is its own first level); undefined on Escape. */
  private async pickUnit(): Promise<string[] | undefined> {
    const units = this.summary?.units?.units ?? [];
    const key = await this.options.pickUnit?.(units.map(({ key, role }) => ({ key, role })));
    return units.some((unit) => unit.key === key) ? [key!] : undefined;
  }

  /** Units tab: the units level, once a summary is cached (see whenSummary). */
  showUnits(options: { token?: CancelToken; whenMounted?: boolean } = {}): Promise<boolean> {
    return this.showLevelTab("units", options);
  }

  /** Matrix tab: the matrix of the units level, once a summary is cached. */
  showMatrix(options: { token?: CancelToken; whenMounted?: boolean } = {}): Promise<boolean> {
    return this.showLevelTab("matrix", options);
  }

  private async showLevelTab(tab: Exclude<ArchitectureScopeMessage["tab"], "folder">, options: { token?: CancelToken; whenMounted?: boolean }): Promise<boolean> {
    if (!(await this.whenSummary(options.token))) return false;
    this.postScope(() => this.options.post({ type: "architectureScope", revision: this.summary!.revision, tab, unit: null, folders: [] }), options.whenMounted);
    return true;
  }

  /**
   * Draws the level the webview names with the analyzer's renderer (the CLI's diagram), from the
   * graph this revision was built from, then saves it (SVG, HTML or PNG) or copies its SVG.
   */
  private async exportDiagram(message: ArchitectureExportDiagramCommand): Promise<void> {
    const output = message.target === "file" ? this.exportOutput : undefined;
    this.exportOutput = undefined;
    if (!this.graphFor(message.revision)) {
      this.options.notify("The architecture changed: export again once the view is redrawn.", "info");
      return;
    }
    const cached = this.graph!;
    const { workspaceRoot } = this.options;
    try {
      if (!cached.source) throw new Error("the diagram draws units: set graph-it-live.communityMode to path");
      const file = message.target === "file" ? await this.exportFile(output) : undefined;
      if (message.target === "file" && file === undefined) return;
      const format = file === undefined ? "svg" : exportFormat(file);
      const { markup, width, height } = await renderSourceDiagram(cached.source, workspaceRoot, {
        ...exportLevel(message),
        format: format === "png" ? "svg" : format,
        theme: this.options.diagramTheme(),
        violations: cached.rules && "check" in cached.rules ? cached.rules.check.violations : [],
      });
      if (file === undefined) {
        await this.options.writeClipboard(markup);
        this.options.notify("Architecture diagram copied as SVG.", "info");
        return;
      }
      await fs.promises.writeFile(file, format === "png" ? Buffer.from(await this.rasterize(markup, width, height), "base64") : markup);
      this.options.notify(`Architecture diagram saved to ${path.basename(file)}.`, "info");
    } catch (error) {
      const reason = maskWorkspaceRoot(error instanceof Error ? error.message : String(error), workspaceRoot);
      this.options.notify(`Could not export the architecture diagram: ${reason}`, "error");
    }
  }

  private exportFile(output: string | undefined): Promise<string | undefined> {
    const { workspaceRoot } = this.options;
    return workspaceExportFile(output, workspaceRoot, () => this.options.pickDiagramFile(path.join(workspaceRoot, "architecture.svg")));
  }

  /** The PNG of an SVG at 2×, drawn by the webview: base64. */
  private rasterize(svg: string, width: number, height: number): Promise<string> {
    this.rasterCount += 1;
    const requestId = this.rasterCount;
    return new Promise((resolve, reject) => {
      const settle = (reply: Partial<ArchitectureRasterizedCommand>) => {
        clearTimeout(timer);
        this.rasterRequests.delete(requestId);
        if (typeof reply.png === "string" && reply.png !== "") resolve(reply.png);
        else reject(new Error(String(reply.error ?? "the view could not draw the PNG")));
      };
      const timer = setTimeout(() => settle({ error: "the view did not draw the PNG in time; keep the Architecture view open" }), RASTERIZE_TIMEOUT_MS);
      this.rasterRequests.set(requestId, settle);
      this.options.post({ type: "architectureRasterize", requestId, svg, width, height });
    });
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
   * output, ignored folders) leave it as it is; the rule files at the root, resolver configs
   * and project markers count too. During a build, the build's own summary carries it.
   * ponytail: any created file counts, ignored ones included; check the collector's ignore rules if that shows the banner for nothing.
   */
  markStale(filePath?: string, eventType?: "create" | "change" | "delete"): void {
    if (this.disposed) return;
    const relative = filePath === undefined ? undefined : normalizePath(path.relative(this.options.workspaceRoot, filePath));
    const configFile = this.isConfigFile(filePath, relative);
    // The resolver config glob reports every JSON file; only the configs above can alter the graph.
    if (!configFile && filePath?.endsWith(".json")) return;
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

  private isConfigFile(filePath: string | undefined, relative: string | undefined): boolean {
    // A project marker (go.mod, pyproject.toml...) adds or removes a unit (#758).
    return this.options.isResolverConfig(filePath ?? "") || relative === ARCHITECTURE_CONFIG_FILE || relative === ARCHITECTURE_BASELINE_FILE
      || (filePath !== undefined && isProjectMarker(path.basename(filePath)));
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
    let finished = () => {};
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const running = { controller, communityMode, startedAt, reading: false, indexRan: false, done };
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
      this.buildFailed = false;
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
      const { source: units, rules } = await loadUnits(graph, this.options.workspaceRoot);
      signal.throwIfAborted();
      const { graph: viewGraph, source, hidden, ...overview } = viewArchitecture(graph, this.options.workspaceRoot, this.maxGroups, units);
      const files = new Set(viewGraph.nodes.map(node => node.relativePath));
      const { files: changed, any } = this.changedDuringBuild;
      this.summary = {
        type: "architectureSummary",
        stale: running.indexRan || any || [...changed].some(file => files.has(file)),
        ...overview,
        ...rulesView(rules, viewGraph, source?.assignment.unitOf),
        ...unitCap(source, this.options.workspaceRoot),
      };
      this.graph = { graph: viewGraph, files, hidden, source, rules, folders: new Map(), startedAt };
      // Cleared only once posted: a change seen by an aborted build still applies to the next one.
      this.changedDuringBuild = { files: new Set(), any: false };
      post(this.summary);
    } catch (error) {
      if (signal.aborted) return;
      // Only workspace-level failures get here (per-file ones are counted in failedFiles); keep the root out of the view.
      const message = maskWorkspaceRoot(error instanceof Error ? error.message : String(error), this.options.workspaceRoot);
      this.buildFailed = true;
      post({ type: "architectureState", status: "error", message });
    } finally {
      if (this.running?.controller === controller) this.running = null;
      finished();
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
  setControls(controls: (Omit<ArchitectureControlsMessage, "type" | "exportDiagram"> & { exportDiagram?: ExportControl }) | undefined): void {
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
      exportDiagram: this.exportControl(controls?.exportDiagram),
      ...canvasControls(controls),
    });
  }

  /** Keeps a file export's E2E `output` for the webview's answer, which names the level. */
  private exportControl(control: ExportControl | undefined): ArchitectureControlsMessage["exportDiagram"] {
    const checked = exportControl(control);
    if (checked) this.exportOutput = checked.target === "file" && typeof control?.output === "string" ? control.output : undefined;
    return checked;
  }

  dispose(): void {
    this.disposed = true;
    // Deleting the entry being visited is safe in a Map iteration.
    for (const settle of this.rasterRequests.values()) settle({ error: "the view was closed" });
    this.unsubscribeIndexStatus();
    this.running?.controller.abort();
    this.running = null;
  }
}
