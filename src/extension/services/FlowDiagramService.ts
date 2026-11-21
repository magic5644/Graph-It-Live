import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CallGraphNode } from "@/analyzer/callgraph/CallGraphIndexer";
import { workspaceName } from "@/analyzer/diagram/architectureDiagram";
import type { DiagramTheme } from "@/analyzer/diagram/diagramStyle";
import { renderDiagramSvg } from "@/analyzer/diagram/diagramSvg";
import type { FlowLayout } from "@/analyzer/diagram/flowDiagram";
import type { FlowModel, FlowModelRequest } from "@/analyzer/diagram/flowModel";
import { renderFlowDiagram } from "@/analyzer/diagram/workspaceDiagram";
import {
  DIAGRAM_TABS,
  type ArchitectureControlsMessage,
  type ArchitectureExportTarget,
  type ArchitectureExtensionMessage,
  type DiagramCrumb,
  type DiagramFollowCommand,
  type DiagramRescopeCommand,
  type DiagramShownCommand,
  type FlowDiagramEdge,
  type FlowDiagramMessage,
  type FlowDiagramNode,
  type FlowDiagramStateMessage,
  type FlowExportDiagramCommand,
  type FlowOpenLocationCommand,
  type FlowRefreshCommand,
  type FlowShowCallGraphCommand,
} from "@/shared/architecture-types";
import { normalizePath } from "@/shared/path";
import { maskWorkspaceRoot, workspaceExportFile } from "./ArchitectureViewService";
import type { CallGraphViewService, FileSymbols } from "./CallGraphViewService";
import { symbolAtLine } from "./CallGraphViewService";

/** Follow cursor waits this long after the last selection or editor change. */
export const FOLLOW_DEBOUNCE_MS = 300;
const SUPPORTED = "Supported: TypeScript, JavaScript, Vue, Svelte, Python, Rust, C#, Go, Java, GraphQL.";
const EXPORT_FORMATS: Readonly<Record<string, "svg" | "html" | "diagram-spec">> = { ".svg": "svg", ".html": "html", ".htm": "html", ".json": "diagram-spec" };

/** The CLI palette of an editor theme: high contrast draws dark, high contrast light draws light (export parity). */
export function diagramThemeFor(kind: vscode.ColorThemeKind): DiagramTheme {
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? "dark" : "light";
}

export type FlowWebviewCommand =
  | FlowOpenLocationCommand
  | FlowExportDiagramCommand
  | FlowRefreshCommand
  | FlowShowCallGraphCommand
  | DiagramRescopeCommand
  | DiagramFollowCommand
  | DiagramShownCommand;

export interface FlowDiagramServiceOptions {
  callGraph: Pick<CallGraphViewService, "extractFileSymbols" | "indexForFlow" | "isFlowSupported" | "activeSourceEditor">;
  post: (message: ArchitectureExtensionMessage) => void;
  workspaceRoot: () => string | undefined;
  diagramTheme: () => DiagramTheme;
  notify: (message: string, level: "info" | "error") => void;
  /** Asks where to save the flow (SVG, HTML, Diagram spec), starting at `defaultPath`; undefined when cancelled. */
  pickDiagramFile: (defaultPath: string) => Promise<string | undefined>;
  writeClipboard: (text: string) => Promise<void>;
  openLocation: (absolutePath: string, line: number) => Promise<void>;
  showCallGraphAt: (absolutePath: string, line: number) => Promise<void>;
  /** Follow cursor on the Folder tab: shows the level of a workspace-relative directory, silently. */
  followFolder: (relativeDir: string) => Promise<boolean>;
}

/** The last flow drawn: what export, refresh, open and the theme re-render read; never a path from the webview. */
interface DrawnFlow {
  request: FlowModelRequest;
  rootDir: string;
  layout: FlowLayout;
  model: FlowModel;
  message: FlowDiagramMessage;
  /** Normalized absolute files of the steps: a save of one marks the flow stale. */
  files: Set<string>;
  source: { db: Parameters<typeof renderFlowDiagram>[0]; extractor: Parameters<typeof renderFlowDiagram>[1]["extractor"] };
}

/** Where a draw comes from: a command (progress notification) or the view itself (Follow, Refresh, breadcrumb). */
interface DrawOrigin {
  quiet?: boolean;
  inView?: boolean;
  expectActiveFile?: string;
}

