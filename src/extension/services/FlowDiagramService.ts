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
import type { SequenceLayout } from "@/analyzer/diagram/sequenceDiagram";
import type { SequenceModel } from "@/analyzer/diagram/sequenceModel";
import { renderFlowDiagram, renderSequenceDiagram } from "@/analyzer/diagram/workspaceDiagram";
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
  type FlowDrawCandidateCommand,
  type FlowDrawAtCursorCommand,
  type FlowShowCallGraphCommand,
  type SymbolDiagramView,
} from "@/shared/architecture-types";
import { normalizePath } from "@/shared/path";
import { maskWorkspaceRoot, workspaceExportFile } from "./ArchitectureViewService";
import type { CallGraphViewService, FileSymbols } from "./CallGraphViewService";
import { symbolAtLine } from "./CallGraphViewService";

/** Follow cursor waits this long after the last selection or editor change. */
export const FOLLOW_DEBOUNCE_MS = 300;
const SUPPORTED = "Supported: TypeScript, JavaScript, Vue, Svelte, Python, Rust, C#, Go, Java, GraphQL.";
const EXPORT_FORMATS: Readonly<Record<string, "svg" | "html" | "diagram-spec" | "mermaid">> = {
  ".svg": "svg", ".html": "html", ".htm": "html", ".json": "diagram-spec", ".mmd": "mermaid", ".mermaid": "mermaid",
};
/** The tab name in messages: "Flow diagram", "Sequence diagram". */
const VIEW_NAMES: Record<SymbolDiagramView, string> = { flow: "Flow", sequence: "Sequence" };

/** The CLI palette of an editor theme: high contrast draws dark, high contrast light draws light (export parity). */
export function diagramThemeFor(kind: vscode.ColorThemeKind): DiagramTheme {
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? "dark" : "light";
}

export type FlowWebviewCommand =
  | FlowDrawCandidateCommand
  | FlowDrawAtCursorCommand
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

/** The last flow or sequence drawn: what export, refresh, open and the theme re-render read; never a path from the webview. */
interface DrawnFlow {
  request: FlowModelRequest;
  rootDir: string;
  layout: FlowLayout | SequenceLayout;
  message: FlowDiagramMessage;
  /** Normalized absolute files of the steps: a save of one marks the flow stale. */
  files: Set<string>;
  source: { db: Parameters<typeof renderFlowDiagram>[0]; extractor: Parameters<typeof renderFlowDiagram>[1]["extractor"] };
}

/** Where a draw comes from: a command (progress notification) or the view itself (Follow, Refresh, breadcrumb). */
interface DrawOrigin {
  /** The view to draw: set on the service only once the draw starts, so an early exit leaves the drawn view alone. */
  view: SymbolDiagramView;
  quiet?: boolean;
  inView?: boolean;
  expectActiveFile?: string;
}

/** Most symbols an empty state offers: a file of many functions lists the first ones that make calls. */
const MAX_CANDIDATES = 8;

/** Calls and references each symbol of a file makes, by node id: what tells an entry that draws something from one that draws nothing. */
function callCounts(symbols: FileSymbols): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of symbols.edges) {
    if (edge.typeRelation === "CALLS" || edge.typeRelation === "REFERENCES") counts.set(edge.sourceId, (counts.get(edge.sourceId) ?? 0) + 1);
  }
  return counts;
}

