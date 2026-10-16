import { overviewArchitecture } from "@/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import type { IndexerStatusSnapshot } from "@/analyzer/IndexerStatus";
import type {
  ArchitectureExtensionMessage,
  ArchitectureRenderedCommand,
  ArchitectureSummaryMessage,
  ArchitectureWebviewCommand,
} from "@/shared/architecture-types";
import type { CommunityMode } from "@/shared/graph-types";
import { normalizePath } from "@/shared/path";

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

/**
 * Builds the workspace architecture on demand for the sidebar's Architecture view mode.
 * A build is O(files): file changes only mark the cached summary stale.
 */
export class ArchitectureViewService {
  private summary: ArchitectureSummaryMessage | null = null;
  private running: { controller: AbortController; communityMode: CommunityMode } | null = null;
  private buildCount = 0;
  private renderCount = 0;
  private lastRender: ArchitectureRenderedCommand | null = null;
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

  /** A new build aborts the running one; an aborted build never posts its result. */
  async build(): Promise<void> {
    if (this.disposed) return;
    this.running?.controller.abort();
    const controller = new AbortController();
    const communityMode = this.options.readCommunityMode();
    this.running = { controller, communityMode };
    const { signal } = controller;
    try {
      this.options.post({ type: "architectureState", status: "building", message: "Building architecture…" });
      await waitForIdleIndex(this.options, signal, () =>
        this.options.post({ type: "architectureState", status: "building", message: "Waiting for indexing to finish…" }));
      let lastProgressAt = Number.NEGATIVE_INFINITY;
      const graph = await buildArchitectureGraph(this.options.workspaceRoot, this.options.analyzeFile, {
        communityMode,
        signal,
        onProgress: (analyzed, total) => {
          const now = Date.now();
          if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          const percent = Math.round((analyzed / total) * 100);
          this.options.post({ type: "architectureState", status: "building", message: `Analysing files (${analyzed}/${total})…`, percent });
        },
      });
      signal.throwIfAborted();
      this.buildCount += 1;
      if (graph.scannedFiles === 0) {
        this.summary = null;
        this.options.post({ type: "architectureState", status: "empty", message: "No source file found in the workspace folder." });
        return;
      }
      this.summary = {
        type: "architectureSummary",
        revision: graph.context.revision,
        stale: this.changedDuringBuild,
        ...overviewArchitecture(graph, MAX_RENDERED_GROUPS),
      };
      // Cleared only once posted: a change seen by an aborted build still applies to the next one.
      this.changedDuringBuild = false;
      this.options.post(this.summary);
    } catch (error) {
      if (signal.aborted) return;
      // Only workspace-level failures get here (per-file ones are counted in failedFiles); keep the root out of the view.
      const message = maskWorkspaceRoot(error instanceof Error ? error.message : String(error), this.options.workspaceRoot);
      this.options.post({ type: "architectureState", status: "error", message });
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
    };
  }

  dispose(): void {
    this.disposed = true;
    this.running?.controller.abort();
    this.running = null;
  }
}