const isIndex = (value: unknown, length: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < length;

/** Accessible names and overlay boxes from the model and the layout: `layout.nodes[i]` is `model.nodes[i]`, edges by `edge` index. */
export function flowGeometry(model: FlowModel, layout: FlowLayout): { nodes: FlowDiagramNode[]; edges: FlowDiagramEdge[] } {
  if (layout.nodes.length !== model.nodes.length || layout.nodes.some((box, index) => box.id !== model.nodes[index].id)) {
    throw new Error("internal error: the flow layout does not match its model");
  }
  const total = model.nodes.length;
  const nodes = model.nodes.map(({ id, title, file, line, lane }, index): FlowDiagramNode => {
    const { x, y, width, height } = layout.nodes[index];
    return { id, title, file, line, lane, name: `Step ${index + 1} of ${total}: ${title}, ${file}:${line}, ${lane} lane`, x, y, width, height };
  });
  const titles = new Map(model.nodes.map((node) => [node.id, node.title]));
  const edges = layout.edges.map(({ edge, label }): FlowDiagramEdge => {
    const { from, to, file, line, relation, lane } = model.edges[edge];
    const name = `Call ${titles.get(from) ?? from} → ${titles.get(to) ?? to} at ${file}:${line}, ${lane} lane`;
    return { from, to, file, line, relation, lane, name, label: { x: label.x, y: label.y, text: label.text } };
  });
  return { nodes, edges };
}

/** workspace > folder > file > symbol of a flow's entry, the folder left out at the root. */
function flowCrumbs(rootDir: string, filePath: string, symbolName: string): DiagramCrumb[] {
  const file = normalizePath(path.relative(rootDir, filePath));
  const folder = path.posix.dirname(file);
  return [
    { kind: "workspace", label: workspaceName(rootDir) },
    ...(folder === "." ? [] : [{ kind: "folder" as const, label: path.posix.basename(folder), key: folder }]),
    { kind: "file", label: path.posix.basename(file), key: file },
    // The CLI's file#symbol: no absolute path reaches the webview.
    { kind: "symbol", label: symbolName, key: `${file}#${symbolName}` },
  ];
}

/**
 * The Flow tab of the Architecture mode: one symbol's call flow drawn by the CLI's renderer, with the
 * geometry of its boxes for the webview's overlay buttons. Works on a loose file without a folder.
 */
export class FlowDiagramService implements vscode.Disposable {
  /** The requestId of the flow messages: one per render, theme re-renders included. */
  private requestCount = 0;
  /** The requestId of the last flow message or state posted: the view's commands echo it. */
  private current = 0;
  /** One per draw started: a newer draw supersedes an older one still waiting. */
  private drawCount = 0;
  private drawn: DrawnFlow | null = null;
  /** The entry of the last draw request, drawn or empty: Show call graph and Refresh read it. */
  private entry: { filePath: string; symbolName: string; startLine: number; key: string } | null = null;
  private lastState: FlowDiagramStateMessage | null = null;
  /** A draw the user asked for (announced by loading) the view has not shown on its Flow tab yet: replayed with loading on mount, so it takes the tab. */
  private unseen = false;
  private follow = false;
  private followTab: "flow" | "folder" = "flow";
  private followSubscriptions: vscode.Disposable[] = [];
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFollowedFolder: string | undefined;
  private running: vscode.CancellationTokenSource | undefined;
  /** cancelForE2E ran with no wait running: the next draw starts cancelled. */
  private cancelNext = false;
  private exportOutput: string | undefined;
  private lastError: string | undefined;
  private lastOpened: { file: string; line: number } | undefined;
  /** What the view last reported it shows (E2E observability only). */
  private shown: DiagramShownCommand | undefined;

  constructor(private readonly options: FlowDiagramServiceOptions) {}

  /** Show Flow Diagram: the symbol at the cursor, else a pick of the file's symbols. False when nothing was drawn (mode unchanged). */
  async showAtCursor(editor: vscode.TextEditor | undefined, options: { quiet?: boolean } = {}): Promise<boolean> {
    const { quiet } = options;
    if (!quiet) this.setFollow(false);
    const lang = quiet ? editor && this.options.callGraph.isFlowSupported(editor.document) : this.options.callGraph.activeSourceEditor("Flow Diagram", editor)?.lang;
    if (!editor || !lang) return false;
    const filePath = normalizePath(editor.document.uri.fsPath);
    const symbols = await this.options.callGraph.extractFileSymbols(filePath, lang, { quiet });
    if (!symbols) return false;
    const atCursor = symbolAtLine(symbols.nodes, editor.selection.active.line);
    // Follow: between symbols, or on the flow already drawn, nothing changes.
    if (quiet && (!atCursor || this.entry?.key === `${filePath}#${atCursor.id}`)) return false;
    const node = atCursor ?? (await this.pickSymbol(filePath, symbols.nodes));
    if (!node) return false;
    return this.draw(filePath, symbols, node, { quiet, inView: quiet, expectActiveFile: filePath });
  }

  /** Explorer, Show Diagram… or a file crumb: a pick of the file's symbols. */
  async showForFile(uri: vscode.Uri, options: { inView?: boolean } = {}): Promise<boolean> {
    this.setFollow(false);
    const filePath = normalizePath(uri.fsPath);
    const lang = this.options.callGraph.isFlowSupported({ uri });
    if (!lang) {
      this.options.notify(`Graph-It-Live: Flow Diagram is not supported for "${path.extname(filePath) || path.basename(filePath)}". ${SUPPORTED}`, "info");
      return false;
    }
    const symbols = await this.options.callGraph.extractFileSymbols(filePath, lang);
    if (!symbols) return false;
    const node = await this.pickSymbol(filePath, symbols.nodes);
    return node ? this.draw(filePath, symbols, node, { inView: options.inView }) : false;
  }

  /** The symbol the user picks; a file without symbols is told. Escape: undefined, silently. */
  private async pickSymbol(filePath: string, nodes: CallGraphNode[]): Promise<CallGraphNode | undefined> {
    const relative = vscode.workspace.asRelativePath(filePath);
    if (nodes.length === 0) {
      this.options.notify(`Graph-It-Live: ${relative} has no symbol to draw a flow from.`, "info");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      nodes.map((node) => ({ label: node.name, description: `line ${node.startLine + 1}`, node })),
      { placeHolder: `Pick the symbol of ${relative} to draw its flow` },
    );
    return picked?.node;
  }

  /** Waits for the index (under a cancellable progress notification for a command), then draws. */
  private async draw(filePath: string, symbols: FileSymbols, node: CallGraphNode, origin: DrawOrigin): Promise<boolean> {
    const drawId = ++this.drawCount;
    this.running?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.running = source;
    if (this.cancelNext) source.cancel();
    this.cancelNext = false;
    const request: FlowModelRequest = { filePath, symbolName: node.name, startLine: node.startLine + 1 };
    const previousEntry = this.entry;
    this.entry = { filePath, symbolName: node.name, startLine: node.startLine + 1, key: `${filePath}#${node.id}` };
    const crumbs = flowCrumbs(symbols.rootDir, filePath, node.name);
    // The view switches to the Flow tab on it; a cancelled or abandoned draw tells it to go back.
    this.send({ type: "flowDiagramState", status: "loading", crumbs });
    const run = async () => {
      const drawn = await this.render(drawId, request, symbols, crumbs, origin, source.token);
      if (drawn === undefined) this.entry = previousEntry;
      return drawn === true;
    };
    try {
      if (origin.quiet || origin.inView) return await run();
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Graph-It-Live: drawing the flow diagram…", cancellable: true },
        (_progress, token) => {
          token.onCancellationRequested(() => source.cancel());
          return run();
        },
      );
    } finally {
      if (this.running === source) this.running = undefined;
      source.dispose();
    }
  }

  private async render(
    drawId: number,
    request: FlowModelRequest,
    symbols: FileSymbols,
    crumbs: DiagramCrumb[],
    origin: DrawOrigin,
    token: vscode.CancellationToken,
  ): Promise<boolean | undefined> {
    const { rootDir } = symbols;
    /** Cancelled or abandoned: the view leaves loading for the flow it showed (or its previous tab); superseded: the newer draw answers. */
    const abandon = () => {
      if (drawId !== this.drawCount) return false;
      this.send({ type: "flowDiagramState", status: "cancelled" });
      if (this.lastState) this.send(this.lastState);
      return undefined;
    };
    try {
      const indexed = await this.options.callGraph.indexForFlow({ filePath: request.filePath, edges: symbols.edges, rootDir }, { token, expectActiveFile: origin.expectActiveFile });
      if (!indexed || token.isCancellationRequested || drawId !== this.drawCount) return abandon();
      const result = await renderFlowDiagram(indexed.db, { rootDir, extractor: indexed.extractor }, request, { format: "svg", theme: this.options.diagramTheme() });
      if (token.isCancellationRequested || drawId !== this.drawCount) return abandon();
      if (result.model.edges.length === 0) {
        this.drawn = null;
        this.send({ type: "flowDiagramState", status: "empty", message: request.symbolName, crumbs });
        return true;
      }
      const { layout, model } = result;
      const message: FlowDiagramMessage = {
        type: "flowDiagram", requestId: 0, svg: result.markup, width: layout.width, height: layout.height,
        title: layout.text.title, caption: layout.text.caption, counts: layout.text.counts,
        crumbs, entry: model.entry, ...flowGeometry(model, layout), stale: false,
      };
      const files = new Set(model.nodes.map((step) => normalizePath(path.resolve(rootDir, step.file))));
      this.drawn = { request, rootDir, layout, model, message, files, source: { db: indexed.db, extractor: indexed.extractor } };
      this.lastState = null;
      this.lastError = undefined;
      this.send(message);
      return true;
    } catch (error) {
      if (drawId !== this.drawCount) return false;
      const reason = maskWorkspaceRoot(error instanceof Error ? error.message : String(error), rootDir);
      this.lastError = reason;
      // Follow never toasts; the view says it on its error line (the previous diagram stays).
      if (!origin.quiet) this.options.notify(`Graph-It-Live: ${reason}`, "error");
      this.send({ type: "flowDiagramState", status: "error", message: reason, crumbs });
      return false;
    }
  }

  /** Posts a flow or a state under a new requestId, the one the view's next commands echo; keeps it for a remount. */
  private send(message: FlowDiagramMessage | Omit<FlowDiagramStateMessage, "requestId">): void {
    this.current = ++this.requestCount;
    if (message.type === "flowDiagram") {
      this.drawn!.message = { ...message, requestId: this.current };
      this.options.post(this.drawn!.message);
      return;
    }
    const state = { ...message, requestId: this.current };
    // A cancel replays the flow the view already had: nothing new for it to take the tab with.
    if (state.status === "loading" || state.status === "cancelled") this.unseen = state.status === "loading";
    // A loading or cancelled state is never replayed: the draw it announces posts its own outcome.
    if (state.status !== "loading" && state.status !== "cancelled") this.lastState = state;
    this.options.post(state);
  }

  /** The last flow and its state again (after a mount, or to end a loading state the draw abandoned). */
  private repost(): void {
    const crumbs = this.lastState?.crumbs ?? this.drawn?.message.crumbs;
    if (this.unseen && (this.drawn || this.lastState)) this.send({ type: "flowDiagramState", status: "loading", crumbs });
    if (this.drawn) this.send(this.drawn.message);
    if (this.lastState) this.send(this.lastState);
  }

  handleWebviewMessage(message: FlowWebviewCommand): Promise<void> {
    switch (message.command) {
      case "diagramFollow":
        this.setFollow(message.enabled === true, message.tab);
        return Promise.resolve();
      case "diagramRescope":
        return this.rescope(message);
      case "diagramShown":
        this.shown = message;
        if (message.tabs?.some((tab) => tab.tab === "flow" && tab.selected)) this.unseen = false;
        return Promise.resolve();
      case "flowOpenLocation":
        return this.isCurrent(message.requestId) ? this.openLocation(message.target) : Promise.resolve();
      case "flowExportDiagram":
        return this.isCurrent(message.requestId) ? this.exportDiagram(message.target) : Promise.resolve();
      case "flowRefresh":
        return this.entry && message.requestId === this.current ? this.refresh(this.entry) : Promise.resolve();
      case "flowShowCallGraph":
        return this.entry && message.requestId === this.current ? this.options.showCallGraphAt(this.entry.filePath, this.entry.startLine) : Promise.resolve();
    }
  }

  /** A request about the flow the view shows (its message or its last state); an older one is ignored. */
  private isCurrent(requestId: unknown): boolean {
    return this.drawn !== null && (requestId === this.current || requestId === this.drawn.message.requestId);
  }

  /** A Flow crumb: the file asks for its symbol again; the symbol is the current flow. Never a path from the webview. */
  private async rescope({ crumb }: DiagramRescopeCommand): Promise<void> {
    this.setFollow(false);
    if (crumb?.kind === "file" && this.entry) await this.showForFile(vscode.Uri.file(this.entry.filePath), { inView: true });
  }

  /** Opens a step (its declaration) or a call (its call site), looked up by index in the flow drawn (CWE-22). */
  private async openLocation(target: FlowOpenLocationCommand["target"]): Promise<void> {
    const { message, rootDir } = this.drawn!;
    const items = target?.kind === "edge" ? message.edges : message.nodes;
    if (!isIndex(target?.index, items.length)) return;
    const { file, line } = items[target.index];
    // No containment check: a loose file's call site may lie in ../lib, and it was drawn from the index.
    const absolutePath = path.resolve(rootDir, file);
    if (!fs.existsSync(absolutePath)) {
      this.options.notify(`Graph-It-Live: ${file} no longer exists; Refresh the flow.`, "error");
      return;
    }
    await this.options.openLocation(absolutePath, line);
    this.lastOpened = { file, line };
  }

  /** Draws the flow again from the index: the same entry symbol, found again in its file. */
  private async refresh({ filePath, symbolName, startLine }: { filePath: string; symbolName: string; startLine: number }): Promise<void> {
    const lang = this.options.callGraph.isFlowSupported({ uri: { fsPath: filePath } });
    const symbols = lang ? await this.options.callGraph.extractFileSymbols(filePath, lang) : undefined;
    if (!symbols) return;
    const distance = (node: CallGraphNode) => Math.abs(node.startLine + 1 - startLine);
    // The symbol moved: the homonym nearest to its old line; gone: buildFlowModel names the closest ones.
    const node = symbols.nodes.filter((candidate) => candidate.name === symbolName).toSorted((a, b) => distance(a) - distance(b))[0]
      ?? ({ id: symbolName, name: symbolName, startLine: startLine - 1 } as CallGraphNode);
    await this.draw(filePath, symbols, node, { inView: true });
  }

  /**
   * Saves the flow (SVG, HTML or Diagram spec, by extension) inside the workspace, or copies its SVG:
   * `renderFlowDiagram` with the drawn request, so the bytes are the CLI's for the same file#symbol and --startLine.
   */
  private async exportDiagram(target: ArchitectureExportTarget): Promise<void> {
    const output = target === "file" ? this.exportOutput : undefined;
    this.exportOutput = undefined;
    const workspaceRoot = this.options.workspaceRoot();
    if (workspaceRoot === undefined) {
      this.options.notify("Graph-It-Live: Open a folder to export the Flow diagram: exports are written inside the workspace.", "info");
      return;
    }
    const { request, rootDir, source } = this.drawn!;
    try {
      const file = target === "file"
        ? await workspaceExportFile(output, workspaceRoot, () => this.options.pickDiagramFile(path.join(workspaceRoot, `${request.symbolName}-flow.svg`)))
        : undefined;
      if (target === "file" && file === undefined) return;
      const format = file === undefined ? "svg" : EXPORT_FORMATS[path.extname(file).toLowerCase()];
      if (format === undefined) throw new Error(`${path.basename(file!)}: save as .svg, .html or .json`);
      const { markup } = await renderFlowDiagram(source.db, { rootDir, extractor: source.extractor }, request, { format, theme: this.options.diagramTheme() });
      if (file === undefined) {
        await this.options.writeClipboard(markup);
        this.options.notify("Flow diagram copied as SVG.", "info");
        return;
      }
      await fs.promises.writeFile(file, markup);
      this.options.notify(`Flow diagram saved to ${path.basename(file)}.`, "info");
    } catch (error) {
      const reason = maskWorkspaceRoot(error instanceof Error ? error.message : String(error), workspaceRoot);
      this.options.notify(`Could not export the Flow diagram: ${reason}`, "error");
    }
  }

  /** Follow cursor on (Flow or Folder tab) or off (pinned, the default); posts the toggle's state. */
  setFollow(enabled: boolean, tab?: DiagramFollowCommand["tab"]): void {
    const changed = this.follow !== enabled;
    this.follow = enabled;
    if (tab === "flow" || tab === "folder") this.followTab = tab;
    if (changed) {
      this.stopFollowing();
      if (enabled) {
        const schedule = (editor: vscode.TextEditor | undefined) => {
          clearTimeout(this.followTimer);
          this.followTimer = setTimeout(() => void this.followEditor(editor), FOLLOW_DEBOUNCE_MS);
        };
        this.followSubscriptions = [
          vscode.window.onDidChangeTextEditorSelection((event) => schedule(event.textEditor)),
          vscode.window.onDidChangeActiveTextEditor(schedule),
        ];
      }
    }
    this.postContext();
  }

  private stopFollowing(): void {
    clearTimeout(this.followTimer);
    this.followTimer = undefined;
    for (const subscription of this.followSubscriptions) subscription.dispose();
    this.followSubscriptions = [];
    this.lastFollowedFolder = undefined;
  }

  /** Follow: the flow of the symbol at the cursor, or the Folder level of the file's directory; every failure is a silent skip. */
  private async followEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!this.follow || !editor) return;
    if (this.followTab === "flow") {
      await this.showAtCursor(editor, { quiet: true });
      return;
    }
    const root = this.options.workspaceRoot();
    if (root === undefined) return;
    const directory = normalizePath(path.relative(root, path.dirname(editor.document.uri.fsPath)));
    if (directory.startsWith("..") || path.isAbsolute(directory) || directory === this.lastFollowedFolder) return;
    this.lastFollowedFolder = directory;
    await this.options.followFolder(directory);
  }

  private postContext(): void {
    this.options.post({ type: "diagramContext", hasWorkspace: this.options.workspaceRoot() !== undefined, follow: this.follow });
  }

  /** The colours follow the editor theme: the last layout drawn again, no re-index (a new requestId). */
  onThemeChanged(): void {
    if (!this.drawn) return;
    this.send({ ...this.drawn.message, svg: renderDiagramSvg(this.drawn.layout, this.options.diagramTheme()) });
  }

  /** A saved file holding a step: the flow is stale (caption badge and Refresh). */
  onFileSaved(filePath: string): void {
    if (!this.drawn || this.drawn.message.stale || !this.drawn.files.has(normalizePath(filePath))) return;
    this.drawn.message = { ...this.drawn.message, stale: true };
    this.send({ type: "flowDiagramState", status: "stale" });
  }

  /** The Architecture mode mounted: the workspace capability and the last flow, posted before it listened. */
  onMounted(): void {
    this.postContext();
    this.repost();
  }

  /** E2E driver: the Flow fields of `e2eArchitectureControls`, checked (any extension can call it). */
  setControls(controls: (Pick<ArchitectureControlsMessage, "tab" | "flowNode" | "flowEdge" | "follow" | "flowRefresh"> & {
    cancelFlow?: boolean;
    exportDiagram?: { target?: unknown; output?: unknown };
  }) | undefined): void {
    const { tab, flowNode, flowEdge, follow, flowRefresh, cancelFlow, exportDiagram } = controls ?? {};
    if (cancelFlow === true) this.cancelForE2E();
    if (exportDiagram?.target === "file") this.exportOutput = typeof exportDiagram.output === "string" ? exportDiagram.output : undefined;
    // Without a folder the Architecture view service is absent: the export is refused here, as the view would.
    if ((exportDiagram?.target === "file" || exportDiagram?.target === "clipboard") && this.options.workspaceRoot() === undefined) {
      void this.exportDiagram(exportDiagram.target);
    }
    const checked = {
      tab: DIAGRAM_TABS.includes(tab as never) ? tab : undefined,
      flowNode: isIndex(flowNode, Number.MAX_SAFE_INTEGER) ? flowNode : undefined,
      flowEdge: isIndex(flowEdge, Number.MAX_SAFE_INTEGER) ? flowEdge : undefined,
      follow: typeof follow === "boolean" ? follow : undefined,
      flowRefresh: flowRefresh === true ? true : undefined,
    };
    if (Object.values(checked).some((value) => value !== undefined)) this.options.post({ type: "architectureControls", ...checked });
  }

  /**
   * E2E only, like `CallGraphViewService.clickCallGraphNodeForE2E`: cancels the running wait, else the next
   * one (a warm index can end a wait before a driver reaches it). True when a wait was running. Not called by product code.
   */
  cancelForE2E(): boolean {
    this.cancelNext = !this.running;
    this.running?.cancel();
    return !this.cancelNext;
  }

  /** E2E observability (getContext `graph-it-live.flowDiagram`). */
  getE2EState() {
    const message = this.drawn?.message;
    return {
      requestId: message?.requestId ?? 0,
      entry: message?.entry,
      nodes: message?.nodes.map((node) => node.name) ?? [],
      edges: message?.edges.map((edge) => edge.name) ?? [],
      stale: message?.stale ?? false,
      follow: this.follow,
      state: this.lastState?.status,
      lastError: this.lastError,
      lastOpened: this.lastOpened,
      /** SHA-256 of the drawn SVG: compared with the CLI's output for the same theme. */
      svgDigest: message && createHash("sha256").update(message.svg).digest("hex"),
      view: this.shown,
    };
  }

  dispose(): void {
    this.stopFollowing();
    this.running?.cancel();
  }
}
