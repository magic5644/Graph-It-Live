/**
 * CallGraphViewService — orchestrates the live call-graph feature.
 *
 * Responsibilities:
 *  - Render call graphs inside the **sidebar webview** managed by GraphProvider
 *    (no separate WebviewPanel — same webview as the dependency graph)
 *  - Detect the symbol under the cursor in the active editor
 *  - Drive the extraction → indexing → neighbourhood-query pipeline
 *  - Push `ShowCallGraphMessage` and `CallGraphIndexingMessage` to the webview
 *  - Handle `callGraphOpenFile` / `callGraphSymbolFocus` messages coming back
 *
 * SPEC: specs/001-live-call-graph/spec.md — US1, US2, US3
 * NO vscode imports allowed in analyzer/ — this service is the only VS Code entry point.
 */

import { CallGraphIndexer, getSqlJsWasmPath } from "@/analyzer/callgraph/CallGraphIndexer";
import { queryNeighbourhood } from "@/analyzer/callgraph/CallGraphQuery";
import { detectCycleEdges } from "@/analyzer/callgraph/cycleUtils";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { SourceFileCollector } from "@/analyzer/SourceFileCollector";
import type {
  CallGraphExtensionMessage,
  CallGraphOpenFileCommand,
  CallGraphSymbolFocusCommand,
  CallGraphWebviewCommand,
  SupportedLang,
} from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";
import fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DEPTH = 1;
/** Debounce delay (ms) for the live-refresh save listener — matches FileChangeScheduler pattern */
const SAVE_DEBOUNCE_MS = 500;

/** Safely extract a human-readable message from an unknown catch value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return "[unknown error]"; }
}
/** Maximum depth the user can request via the depth slider */
const MAX_DEPTH = 5;
/** Parallel file extraction batch size — higher = faster indexing on multi-core machines */
// WASM Tree-sitter is single-threaded; a small batch size keeps the
// extension-host event loop responsive between batches.
const EXTRACT_BATCH = 6;

// ---------------------------------------------------------------------------
// Language helpers
// ---------------------------------------------------------------------------

/** Maps VS Code languageId → SupportedLang for Graph-Extractor queries */
function toSupportedLang(languageId: string): SupportedLang | null {
  switch (languageId) {
    case "typescript":
    case "typescriptreact":
    case "javascript":
    case "javascriptreact":
      return "typescript";
    case "vue":
    case "svelte":
      return "typescript";
    case "python":
      return "python";
    case "rust":
      return "rust";
    default:
      return null;
  }
}

/** Maps a file extension to the SupportedLang key used by GraphExtractor queries. */
function langFromPath(filePath: string): SupportedLang | null {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if (ext === ".vue" || ext === ".svelte") return "typescript";
  if ([".py", ".pyi"].includes(ext)) return "python";
  if (ext === ".rs") return "rust";
  return null;
}

/**
 * Returns per-language freshness cutoffs derived from query-file mtimes.
 * If a file was indexed before its language query was updated, it must be
 * re-extracted even if the source file mtime itself is unchanged.
 */
async function getQueryFreshnessCutoffs(extensionPath: string): Promise<Record<SupportedLang, number>> {
  const queryFiles: Record<SupportedLang, string> = {
    typescript: path.join(extensionPath, "dist", "queries", "typescript.scm"),
    javascript: path.join(extensionPath, "dist", "queries", "typescript.scm"),
    python: path.join(extensionPath, "dist", "queries", "python.scm"),
    rust: path.join(extensionPath, "dist", "queries", "rust.scm"),
  };

  const entries = await Promise.all(
    (Object.entries(queryFiles) as Array<[SupportedLang, string]>).map(async ([lang, queryPath]) => {
      try {
        const stat = await fs.stat(queryPath);
        return [lang, Math.floor(stat.mtimeMs)] as const;
      } catch {
        // Missing query file should not block indexing.
        return [lang, 0] as const;
      }
    }),
  );

  return Object.fromEntries(entries) as Record<SupportedLang, number>;
}

// ---------------------------------------------------------------------------
// CallGraphViewService
// ---------------------------------------------------------------------------