function callsText(count: number): string {
  if (count === 0) return "no calls";
  return count === 1 ? "1 call" : `${count} calls`;
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

/**
 * The lifelines and messages of a sequence as the Flow tab's overlay buttons: `layout.lifelines[i]` is `model.participants[i]`,
 * `layout.messages[j]` is `model.messages[j]`. A lifeline opens its class (or its file), a message its call site.
 */
export function sequenceGeometry(model: SequenceModel, layout: SequenceLayout): { nodes: FlowDiagramNode[]; edges: FlowDiagramEdge[] } {
  if (layout.lifelines.length !== model.participants.length || layout.messages.length !== model.messages.length) {
    throw new Error("internal error: the sequence layout does not match its model");
  }
  const total = model.participants.length;
  const titles = new Map(model.participants.map((participant) => [participant.id, participant.title]));
  const nodes = model.participants.map(({ id, title, file, line = 1 }, index): FlowDiagramNode => {
    const { x, y, width, height } = layout.lifelines[index];
    return { id, title, file, line, lane: "main", name: `Lifeline ${index + 1} of ${total}: ${title}, ${file}:${line}`, x, y, width, height };
  });
  const edges = layout.messages.map(({ message, kind, label }): FlowDiagramEdge => {
    const { from, to, name, file, line, relation } = model.messages[message];
    const lane = kind === "catch-call" ? "error" : "main";
    return { from, to, file, line, relation, lane, name: `Call ${titles.get(from) ?? from} → ${name} at ${file}:${line}${lane === "error" ? ", in a catch" : ""}`, label: { x: label.x, y: label.y, text: label.text } };
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
  /** The tab the entry is drawn on: a Flow or Sequence tab click draws it again as that view. */
  private view: SymbolDiagramView = "flow";
  private followSubscriptions: vscode.Disposable[] = [];
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFollowedFolder: string | undefined;
  private running: vscode.CancellationTokenSource | undefined;
  /** cancelForE2E ran with no wait running: the next draw starts cancelled. */
  private cancelNext = false;
  private exportOutput: string | undefined;
  private lastError: string | undefined;
  private lastOpened: { file: string; line: number } | undefined;
  /** The symbols the empty state offers (index = the view's candidate index), with the file they come from. */
  private candidates: { filePath: string; symbols: FileSymbols; nodes: CallGraphNode[] } | null = null;
  /** What the view last reported it shows (E2E observability only). */
  private shown: DiagramShownCommand | undefined;

  constructor(private readonly options: FlowDiagramServiceOptions) {}

  /**
   * Show Flow Diagram, or Show Diagram… sequence: the symbol at the cursor, else a pick of the file's symbols.
   * False when nothing was drawn (mode unchanged). Follow (quiet) keeps the view drawn.
   */
  async showAtCursor(editor: vscode.TextEditor | undefined, options: { quiet?: boolean; view?: SymbolDiagramView } = {}): Promise<boolean> {
    const { quiet } = options;
    if (!quiet) this.setFollow(false);
    // Follow keeps the view drawn; a command names its own.
    const view = options.view ?? this.view;
    const lang = quiet ? editor && this.options.callGraph.isFlowSupported(editor.document) : this.options.callGraph.activeSourceEditor("Flow Diagram", editor)?.lang;
    if (!editor || !lang) return false;
    const filePath = normalizePath(editor.document.uri.fsPath);
    const symbols = await this.options.callGraph.extractFileSymbols(filePath, lang, { quiet });
    if (!symbols) return false;
    const atCursor = symbolAtLine(symbols.nodes, editor.selection.active.line);
    // Follow: between symbols, or on the flow already drawn, nothing changes.
    if (quiet && (!atCursor || this.entry?.key === `${filePath}#${atCursor.id}`)) return false;
    const node = atCursor ?? (await this.pickSymbol(filePath, symbols, view));
    if (!node) return false;
    return this.draw(filePath, symbols, node, { view, quiet, inView: quiet, expectActiveFile: filePath });
  }

  /** Explorer, Show Diagram… or a file crumb: a pick of the file's symbols. */
  async showForFile(uri: vscode.Uri, options: { inView?: boolean; view?: SymbolDiagramView } = {}): Promise<boolean> {
    this.setFollow(false);
    const view = options.view ?? this.view;
    const filePath = normalizePath(uri.fsPath);
    const lang = this.options.callGraph.isFlowSupported({ uri });
    if (!lang) {
      this.options.notify(`Graph-It-Live: ${VIEW_NAMES[view]} Diagram is not supported for "${path.extname(filePath) || path.basename(filePath)}". ${SUPPORTED}`, "info");
      return false;
    }
    const symbols = await this.options.callGraph.extractFileSymbols(filePath, lang);
    if (!symbols) return false;
    const node = await this.pickSymbol(filePath, symbols, view);
    return node ? this.draw(filePath, symbols, node, { view, inView: options.inView }) : false;
  }

  /** A Flow or Sequence tab with nothing drawn: the symbol at the cursor in that view, else the tab says why and what to do (#825). */
  private async drawAtCursor(requested: unknown): Promise<void> {
    // From the webview: anything but sequence draws a flow.
    const view: SymbolDiagramView = requested === "sequence" ? "sequence" : "flow";
    const refusal = await this.drawAtCursorOrRefuse(view);
    // The tab shows its Draw symbol at cursor button after the message: the retry.
    if (refusal) this.send({ type: "flowDiagramState", status: "error", message: refusal, view });
  }

  /** Draws as Show Flow Diagram does (a pick of the file's symbols between them), or returns why it cannot. */
  private async drawAtCursorOrRefuse(view: SymbolDiagramView): Promise<string | undefined> {
    // A tab click is not a command: Follow cursor stays as the user set it.
    // A webview view keeps the last focused editor active.
    const editor = vscode.window.activeTextEditor;
    if (!editor) return "No active editor: open a source file and put the cursor in a function.";
    const filePath = normalizePath(editor.document.uri.fsPath);
    const lang = this.options.callGraph.isFlowSupported(editor.document);
    if (!lang) return `${VIEW_NAMES[view]} Diagram is not supported for "${path.extname(filePath) || path.basename(filePath)}". ${SUPPORTED} Open one of these files.`;
    // The tab spins while the file is read; the draw announces its own loading state.
    this.send({ type: "flowDiagramState", status: "loading", view });
    const symbols = await this.options.callGraph.extractFileSymbols(filePath, lang, { quiet: true });
    if (!symbols) return "The call graph is re-indexing: wait until it finishes.";
    const relative = vscode.workspace.asRelativePath(filePath);
    if (symbols.nodes.length === 0) return `${relative} has no symbol to draw a ${view} from: open a file with a function.`;
    const node = symbolAtLine(symbols.nodes, editor.selection.active.line) ?? (await this.pickSymbol(filePath, symbols, view));
    if (!node) return `No symbol picked: put the cursor in a function of ${relative}.`;
    await this.draw(filePath, symbols, node, { view, inView: true });
    return undefined;
  }

  /** The symbol the user picks; a file without symbols is told. Escape: undefined, silently. */
  private async pickSymbol(filePath: string, { nodes, ...symbols }: FileSymbols, view: SymbolDiagramView): Promise<CallGraphNode | undefined> {
    const relative = vscode.workspace.asRelativePath(filePath);
    if (nodes.length === 0) {
      this.options.notify(`Graph-It-Live: ${relative} has no symbol to draw a ${view} from.`, "info");
      return undefined;
    }
    // The calls each symbol makes: one with none draws an empty diagram.
    const counts = callCounts({ nodes, ...symbols });
    const picked = await vscode.window.showQuickPick(
      nodes.map((node) => ({ label: node.name, description: `line ${node.startLine + 1} · ${callsText(counts.get(node.id) ?? 0)}`, node })),
      { placeHolder: `Pick the symbol of ${relative} to draw its ${view}` },
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
    const previousView = this.view;
    this.view = origin.view;
    this.entry = { filePath, symbolName: node.name, startLine: node.startLine + 1, key: `${filePath}#${node.id}` };
    const crumbs = flowCrumbs(symbols.rootDir, filePath, node.name);
    // The view switches to the Flow tab on it; a cancelled or abandoned draw tells it to go back.
    this.send({ type: "flowDiagramState", status: "loading", crumbs });
    const run = async () => {
      const drawn = await this.render(drawId, request, symbols, crumbs, origin, source.token);
      if (drawn === undefined) {
        this.entry = previousEntry;
        this.view = previousView;
      }
      return drawn === true;
    };
    try {
      if (origin.quiet || origin.inView) return await run();
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Graph-It-Live: drawing the ${this.view} diagram…`, cancellable: true },
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
      const source = { db: indexed.db, extractor: indexed.extractor };
      const drawing = await this.drawing(source, rootDir, request);
      if (token.isCancellationRequested || drawId !== this.drawCount) return abandon();
      if (drawing.geometry.edges.length === 0) {
        this.drawn = null;
        // The file's symbols that make calls, the entry aside: what the user can draw instead.
        const counts = callCounts(symbols);
        const nodes = symbols.nodes.filter((node) => node.name !== request.symbolName && (counts.get(node.id) ?? 0) > 0).slice(0, MAX_CANDIDATES);
        this.candidates = { filePath: request.filePath, symbols, nodes };
        const candidates = nodes.map((node) => ({ name: node.name, line: node.startLine + 1, calls: counts.get(node.id) ?? 0 }));
        this.send({ type: "flowDiagramState", status: "empty", message: request.symbolName, crumbs, candidates });
        return true;
      }
      this.candidates = null;
      const { layout, entry, geometry, files } = drawing;
      const message: FlowDiagramMessage = {
        type: "flowDiagram", view: this.view, requestId: 0, svg: drawing.markup, width: layout.width, height: layout.height,
        title: layout.text.title, caption: layout.text.caption, counts: layout.text.counts,
        crumbs, entry, ...geometry, stale: false,
      };
      this.drawn = { request, rootDir, layout, message, files: new Set(files.map((file) => normalizePath(path.resolve(rootDir, file)))), source };
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

  /** The entry drawn as the current view: its SVG, layout, overlay geometry and the workspace-relative files it shows. */
  private async drawing(source: DrawnFlow["source"], rootDir: string, request: FlowModelRequest) {
    const options = { format: "svg", theme: this.options.diagramTheme() } as const;
    if (this.view === "sequence") {
      const { markup, layout, model } = await renderSequenceDiagram(source.db, { rootDir, extractor: source.extractor }, request, options);
      const files = [...model.participants.map((participant) => participant.file), ...model.messages.map((item) => item.file)];
      return { markup, layout, entry: model.entry, geometry: sequenceGeometry(model, layout), files };
    }
    const { markup, layout, model } = await renderFlowDiagram(source.db, { rootDir, extractor: source.extractor }, request, options);
    return { markup, layout, entry: model.entry, geometry: flowGeometry(model, layout), files: model.nodes.map((step) => step.file) };
  }

  /** Posts a flow or a state under a new requestId, the one the view's next commands echo; keeps it for a remount. */
  private send(message: FlowDiagramMessage | (Omit<FlowDiagramStateMessage, "requestId" | "view"> & { view?: SymbolDiagramView })): void {
    this.current = ++this.requestCount;
    if (message.type === "flowDiagram") {
      this.drawn!.message = { ...message, requestId: this.current };
      this.options.post(this.drawn!.message);
      return;
    }
    // A state is about the view of the draw it reports, unless it names the drawn one (stale, a replay).
    const state = { ...message, view: message.view ?? this.view, requestId: this.current };
    // A cancel replays the flow the view already had: nothing new for it to take the tab with.
    if (state.status === "loading" || state.status === "cancelled") this.unseen = state.status === "loading";
    // A loading or cancelled state is never replayed: the draw it announces posts its own outcome.
    if (state.status !== "loading" && state.status !== "cancelled") this.lastState = state;
    this.options.post(state);
  }

  /** The last flow and its state again (after a mount, or to end a loading state the draw abandoned). */
  private repost(): void {
    const crumbs = this.lastState?.crumbs ?? this.drawn?.message.crumbs;
    if (this.unseen && (this.drawn || this.lastState)) {
      this.send({ type: "flowDiagramState", status: "loading", crumbs, view: this.lastState?.view ?? this.drawn?.message.view });
    }
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
        if (message.tabs?.some((tab) => (tab.tab === "flow" || tab.tab === "sequence") && tab.selected)) this.unseen = false;
        return Promise.resolve();
      case "flowOpenLocation":
        return this.isCurrent(message.requestId) ? this.openLocation(message.target) : Promise.resolve();
      case "flowExportDiagram":
        return this.isCurrent(message.requestId) ? this.exportDiagram(message.target) : Promise.resolve();
      case "flowRefresh":
        if (!this.entry || !this.isLatest(message.requestId)) return Promise.resolve();
        return this.refresh(this.entry, message.view ?? this.view);
      case "flowDrawCandidate": {
        const node = this.candidates?.nodes[message.index];
        if (!this.candidates || !node || !isIndex(message.index, this.candidates.nodes.length) || !this.isLatest(message.requestId)) return Promise.resolve();
        return this.draw(this.candidates.filePath, this.candidates.symbols, node, { view: this.view, inView: true }).then(() => undefined);
      }
      case "flowDrawAtCursor":
        return this.drawAtCursor(message.view);
      case "flowShowCallGraph":
        return this.entry && this.isLatest(message.requestId) ? this.options.showCallGraphAt(this.entry.filePath, this.entry.startLine) : Promise.resolve();
    }
  }

  /** A request about the flow the view shows (its message or its last state); an older one is ignored. */
  private isCurrent(requestId: unknown): boolean {
    return this.drawn !== null && this.isLatest(requestId);
  }

  /** The id of the last message posted, or of the flow drawn (the view echoes either). */
  private isLatest(requestId: unknown): boolean {
    return requestId === this.current || (this.drawn !== null && requestId === this.drawn.message.requestId);
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
      this.options.notify(`Graph-It-Live: ${file} no longer exists; Refresh the ${message.view}.`, "error");
      return;
    }
    await this.options.openLocation(absolutePath, line);
    this.lastOpened = { file, line };
  }

  /** Draws the flow again from the index: the same entry symbol, found again in its file. */
  private async refresh({ filePath, symbolName, startLine }: { filePath: string; symbolName: string; startLine: number }, view: SymbolDiagramView): Promise<void> {
    const lang = this.options.callGraph.isFlowSupported({ uri: { fsPath: filePath } });
    const symbols = lang ? await this.options.callGraph.extractFileSymbols(filePath, lang) : undefined;
    if (!symbols) return;
    const distance = (node: CallGraphNode) => Math.abs(node.startLine + 1 - startLine);
    // The symbol moved: the homonym nearest to its old line; gone: buildFlowModel names the closest ones.
    const node = symbols.nodes.filter((candidate) => candidate.name === symbolName).toSorted((a, b) => distance(a) - distance(b))[0]
      ?? ({ id: symbolName, name: symbolName, startLine: startLine - 1 } as CallGraphNode);
    await this.draw(filePath, symbols, node, { view, inView: true });
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
      this.options.notify(`Graph-It-Live: Open a folder to export the ${VIEW_NAMES[this.drawn?.message.view ?? this.view]} diagram: exports are written inside the workspace.`, "info");
      return;
    }
    const { request, rootDir, source, message } = this.drawn!;
    const name = VIEW_NAMES[message.view];
    try {
      const file = target === "file"
        ? await workspaceExportFile(output, workspaceRoot, () => this.options.pickDiagramFile(path.join(workspaceRoot, `${request.symbolName}-${message.view}.svg`)))
        : undefined;
      if (target === "file" && file === undefined) return;
      const format = file === undefined ? "svg" : EXPORT_FORMATS[path.extname(file).toLowerCase()];
      // Mermaid is a sequence's only: a flow file named .mmd is refused by the renderer with the CLI's message.
      if (format === undefined) throw new Error(`${path.basename(file!)}: save as .svg, .html or .json${message.view === "sequence" ? ", or .mmd for Mermaid" : ""}`);
      const options = { format, theme: this.options.diagramTheme() };
      const sources = { rootDir, extractor: source.extractor };
      const { markup } = message.view === "sequence"
        ? await renderSequenceDiagram(source.db, sources, request, options)
        : await renderFlowDiagram(source.db, sources, request, options);
      if (file === undefined) {
        await this.options.writeClipboard(markup);
        this.options.notify(`${name} diagram copied as SVG.`, "info");
        return;
      }
      await fs.promises.writeFile(file, markup);
      this.options.notify(`${name} diagram saved to ${path.basename(file)}.`, "info");
    } catch (error) {
      const reason = maskWorkspaceRoot(error instanceof Error ? error.message : String(error), workspaceRoot);
      this.options.notify(`Could not export the ${name} diagram: ${reason}`, "error");
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
    // A folder that could not be drawn is forgotten, so the next move inside it tries again.
    if (!(await this.options.followFolder(directory)) && this.lastFollowedFolder === directory) this.lastFollowedFolder = undefined;
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
    this.send({ type: "flowDiagramState", status: "stale", view: this.drawn.message.view });
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
      /** The tab the drawn entry is on. */
      drawnView: message?.view,
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
