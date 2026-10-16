import * as path from "node:path";
import { exploreArchitecture, groupDetail, overviewArchitecture } from "@/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import type { IndexerStatusSnapshot } from "@/analyzer/IndexerStatus";
import type {
  ArchitectureControlsMessage,
  ArchitectureDetailRenderedCommand,
  ArchitectureEvidenceCommand,
  ArchitectureExtensionMessage,
  ArchitectureInteractedCommand,
  ArchitectureOpenFileCommand,
  ArchitectureRenderedCommand,
  ArchitectureSummaryMessage,
  ArchitectureWebviewCommand,
} from "@/shared/architecture-types";
import type { CommunityMode } from "@/shared/graph-types";
import { normalizePath } from "@/shared/path";
import { validateWorkspacePath } from "@/shared/pathSecurity";

/** Groups beyond this are counted in hiddenGroups, never dropped from totals. */
export const MAX_RENDERED_GROUPS = 150;
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

/**
 * Builds the workspace architecture on demand for the sidebar's Architecture view mode.
 * A build is O(files): file changes only mark the cached summary stale.
 */
export class ArchitectureViewService {
  private summary: ArchitectureSummaryMessage | null = null;
  /** The graph of `summary`, which group detail and evidence pages are read from. */
  private graph: { graph: ArchitectureGraph; files: Set<string> } | null = null;
  private running: { controller: AbortController; communityMode: CommunityMode } | null = null;
  private buildCount = 0;
  private renderCount = 0;
  private lastRender: ArchitectureRenderedCommand | null = null;
  private resizeCount = 0;
  private viewSize = { width: 0, height: 0 };
  private interactionCount = 0;
  private lastInteraction: ArchitectureInteractedCommand | null = null;
  private detailCount = 0;
  private lastDetail: ArchitectureDetailRenderedCommand | null = null;
  /** A source file changed while the running build was analysing. */
  private changedDuringBuild = false;
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
      case "architectureExpandGroup":
        this.answer(message.revision, (graph) => ({
          type: "architectureGroupDetail",
          revision: message.revision,
          detail: groupDetail(graph, message.groupId, { offset: validOffset(message.offset) }),
        }));
        return Promise.resolve();
      case "architectureEvidence":
        this.answer(message.revision, (graph) => evidencePage(graph, message));
        return Promise.resolve();
      case "architectureOpenFile":
        return this.openFile(message);
    }
  }

  /** The graph a request's revision points at, or null once it is gone (stale request, rebuild, empty workspace). */
  private graphFor(revision: string) {
    if (this.graph?.graph.context.revision === revision) return this.graph;
    this.options.post({ type: "architectureRevisionChanged", currentRevision: this.summary?.revision ?? "" });
    return null;
  }

  private answer(revision: string, read: (graph: ArchitectureGraph) => ArchitectureExtensionMessage): void {
    const cached = this.graphFor(revision);
    if (!cached) return;
    try {
      this.options.post(read(cached.graph));
    } catch (error) {
      // Only an unknown group gets here: the ids come from this revision's summary.
      this.options.warn(`Architecture view: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Opens a file of the cached graph. The path comes from the webview: it must be relative,
   * one of the graph's files, and stay in the workspace once symlinks are resolved (CWE-22).
   */
  private async openFile({ revision, relativePath }: ArchitectureOpenFileCommand): Promise<void> {
    const cached = this.graphFor(revision);
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

  /** Marks the cached summary stale; during a build, the build's own summary carries it. */
  markStale(): void {
    if (this.disposed) return;
    if (this.running) {
      this.changedDuringBuild = true;
      return;
    }
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
      this.summary = {
        type: "architectureSummary",
        revision: graph.context.revision,
        stale: this.changedDuringBuild,
        ...overviewArchitecture(graph, MAX_RENDERED_GROUPS),
      };
      this.graph = { graph, files: new Set(graph.nodes.map(node => node.relativePath)) };
      // Cleared only once posted: a change seen by an aborted build still applies to the next one.
      this.changedDuringBuild = false;
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
      resizeCount: this.resizeCount,
      viewSize: this.viewSize,
      interactionCount: this.interactionCount,
      interaction: this.lastInteraction,
      detailCount: this.detailCount,
      detail: this.lastDetail,
    };
  }

  /** E2E driver: sets the webview's controls; any extension can call it, so check the values. */
  setControls(controls: Omit<ArchitectureControlsMessage, "type"> | undefined): void {
    const { find, minImports, focus, expand, collapse, evidenceOf, openEvidenceRow } = controls ?? {};
    const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 256) : undefined);
    this.options.post({
      type: "architectureControls",
      find: text(find),
      minImports: Number.isSafeInteger(minImports) && Number(minImports) >= 1 ? minImports : undefined,
      focus: text(focus),
      expand: text(expand),
      collapse: text(collapse),
      evidenceOf: text(evidenceOf),
      openEvidenceRow: Number.isSafeInteger(openEvidenceRow) && Number(openEvidenceRow) >= 0 ? openEvidenceRow : undefined,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.running?.controller.abort();
    this.running = null;
  }
}