export class CallGraphViewService implements vscode.Disposable {
  /** Sidebar webview managed by GraphProvider — set via setSidebarWebview(). */
  private sidebarWebview: vscode.WebviewView | null = null;
  private indexer: CallGraphIndexer | null = null;
  private readonly outputChannel: vscode.OutputChannel;
  /** Buffered graph result — replayed if callGraphMounted arrives after initial postMessage */
  private pendingGraph: ReturnType<typeof queryNeighbourhood> | null = null;
  /** URI string of the file currently shown in the panel, for live-refresh */
  private currentFilePath: string | null = null;
  /** Set of node IDs in the currently displayed neighbourhood — used to scope saves */
  private currentNeighbourhoodPaths = new Set<string>();
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveListener: vscode.Disposable | null = null;
  /** Workspace root for which the DB has been fully indexed (null = not indexed yet). */
  private workspaceIndexedRoot: string | null = null;
  /** De-duplication guard: promise for an in-flight workspace index pass. */
  private indexWorkspacePromise: Promise<void> | null = null;
  /** True when the in-flight indexWorkspacePromise was started in silent (background) mode. */
  private indexWorkspacePromiseSilent = false;
  /** Current depth for neighbourhood queries (user-adjustable via slider). */
  private currentDepth = DEFAULT_DEPTH;
  /** ID of the current root symbol (for depth-change re-queries). */
  private currentRootSymbolId: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("Call Graph");
    context.subscriptions.push(this.outputChannel);
  }

  // ---------------------------------------------------------------------------
  // Sidebar integration — called by GraphProvider after resolveWebviewView()
  // ---------------------------------------------------------------------------

  /**
   * Inject the sidebar webview so call-graph messages flow through the same
   * channel as dependency-graph and symbol-graph messages.
   */
  setSidebarWebview(view: vscode.WebviewView | null): void {
    this.sidebarWebview = view;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Pre-index the call graph database for the given workspace root.
   *
   * Called by BackgroundIndexingManager after the reverse-index build completes,
   * so the call-graph DB is warm before the user ever runs `showCallGraph`.
   *
   * If the DB has already been fully indexed (same workspace root), this is a no-op.
   * The method is safe to call from any context — it initialises the indexer and
   * extractor internally.
   */
  async indexWorkspaceIfNeeded(workspaceRoot: string): Promise<void> {
    const normRoot = normalizePath(workspaceRoot);
    if (this.workspaceIndexedRoot === normRoot) {
      return; // already indexed this session
    }

    const indexer = await this.ensureIndexer();
    const extractor = new GraphExtractor({
      extensionPath: this.context.extensionPath,
      workspaceRoot: normRoot,
    });

    // silent=true: no postMessage calls — this runs in background before the user opens the call graph
    await this.indexWorkspace(normRoot, indexer, extractor, undefined, true);
    this.outputChannel.appendLine("[CallGraph] Pre-indexation complete");
  }

  /**
   * Resolve the symbol under the cursor and render its call-graph neighbourhood.
   */
  async show(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showInformationMessage(
        "Graph-It-Live: Open a source file and position the cursor on a symbol first.",
      );
      return;
    }

    const lang = toSupportedLang(editor.document.languageId);
    if (!lang) {
      await vscode.window.showInformationMessage(
        `Graph-It-Live: Call Graph is not supported for "${editor.document.languageId}". Supported: TypeScript, JavaScript, Vue, Svelte, Python, Rust.`,
      );
      return;
    }

    const filePath = normalizePath(editor.document.uri.fsPath);
    const cursorLine = editor.selection.active.line; // 0-based

    this.postMessage({ type: "callGraphIndexing", status: "started", message: "Extracting current file…" });

    try {
      const workspaceRoot = normalizePath(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(filePath),
      );
      const indexer = await this.ensureIndexer();
      const extractor = new GraphExtractor({
        extensionPath: this.context.extensionPath,
        workspaceRoot,
      });

      // Step 1: Extract + index the active file immediately (fast; needed for root resolution).
      this.postMessage({ type: "callGraphIndexing", status: "progress", percent: 5, message: "Parsing current file…" });
      const fileMtime = Date.now();
      const { nodes, edges } = await extractor.extractFile(filePath, lang, fileMtime);
      indexer.indexFile(nodes, edges, filePath, lang, fileMtime);

      const fileCycleEdgeKeys = detectCycleEdges(
        edges.filter((e) => e.typeRelation !== "USES").map((e) => ({ source: e.sourceId, target: e.targetId })),
      );
      const fileCyclicPairs = edges.filter(
        (e) => fileCycleEdgeKeys.has(`${e.sourceId}->${e.targetId}`),
      );
      if (fileCyclicPairs.length > 0) {
        indexer.markCycles(fileCyclicPairs);
      }

      // Resolve root node from the just-extracted symbols (avoids DB round-trip).
      const rootNode = this.resolveRootNode(nodes, cursorLine);
      if (!rootNode) {
        this.postMessage({ type: "callGraphIndexing", status: "complete" });
        this.sendGraphToWebview(queryNeighbourhood(indexer.getDb(), "", DEFAULT_DEPTH));
        return;
      }

      // Step 2: Index the rest of the workspace.
      // The first call performs a full file walk (skipping files unchanged since last indexing).
      // Subsequent show() calls in the same session are near-instant because all fresh files
      // are already cached in the DB.
      await this.indexWorkspace(workspaceRoot, indexer, extractor, filePath);

      // Guard: the workspace walk can take seconds on first run. If the user
      // switched to a different file during indexing, abandon this result to
      // avoid rendering a stale graph for the wrong file.
      {
        const afterEditor = vscode.window.activeTextEditor;
        const afterFilePath = afterEditor ? normalizePath(afterEditor.document.uri.fsPath) : null;
        if (afterFilePath !== filePath) {
          this.outputChannel.appendLine(
            `[CallGraph] Active file changed during indexing (${filePath} → ${afterFilePath ?? "none"}); aborting stale result`,
          );
          this.postMessage({ type: "callGraphIndexing", status: "complete" });
          return;
        }
      }

      // Step 3: Resolve cross-file edges so that symbols from the active file
      // that INHERITS/IMPLEMENTS/CALLS symbols in the workspace DB (and vice versa)
      // are properly linked. resolveExternalEdges() is idempotent — already-resolved
      // edges are unchanged; only new @@external stubs (from step 1) are processed.
      this.postMessage({ type: "callGraphIndexing", status: "progress", percent: 92, message: "Resolving cross-file edges…" });
      const resolveStats = indexer.resolveExternalEdges();
      if (resolveStats.resolved > 0) {
        this.outputChannel.appendLine(
          `[CallGraph] Post-file resolve: ${resolveStats.resolved} cross-file edges resolved`,
        );
      }

      // Step 4: Query the neighbourhood and render.
      this.postMessage({ type: "callGraphIndexing", status: "progress", percent: 96, message: "Querying neighbourhood…" });

      const result = queryNeighbourhood(indexer.getDb(), rootNode.id, this.currentDepth);
      this.currentRootSymbolId = rootNode.id;
      this.outputChannel.appendLine(`[CallGraph] Rendered ${result.nodes.length} nodes, ${result.edges.length} edges`);
      this.postMessage({ type: "callGraphIndexing", status: "complete" });
      this.sendGraphToWebview(result);

      this.currentFilePath = filePath;
      this.currentNeighbourhoodPaths = new Set(result.nodes.map((n) => n.path));
      this.registerSaveListener(workspaceRoot);
    } catch (err: unknown) {
      const message = errorMessage(err);
      this.outputChannel.appendLine(`[CallGraph] Error: ${message}`);
      this.postMessage({ type: "callGraphIndexing", status: "error", message });
    }
  }

  dispose(): void {
    this.clearSaveDebounce();
    this.saveListener?.dispose();
    this.saveListener = null;
    this.sidebarWebview = null;
    this.indexer?.dispose();
    this.indexer = null;
    // Reset workspace index state so the next activation starts fresh with an empty DB.
    this.workspaceIndexedRoot = null;
    this.indexWorkspacePromise = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async ensureIndexer(): Promise<CallGraphIndexer> {
    if (!this.indexer) {
      const wasmPath = getSqlJsWasmPath(this.context.extensionPath);
      this.indexer = new CallGraphIndexer(wasmPath);
      await this.indexer.init();
    }
    return this.indexer;
  }

  private postMessage(message: CallGraphExtensionMessage): void {
    this.sidebarWebview?.webview.postMessage(message).then(undefined, (err: unknown) => {
      this.outputChannel.appendLine(`[CallGraph] postMessage failed: ${errorMessage(err)}`);
    });
  }

  private sendGraphToWebview(result: ReturnType<typeof queryNeighbourhood>): void {
    // Buffer so we can replay if callGraphMounted fires after the initial postMessage
    // (race on first open: React may not have mounted its listener yet).
    this.pendingGraph = result;
    this.postGraphData(result);
  }

  /**
   * Post graph data directly to the webview WITHOUT touching `pendingGraph`.
   * Used for the callGraphMounted replay to avoid an infinite loop:
   *   sendGraphToWebview → pendingGraph set → callGraphReady → sendGraphToWebview → …
   */
  private postGraphData(result: ReturnType<typeof queryNeighbourhood>): void {
    this.postMessage({
      type: "showCallGraph",
      rootSymbolId: result.rootSymbolId,
      nodes: result.nodes,
      edges: result.edges,
      compounds: result.compounds,
      depth: result.depth,
      timestamp: result.timestamp,
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace indexing
  // ---------------------------------------------------------------------------

  /**
   * Index all call-graph-supported source files in the workspace.
   *
   * The first call performs a full directory walk and extracts every TS/JS/Python/Rust
   * file, skipping those whose mtime matches the DB record (unchanged since last run).
   * Concurrent calls join the in-flight promise instead of starting a second walk.
   *
   * @param workspaceRoot  Normalized absolute workspace root to scan.
   * @param indexer        Active CallGraphIndexer (sql.js DB).
   * @param extractor      GraphExtractor to use for Tree-sitter parsing.
   * @param skipPath       File already freshly indexed this session (avoids duplicate work).
   */
  private async indexWorkspace(
    workspaceRoot: string,
    indexer: CallGraphIndexer,
    extractor: GraphExtractor,
    skipPath?: string,
    silent = false,
  ): Promise<void> {
    // If we already completed a full workspace pass this session, skip the walk.
    // The sql.js DB persists across show() calls until the panel is disposed.
    if (this.workspaceIndexedRoot === workspaceRoot) {
      return;
    }

    if (this.indexWorkspacePromise !== null) {
      // Another call is already walking the workspace — join it.
      // If this caller is interactive (not silent) but the running walk is silent,
      // upgrade the in-flight walk to stream progress from the next batch onward.
      if (!silent && this.indexWorkspacePromiseSilent) {
        this.indexWorkspacePromiseSilent = false;
        this.postMessage({
          type: "callGraphIndexing",
          status: "progress",
          percent: 10,
          message: "Indexing workspace…",
        });
      }
      return this.indexWorkspacePromise;
    }

    this.indexWorkspacePromiseSilent = silent;
    this.indexWorkspacePromise = this.doIndexWorkspace(workspaceRoot, indexer, extractor, skipPath)
      .finally(() => {
        this.indexWorkspacePromise = null;
        this.indexWorkspacePromiseSilent = false;
      });

    return this.indexWorkspacePromise;
  }

  /**
   * Batch `fs.stat` all files and filter out those already fresh in the DB.
   * Returns an array of jobs that need (re-)extraction plus the count of skipped files.
   */
  private async collectChangedFiles(
    callgraphFiles: string[],
    indexer: CallGraphIndexer,
    queryFreshnessCutoffs: Record<SupportedLang, number>,
  ): Promise<{ jobs: Array<{ filePath: string; lang: SupportedLang; mtime: number }>; skipped: number }> {
    const jobs: Array<{ filePath: string; lang: SupportedLang; mtime: number }> = [];
    let skipped = 0;
    const STAT_BATCH = 32;

    for (let i = 0; i < callgraphFiles.length; i += STAT_BATCH) {
      const batch = callgraphFiles.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(
        batch.map(async (fp) => {
          try {
            const s = await fs.stat(fp);
            return { fp, mtime: Math.floor(s.mtimeMs), ok: true as const };
          } catch {
            return { fp, mtime: 0, ok: false as const };
          }
        }),
      );
      for (const s of stats) {
        if (!s.ok) { skipped++; continue; }
        const lang = langFromPath(s.fp);
        if (!lang) { skipped++; continue; }

        const record = indexer.getFileRecord(s.fp);
        const queryCutoff = queryFreshnessCutoffs[lang] ?? 0;

        // Skip only if both the source file AND extractor rules are still fresh.
        if (record && record.lastModified >= s.mtime && record.indexedAt >= queryCutoff) {
          skipped++;
          continue;
        }

        jobs.push({ filePath: s.fp, lang, mtime: s.mtime });
      }
    }
    return { jobs, skipped };
  }

  /**
   * Extract files in parallel batches, insert into the DB serially,
   * and accumulate edges for a final cycle-detection pass.
   */
  private async extractAndIndexBatches(
    jobs: Array<{ filePath: string; lang: SupportedLang; mtime: number }>,
    indexer: CallGraphIndexer,
    extractor: GraphExtractor,
    progressState: { done: number; total: number },
  ): Promise<Array<{ sourceId: string; targetId: string; typeRelation: string }>> {
    const allEdges: Array<{ sourceId: string; targetId: string; typeRelation: string }> = [];

    for (let i = 0; i < jobs.length; i += EXTRACT_BATCH) {
      const batch = jobs.slice(i, i + EXTRACT_BATCH);
      const results = await Promise.all(
        batch.map(async (job) => {
          try {
            return { job, extracted: await extractor.extractFile(job.filePath, job.lang, job.mtime), ok: true as const };
          } catch (err: unknown) {
            this.outputChannel.appendLine(`[CallGraph] Skipping ${job.filePath}: ${errorMessage(err)}`);
            return { job, extracted: null, ok: false as const };
          }
        }),
      );

      for (const r of results) {
        if (r.ok && r.extracted) {
          indexer.indexFile(r.extracted.nodes, r.extracted.edges, r.job.filePath, r.job.lang, r.job.mtime);
          for (const e of r.extracted.edges) {
            allEdges.push({ sourceId: e.sourceId, targetId: e.targetId, typeRelation: e.typeRelation });
          }
        }
        progressState.done++;
      }

      // Check the runtime flag so a silent background walk can be "upgraded"
      // to interactive mid-flight (indexWorkspacePromiseSilent set to false by show()).
      if (!this.indexWorkspacePromiseSilent) {
        const percent = Math.round(10 + (progressState.done / progressState.total) * 80);
        this.postMessage({
          type: "callGraphIndexing",
          status: "progress",
          percent,
          message: `Indexing workspace… ${progressState.done}/${progressState.total}`,
        });
      }

      // Yield the extension-host event loop between batches so VS Code navigation
      // (editor switching, typing, IntelliSense) stays responsive during indexing.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return allEdges;
  }

  private async doIndexWorkspace(
    workspaceRoot: string,
    indexer: CallGraphIndexer,
    extractor: GraphExtractor,
    skipPath?: string,
  ): Promise<void> {
    const collector = new SourceFileCollector({
      excludeNodeModules: true,
      yieldIntervalMs: 30,
      isCancelled: () => false,
    });

    const allFiles = await collector.collectAllSourceFiles(workspaceRoot);
    const callgraphFiles = allFiles
      .map(normalizePath)
      .filter((f) => langFromPath(f) !== null && f !== skipPath);

    const total = callgraphFiles.length;
    this.outputChannel.appendLine(`[CallGraph] Workspace indexing: ${total} files to process`);

    // Phase 1 — batch stat to find changed files
    const queryFreshnessCutoffs = await getQueryFreshnessCutoffs(this.context.extensionPath);
    const { jobs, skipped } = await this.collectChangedFiles(callgraphFiles, indexer, queryFreshnessCutoffs);
    this.outputChannel.appendLine(`[CallGraph] ${jobs.length} files need (re-)extraction`);

    // Phase 2 — parallel extraction + serial DB insertion
    const progressState = { done: skipped, total };
    const allEdges = await this.extractAndIndexBatches(jobs, indexer, extractor, progressState);

    // Phase 3 — single cycle-detection pass
    const nonUsesEdges = allEdges
      .filter((e) => e.typeRelation !== "USES")
      .map((e) => ({ source: e.sourceId, target: e.targetId }));
    if (nonUsesEdges.length > 0) {
      const cycleEdgeKeys = detectCycleEdges(nonUsesEdges);
      const cyclicPairs = allEdges.filter(
        (e) => cycleEdgeKeys.has(`${e.sourceId}->${e.targetId}`),
      );
      if (cyclicPairs.length > 0) {
        indexer.markCycles(cyclicPairs.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId })));
      }
    }

    this.workspaceIndexedRoot = workspaceRoot;
    this.outputChannel.appendLine(`[CallGraph] Workspace indexing complete: ${progressState.done}/${total} files processed`);

    this.outputChannel.appendLine("[CallGraph] Resolving cross-file edges…");
    const resolveStats = indexer.resolveExternalEdges();
    this.outputChannel.appendLine(
      `[CallGraph] Cross-file edge resolution: resolved=${resolveStats.resolved} unresolved=${resolveStats.deleted}`,
    );
  }

  /**
   * Resolve the most specific symbol node that contains the cursor line.
   * If the cursor is outside all node ranges, returns the first node.
   */
  private resolveRootNode(
    nodes: Array<{ id: string; startLine: number; endLine: number }>,
    cursorLine: number,
  ): { id: string } | null {
    if (nodes.length === 0) { return null; }

    // Find nodes whose range contains the cursor, pick the most specific (latest start)
    let best: { id: string; startLine: number } | null = null;
    for (const n of nodes) {
      if (n.startLine <= cursorLine && cursorLine <= n.endLine) {
        if (!best || n.startLine > best.startLine) {
          best = n;
        }
      }
    }
    return best ?? nodes[0];
  }

  // ---------------------------------------------------------------------------
  // T020 — callGraphOpenFile / T038 — callGraphSymbolFocus handlers
  // ---------------------------------------------------------------------------

  public handleWebviewMessage(msg: CallGraphWebviewCommand): void {
    if (msg.command === "callGraphOpenFile") {
      this.handleOpenFile(msg).catch((err: unknown) => {
        this.outputChannel.appendLine(`[CallGraph] openFile error: ${errorMessage(err)}`);
      });
    } else if (msg.command === "callGraphSymbolFocus") {
      this.handleSymbolFocus(msg).catch((err: unknown) => {
        this.outputChannel.appendLine(`[CallGraph] symbolFocus error: ${errorMessage(err)}`);
      });
    } else if (msg.command === "callGraphMounted") {
      // Webview message listener is now active — replay any buffered graph data
      // that was posted before the listener was registered (race on first open).
      if (this.pendingGraph) {
        const g = this.pendingGraph;
        this.pendingGraph = null;
        // Use postGraphData (not sendGraphToWebview) to avoid re-buffering and
        // triggering another callGraphMounted → sendGraphToWebview → callGraphMounted loop.
        this.postGraphData(g);
      }
    } else if (msg.command === "callGraphReady") {
      // Graph rendered successfully — telemetry / E2E test instrumentation only.
      // Do NOT replay here; that caused an infinite postMessage loop.
      this.outputChannel.appendLine(
        `[CallGraph] Rendered ${msg.nodeCount} nodes, ${msg.edgeCount} edges`,
      );
      // Clear stale pending buffer now that we know the webview rendered.
      this.pendingGraph = null;
    } else if (msg.command === "callGraphDepthChanged") {
      this.handleDepthChanged(msg.depth);
    } else if (msg.command === "callGraphFilterChanged") {
      // T028: log for now; persistence is a future enhancement
      this.outputChannel.appendLine(
        `[CallGraph] Filter changed: ${msg.filterType}=${msg.value} visible=${String(msg.visible)}`,
      );
    }
  }

  private async handleOpenFile(msg: CallGraphOpenFileCommand): Promise<void> {
    // Validate the URI is an absolute path (defence-in-depth against webview injection)
    if (!msg.uri || !path.isAbsolute(msg.uri)) {
      this.outputChannel.appendLine(`[CallGraph] openFile: invalid URI "${msg.uri ?? ""}"`);
      return;
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.uri));
    } catch {
      await vscode.window.showErrorMessage(
        `Graph-It-Live: Could not open file: ${msg.uri}`,
      );
      return;
    }

    const position = new vscode.Position(msg.line, msg.character);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(position, position),
      preserveFocus: false,
      preview: true,
    });
  }

  /**
   * Handle depth-slider change from the webview.
   * Clamp to [1, MAX_DEPTH], re-query the neighbourhood at the new depth, and push
   * the updated graph to the webview.
   */
  private handleDepthChanged(depth: number): void {
    const clamped = Math.max(1, Math.min(MAX_DEPTH, Math.round(depth)));
    this.currentDepth = clamped;
    this.outputChannel.appendLine(`[CallGraph] Depth changed to ${clamped}`);

    const indexer = this.indexer;
    const rootId = this.currentRootSymbolId;
    if (!indexer || !rootId) return;

    const result = queryNeighbourhood(indexer.getDb(), rootId, clamped);
    this.currentNeighbourhoodPaths = new Set(result.nodes.map((n) => n.path));
    this.sendGraphToWebview(result);
  }

  /**
   * T038: Handle symbol-focus click.
   * (a) Navigate VS Code to the symbol definition.
   * (b) Re-query the call graph centred on the clicked node and push it to the webview.
   */
  private async handleSymbolFocus(msg: CallGraphSymbolFocusCommand): Promise<void> {
    // Navigate to source
    await this.handleOpenFile({
      command: "callGraphOpenFile",
      uri: msg.path,
      line: msg.startLine,
      character: msg.startCol,
    });

    // Re-query the neighbourhood with the clicked node as new root
    const indexer = this.indexer;
    if (!indexer) return;

    const result = queryNeighbourhood(indexer.getDb(), msg.nodeId, this.currentDepth);
    this.currentRootSymbolId = msg.nodeId;
    const label = msg.nodeId.split(":").at(-2) ?? msg.nodeId;
    this.outputChannel.appendLine(`[CallGraph] Recentered on "${label}" — ${result.nodes.length} nodes, ${result.edges.length} edges`);
    this.currentNeighbourhoodPaths = new Set(result.nodes.map((n) => n.path));
    this.sendGraphToWebview(result);
  }

  // ---------------------------------------------------------------------------
  // T024 — onDidSaveTextDocument live-refresh
  // ---------------------------------------------------------------------------

  private registerSaveListener(workspaceRoot: string): void {
    // Only one listener at a time
    this.saveListener?.dispose();
    this.saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
      const savedPath = normalizePath(doc.uri.fsPath);
      if (this.currentNeighbourhoodPaths.has(savedPath)) {
        this.scheduleRefresh(savedPath, doc.languageId, workspaceRoot);
      }
    });
    this.context.subscriptions.push(this.saveListener);
  }

  private scheduleRefresh(filePath: string, languageId: string, workspaceRoot: string): void {
    this.clearSaveDebounce();
    this.saveDebounceTimer = setTimeout(() => {
      this.refreshFile(filePath, languageId, workspaceRoot).catch((err: unknown) => {
        this.outputChannel.appendLine(`[CallGraph] refresh error: ${errorMessage(err)}`);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  private clearSaveDebounce(): void {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
  }

  private async refreshFile(filePath: string, languageId: string, workspaceRoot: string): Promise<void> {
    const lang = toSupportedLang(languageId);
    if (!lang || !this.currentFilePath) { return; }

    const indexer = await this.ensureIndexer();
    indexer.invalidateFile(filePath);

    const extractor = new GraphExtractor({
      extensionPath: this.context.extensionPath,
      workspaceRoot,
    });
    const mtime = Date.now();
    const { nodes, edges } = await extractor.extractFile(filePath, lang, mtime);
    indexer.indexFile(nodes, edges, filePath, lang, mtime);

    const cycleEdgeKeys = detectCycleEdges(edges.map((e) => ({ source: e.sourceId, target: e.targetId })));
    const cyclicPairs = edges.filter(
      (e) => cycleEdgeKeys.has(`${e.sourceId}->${e.targetId}`),
    );
    if (cyclicPairs.length > 0) {
      indexer.markCycles(cyclicPairs);
    }

    // Re-resolve cross-file edges since this file may introduce or change call stubs.
    indexer.resolveExternalEdges();

    // Re-query using the same root and re-send the graph
    if (this.currentFilePath) {
      // Re-extract the root symbol from the previously used rootSymbolId isn't stored,
      // so we re-query from the primary file's first node as fallback.
      // A future enhancement could persist the rootSymbolId.
      const rootRecord = indexer.getFileRecord(this.currentFilePath);
      if (!rootRecord) { return; }
      // Query from the indexed root file — get first node as root
      const db = indexer.getDb();
      const stmt = db.prepare("SELECT id FROM nodes WHERE path = ? LIMIT 1");
      stmt.bind([this.currentFilePath]);
      let rootId = "";
      if (stmt.step()) {
        const row = stmt.getAsObject() as { id: string };
        rootId = row.id;
      }
      stmt.free();
      if (!rootId) { return; }

      const result = queryNeighbourhood(db, rootId, this.currentDepth);
      this.currentNeighbourhoodPaths = new Set(result.nodes.map((n) => n.path));
      this.sendGraphToWebview(result);
    }
  }
}
