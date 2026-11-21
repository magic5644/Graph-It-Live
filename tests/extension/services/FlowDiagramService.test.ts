import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const vs = vi.hoisted(() => ({
  root: "",
  quickPick: vi.fn(),
  withProgress: vi.fn(),
  listeners: { selection: new Set<(event: unknown) => void>(), active: new Set<(editor: unknown) => void>() },
}));

vi.mock("vscode", () => {
  class CancellationTokenSource {
    private readonly listeners: (() => void)[] = [];
    token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
      },
    };
    cancel() {
      this.token.isCancellationRequested = true;
      for (const listener of this.listeners) listener();
    }
    dispose() {}
  }
  const subscribe = <T>(set: Set<T>) => (listener: T) => {
    set.add(listener);
    return { dispose: () => set.delete(listener) };
  };
  return {
    CancellationTokenSource,
    ProgressLocation: { Notification: 15 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    window: {
      showQuickPick: vs.quickPick,
      withProgress: vs.withProgress,
      onDidChangeTextEditorSelection: subscribe(vs.listeners.selection),
      onDidChangeActiveTextEditor: subscribe(vs.listeners.active),
    },
    workspace: { asRelativePath: (filePath: string) => path.relative(vs.root, filePath).replaceAll("\\", "/") },
  };
});

import * as vscode from "vscode";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { fileExtToLang, GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import type { FlowLayout } from "@/analyzer/diagram/flowDiagram";
import type { FlowModel } from "@/analyzer/diagram/flowModel";
import { renderFlowDiagram } from "@/analyzer/diagram/workspaceDiagram";
import { readFlowOptions } from "@/cli/commands/diagram";
import { diagramThemeFor, flowGeometry, FlowDiagramService, FOLLOW_DEBOUNCE_MS, type FlowDiagramServiceOptions } from "@/extension/services/FlowDiagramService";
import type { ArchitectureExtensionMessage, FlowDiagramMessage, FlowDiagramStateMessage } from "@/shared/architecture-types";
import type { SupportedLang } from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";

const ORDER = [
  'import { save } from "./store";',
  "export function placeOrder(id: string) {",
  "  validate(id);",
  "  return save(id);",
  "}",
  "function validate(id: string) {",
  '  if (!id) throw new Error("no id");',
  "}",
  "export function lonely() {",
  "  return 1;",
  "}",
  "",
].join("\n");
const FILES: Record<string, string> = {
  "src/order.ts": ORDER,
  "src/store.ts": "export function save(id: string) {\n  return id;\n}\n",
  "loose/app/main.ts": 'import { helper } from "../lib/x";\nexport function main() {\n  return helper();\n}\n',
  "loose/lib/x.ts": "export function helper() {\n  return 2;\n}\n",
};

let root: string;
let extractor: GraphExtractor;
let indexer: CallGraphIndexer;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-flow-service-")));
  vs.root = root;
  for (const dir of ["dist/wasm", "dist/queries"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(root, "dist/wasm/tree-sitter.wasm"));
  for (const grammar of ["typescript", "tsx"]) {
    await fs.copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`, path.join(root, `dist/wasm/tree-sitter-${grammar}.wasm`));
    await fs.copyFile(`resources/queries/${grammar}.scm`, path.join(root, `dist/queries/${grammar}.scm`));
  }
  extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });
  indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  await indexer.init();
  // Every file first: an import resolves to a file on disk.
  for (const [name, source] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), source);
  }
  for (const [name, source] of Object.entries(FILES)) {
    const file = normalizePath(path.join(root, name));
    const lang = fileExtToLang(file) as SupportedLang;
    const result = await extractor.extractSource(file, lang, source);
    indexer.indexFile(result.nodes, result.edges, file, lang, 1);
  }
  indexer.resolveExternalEdges();
}, 60_000);

afterAll(async () => {
  extractor.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

const ORDER_FILE = () => normalizePath(path.join(root, "src/order.ts"));
const editorAt = (relative: string, line: number) =>
  ({ document: { uri: { fsPath: path.join(root, relative) }, languageId: "typescript" }, selection: { active: { line } } }) as unknown as vscode.TextEditor;

describe("FlowDiagramService", () => {
  let posted: ArchitectureExtensionMessage[];
  let notices: { message: string; level: string }[];
  let opened: { file: string; line: number }[];
  let workspace: string | undefined;
  let rootDir: string;
  let callGraph: FlowDiagramServiceOptions["callGraph"] & Record<string, ReturnType<typeof vi.fn>>;

  const flows = () => posted.filter((message): message is FlowDiagramMessage => message.type === "flowDiagram");
  const states = () => posted.filter((message): message is FlowDiagramStateMessage => message.type === "flowDiagramState");
  const create = (overrides: Partial<FlowDiagramServiceOptions> = {}) =>
    new FlowDiagramService({
      callGraph,
      post: (message) => posted.push(message),
      workspaceRoot: () => workspace,
      diagramTheme: () => "light",
      notify: (message, level) => notices.push({ message, level }),
      pickDiagramFile: async () => undefined,
      writeClipboard: async () => {},
      openLocation: async (file, line) => {
        opened.push({ file, line });
      },
      showCallGraphAt: vi.fn(async () => {}),
      followFolder: vi.fn(async () => true),
      ...overrides,
    });

  beforeEach(() => {
    posted = [];
    notices = [];
    opened = [];
    workspace = root;
    rootDir = root;
    vs.quickPick.mockReset();
    vs.withProgress.mockReset();
    vs.withProgress.mockImplementation((_options, task) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }));
    callGraph = {
      activeSourceEditor: vi.fn((_feature: string, editor?: vscode.TextEditor) => (editor ? { editor, lang: "typescript" } : undefined)),
      isFlowSupported: vi.fn((document: { uri: { fsPath: string } }) => (document.uri.fsPath.endsWith(".ts") ? "typescript" : null)),
      extractFileSymbols: vi.fn(async (filePath: string, lang: SupportedLang) => {
        const { nodes, edges } = await extractor.extractFile(filePath, lang);
        return { nodes, edges, rootDir };
      }),
      indexForFlow: vi.fn(async () => ({ db: indexer.getDb(), extractor })),
    } as never;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws the flow at the cursor under one progress notification: CLI SVG, boxes and accessible names", async () => {
    const service = create();
    expect(await service.showAtCursor(editorAt("src/order.ts", 2))).toBe(true);
    expect(vs.withProgress).toHaveBeenCalledOnce();
    expect(vs.withProgress.mock.calls[0][0]).toMatchObject({ title: "Graph-It-Live: drawing the flow diagram…", cancellable: true });
    expect(callGraph.activeSourceEditor).toHaveBeenCalledWith("Flow Diagram", expect.anything());
    expect(states()[0]).toMatchObject({ status: "loading" });
    const [flow] = flows();
    expect(flow.svg).toMatch(/^<svg /);
    expect(flow.requestId).toBeGreaterThan(states()[0].requestId);
    expect(flow.entry).toContain("placeOrder");
    expect(flow.crumbs.map((crumb) => [crumb.kind, crumb.label, crumb.key])).toEqual([
      ["workspace", path.basename(root), undefined],
      ["folder", "src", "src"],
      ["file", "order.ts", "src/order.ts"],
      ["symbol", "placeOrder", "src/order.ts#placeOrder"],
    ]);
    expect(flow.nodes.length).toBeGreaterThanOrEqual(2);
    expect(flow.nodes[0].name).toMatch(/^Step 1 of \d+: placeOrder, src\/order\.ts:2, main lane$/);
    expect(flow.edges.length).toBeGreaterThan(0);
    for (const edge of flow.edges) expect(edge.name).toMatch(/^Call .+ → .+ at src\/order\.ts:\d+, \w+ lane$/);
    expect([flow.title, flow.caption, flow.counts].every((text) => text.length > 0)).toBe(true);
    expect(service.getE2EState()).toMatchObject({ requestId: flow.requestId, entry: flow.entry, stale: false, follow: false, nodes: flow.nodes.map((node) => node.name) });
  });

  it("asks for the symbol between symbols; Escape draws nothing", async () => {
    const service = create();
    vs.quickPick.mockResolvedValueOnce(undefined);
    expect(await service.showAtCursor(editorAt("src/order.ts", 11))).toBe(false);
    expect(vs.quickPick.mock.calls[0][1]).toEqual({ placeHolder: "Pick the symbol of src/order.ts to draw its flow" });
    expect(vs.quickPick.mock.calls[0][0].map((item: { label: string }) => item.label)).toEqual(expect.arrayContaining(["placeOrder", "lonely"]));
    expect(flows()).toHaveLength(0);
    expect(vs.withProgress).not.toHaveBeenCalled();
    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "placeOrder"));
    expect(await service.showAtCursor(editorAt("src/order.ts", 11))).toBe(true);
    expect(flows()).toHaveLength(1);
  });

  it("refuses without an editor, an unsupported file, a file without symbols, or while re-indexing", async () => {
    const service = create();
    expect(await service.showAtCursor(undefined)).toBe(false);
    expect(await service.showForFile(vscode.Uri.file(path.join(root, "README.md")))).toBe(false);
    expect(notices.at(-1)?.message).toBe('Graph-It-Live: Flow Diagram is not supported for ".md". Supported: TypeScript, JavaScript, Vue, Svelte, Python, Rust, C#, Go, Java, GraphQL.');
    callGraph.extractFileSymbols.mockResolvedValueOnce({ nodes: [], edges: [], rootDir: root });
    expect(await service.showForFile(vscode.Uri.file(path.join(root, "src/empty.ts")))).toBe(false);
    expect(notices.at(-1)?.message).toBe("Graph-It-Live: src/empty.ts has no symbol to draw a flow from.");
    callGraph.extractFileSymbols.mockResolvedValueOnce(undefined);
    expect(await service.showAtCursor(editorAt("src/order.ts", 2))).toBe(false);
    expect(notices).toHaveLength(2);
    expect(posted.filter((message) => message.type !== "diagramContext")).toEqual([]);
  });

  it("shows the empty state for a symbol that calls nothing", async () => {
    const service = create();
    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "lonely"));
    expect(await service.showForFile(vscode.Uri.file(ORDER_FILE()))).toBe(true);
    expect(states().at(-1)).toMatchObject({ status: "empty", message: "lonely" });
    expect(service.getE2EState()).toMatchObject({ state: "empty", requestId: 0 });
    // Show call graph echoes the empty state's requestId.
    const showCallGraphAt = vi.fn(async () => {});
    const other = create({ showCallGraphAt });
    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "lonely"));
    await other.showForFile(vscode.Uri.file(ORDER_FILE()));
    await other.handleWebviewMessage({ command: "flowShowCallGraph", requestId: 0 });
    expect(showCallGraphAt).not.toHaveBeenCalled();
    await other.handleWebviewMessage({ command: "flowShowCallGraph", requestId: states().at(-1)!.requestId });
    expect(showCallGraphAt).toHaveBeenCalledWith(ORDER_FILE(), 9);
  });

  it("says once why an unknown symbol draws nothing, root masked, and keeps the previous flow", async () => {
    const service = create();
    await service.showAtCursor(editorAt("src/order.ts", 2));
    const before = service.getE2EState();
    vs.quickPick.mockResolvedValueOnce({ node: { id: "ghost", name: "ghost", startLine: 40, endLine: 41 } });
    expect(await service.showForFile(vscode.Uri.file(ORDER_FILE()))).toBe(false);
    const errors = notices.filter((notice) => notice.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/^Graph-It-Live: .*ghost/);
    expect(errors[0].message).not.toContain(root);
    expect(states().at(-1)).toMatchObject({ status: "error", message: errors[0].message.slice("Graph-It-Live: ".length) });
    expect(service.getE2EState()).toMatchObject({ requestId: before.requestId, entry: before.entry, state: "error", lastError: expect.stringContaining("ghost") });
  });

  it("stays silent in Follow: no toast on an error, nothing between symbols or on the flow drawn", async () => {
    const service = create();
    await service.showAtCursor(editorAt("src/order.ts", 2));
    expect(await service.showAtCursor(editorAt("src/order.ts", 3), { quiet: true })).toBe(false);
    expect(await service.showAtCursor(editorAt("src/order.ts", 11), { quiet: true })).toBe(false);
    expect(await service.showAtCursor(undefined, { quiet: true })).toBe(false);
    expect(callGraph.indexForFlow).toHaveBeenCalledOnce();
    expect(vs.quickPick).not.toHaveBeenCalled();
    callGraph.indexForFlow.mockRejectedValueOnce(new Error("walk failed"));
    expect(await service.showAtCursor(editorAt("src/order.ts", 6), { quiet: true })).toBe(false);
    expect(notices).toEqual([]);
    expect(vs.withProgress).toHaveBeenCalledOnce();
  });

  it("keeps the previous flow on cancel, posts it again, and says nothing", async () => {
    const service = create();
    await service.showAtCursor(editorAt("src/order.ts", 2));
    const before = service.getE2EState();
    expect(service.cancelForE2E()).toBe(false);
    callGraph.indexForFlow.mockImplementationOnce(({ filePath: _ }: unknown, { token }: { token: vscode.CancellationToken }) =>
      new Promise((resolve) => token.onCancellationRequested(() => resolve(undefined))));
    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "lonely"));
    const drawing = service.showForFile(vscode.Uri.file(ORDER_FILE()));
    await vi.waitFor(() => expect(callGraph.indexForFlow).toHaveBeenCalledTimes(2));
    expect(service.cancelForE2E()).toBe(true);
    expect(await drawing).toBe(false);
    expect(notices).toEqual([]);
    expect(service.getE2EState()).toMatchObject({ entry: before.entry, nodes: before.nodes });
    expect(flows().at(-1)).toMatchObject({ entry: before.entry });
    expect(flows().at(-1)!.requestId).toBeGreaterThan(before.requestId);
  });

  it("cancels the wait from the progress notification", async () => {
    const service = create();
    vs.withProgress.mockImplementationOnce((_options, task) => {
      const listeners: (() => void)[] = [];
      const result = task({}, { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => listeners.push(listener) });
      for (const listener of listeners) listener();
      return result;
    });
    callGraph.indexForFlow.mockImplementationOnce(async (_step: unknown, { token }: { token: vscode.CancellationToken }) => (token.isCancellationRequested ? undefined : { db: indexer.getDb(), extractor }));
    expect(await service.showAtCursor(editorAt("src/order.ts", 2))).toBe(false);
    expect(flows()).toHaveLength(0);
  });

  it("abandons a draw a newer one superseded", async () => {
    const service = create();
    let release = () => {};
    callGraph.indexForFlow.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ db: indexer.getDb(), extractor });
    }));
    const older = service.showAtCursor(editorAt("src/order.ts", 2));
    await vi.waitFor(() => expect(callGraph.indexForFlow).toHaveBeenCalledOnce());
    vs.quickPick.mockImplementationOnce(async (items: { label: string }[]) => items.find((item) => item.label === "lonely"));
    expect(await service.showForFile(vscode.Uri.file(ORDER_FILE()))).toBe(true);
    release();
    expect(await older).toBe(false);
    expect(flows()).toHaveLength(0);
    expect(states().at(-1)).toMatchObject({ status: "empty" });
  });

  it("opens a step or a call site by index only, refusing bad indexes, old requests and deleted files", async () => {
    const service = create();
    await service.showAtCursor(editorAt("src/order.ts", 2));
    const flow = flows()[0];
    const open = (kind: "node" | "edge", index: number, requestId = flow.requestId) =>
      service.handleWebviewMessage({ command: "flowOpenLocation", requestId, target: { kind, index } });
    await open("node", 0);
    expect(opened).toEqual([{ file: path.resolve(root, "src/order.ts"), line: 2 }]);
    await open("edge", 0);
    expect(opened[1]).toEqual({ file: path.resolve(root, flow.edges[0].file), line: flow.edges[0].line });
    for (const index of [-1, 99, 1.5]) await open("node", index);
    await open("node", 0, flow.requestId - 1);
    await service.handleWebviewMessage({ command: "flowOpenLocation", requestId: flow.requestId, target: null as never });
    expect(opened).toHaveLength(2);
    expect(service.getE2EState().lastOpened).toEqual({ file: flow.edges[0].file, line: flow.edges[0].line });

    const store = flow.nodes.findIndex((node) => node.file === "src/store.ts");
    await fs.rename(path.join(root, "src/store.ts"), path.join(root, "src/store.bak"));
    try {
      await open("node", store);
    } finally {
      await fs.rename(path.join(root, "src/store.bak"), path.join(root, "src/store.ts"));
    }
    expect(notices).toEqual([{ message: "Graph-It-Live: src/store.ts no longer exists; Refresh the flow.", level: "error" }]);
    expect(opened).toHaveLength(2);
  });

  it("opens the ../ call site of a loose file drawn against its own folder", async () => {
    workspace = undefined;
    rootDir = normalizePath(path.join(root, "loose/app"));
    const service = create();
    expect(await service.showAtCursor(editorAt("loose/app/main.ts", 2))).toBe(true);
    const flow = flows()[0];
    const helper = flow.nodes.findIndex((node) => node.file === "../lib/x.ts");
    expect(helper).toBeGreaterThan(0);
    await service.handleWebviewMessage({ command: "flowOpenLocation", requestId: flow.requestId, target: { kind: "node", index: helper } });
    expect(opened).toEqual([{ file: path.join(root, "loose/lib/x.ts"), line: 1 }]);
    // Without a folder, an export is refused: exports are written inside the workspace.
    await service.handleWebviewMessage({ command: "flowExportDiagram", requestId: flow.requestId, target: "file" });
    service.setControls({ exportDiagram: { target: "clipboard" } });
    expect(notices.map((notice) => notice.message)).toEqual([
      "Graph-It-Live: Open a folder to export the Flow diagram: exports are written inside the workspace.",
      "Graph-It-Live: Open a folder to export the Flow diagram: exports are written inside the workspace.",
    ]);
  });

  it.each([
    ["Light", 1, "light"],
    ["Dark", 2, "dark"],
    ["HighContrast", 3, "dark"],
    ["HighContrastLight", 4, "light"],
  ] as const)("exports byte for byte what the CLI draws (%s theme)", async (name, kind, theme) => {
    expect(diagramThemeFor(kind as vscode.ColorThemeKind)).toBe(theme);
    const service = create({ diagramTheme: () => diagramThemeFor(kind as vscode.ColorThemeKind) });
    await service.showAtCursor(editorAt("src/order.ts", 2));
    const { requestId } = flows()[0];
    const node = (await extractor.extractFile(ORDER_FILE(), "typescript")).nodes.find((symbol) => symbol.name === "placeOrder")!;
    const cli = readFlowOptions(["src/order.ts#placeOrder", "--startLine", String(node.startLine + 1), "--theme", theme], "svg", root);
    expect(cli.request).toMatchObject({ symbolName: "placeOrder", startLine: 2 });
    expect(normalizePath(cli.request.filePath)).toBe(ORDER_FILE());
    const expected = await renderFlowDiagram(indexer.getDb(), { rootDir: root, extractor }, cli.request, { format: "svg", theme: cli.theme });
    expect(flows()[0].svg).toBe(expected.markup);
    for (const [file, format] of [[`flow-${name}.svg`, "svg"], [`flow-${name}.html`, "html"], [`flow-${name}.json`, "diagram-spec"]] as const) {
      service.setControls({ exportDiagram: { target: "file", output: file } });
      await service.handleWebviewMessage({ command: "flowExportDiagram", requestId, target: "file" });
      const cliMarkup = (await renderFlowDiagram(indexer.getDb(), { rootDir: root, extractor }, cli.request, { format, theme: cli.theme })).markup;
      expect(await fs.readFile(path.join(root, file), "utf8")).toBe(cliMarkup);
      expect(notices.at(-1)).toEqual({ message: `Flow diagram saved to ${file}.`, level: "info" });
    }
  });

  it("refuses an export outside the workspace or of another extension, and copies the SVG", async () => {
    const clipboard: string[] = [];
    const picked: string[] = [];
    const service = create({ writeClipboard: async (text) => void clipboard.push(text), pickDiagramFile: async (file) => (picked.push(file), undefined) });
    await service.showAtCursor(editorAt("src/order.ts", 2));
    const { requestId, svg } = flows()[0];
    const exportTo = async (output: string) => {
      service.setControls({ exportDiagram: { target: "file", output } });
      await service.handleWebviewMessage({ command: "flowExportDiagram", requestId, target: "file" });
    };
    await exportTo("flow.txt");
    expect(notices.at(-1)).toEqual({ message: "Could not export the Flow diagram: flow.txt: save as .svg, .html or .json", level: "error" });
    await exportTo("../outside.svg");
    expect(notices.at(-1)?.level).toBe("error");
    expect(notices.at(-1)?.message).toMatch(/^Could not export the Flow diagram: /);
    await expect(fs.access(path.join(root, "../outside.svg"))).rejects.toThrow();
    await service.handleWebviewMessage({ command: "flowExportDiagram", requestId, target: "file" });
    expect(picked).toEqual([path.join(root, "placeOrder-flow.svg")]);
    await service.handleWebviewMessage({ command: "flowExportDiagram", requestId, target: "clipboard" });
    expect(clipboard).toEqual([svg]);
    expect(notices.at(-1)).toEqual({ message: "Flow diagram copied as SVG.", level: "info" });
    await service.handleWebviewMessage({ command: "flowExportDiagram", requestId: requestId + 100, target: "clipboard" });
    expect(clipboard).toHaveLength(1);
  });

  it("re-colours on a theme change without re-indexing, marks a saved step stale, and replays on mount", async () => {
    let theme: "light" | "dark" = "light";
    const service = create({ diagramTheme: () => theme });
    service.onThemeChanged();
    expect(posted).toEqual([]);
    await service.showAtCursor(editorAt("src/order.ts", 2));
    const first = flows()[0];
    theme = "dark";
    service.onThemeChanged();
    const recoloured = flows()[1];
    expect(recoloured.requestId).toBeGreaterThan(first.requestId);
    expect(recoloured.svg).not.toBe(first.svg);
    expect(recoloured.nodes).toEqual(first.nodes);
    expect(callGraph.indexForFlow).toHaveBeenCalledOnce();

    service.onFileSaved(path.join(root, "README.md"));
    expect(states().filter((state) => state.status === "stale")).toHaveLength(0);
    service.onFileSaved(path.join(root, "src/store.ts"));
    service.onFileSaved(path.join(root, "src/store.ts"));
    expect(states().filter((state) => state.status === "stale")).toHaveLength(1);
    expect(service.getE2EState()).toMatchObject({ stale: true, state: "stale" });

    posted = [];
    service.onMounted();
    expect(posted.map((message) => message.type)).toEqual(["diagramContext", "flowDiagram", "flowDiagramState"]);
    expect(posted[0]).toEqual({ type: "diagramContext", hasWorkspace: true, follow: false });
    expect((posted[1] as FlowDiagramMessage).stale).toBe(true);
  });

  it("refreshes the same symbol, found again in its file; an old request is ignored", async () => {
    const service = create();
    await service.showAtCursor(editorAt("src/order.ts", 2));
    const { requestId } = flows()[0];
    await service.handleWebviewMessage({ command: "flowRefresh", requestId: requestId - 1 });
    expect(callGraph.indexForFlow).toHaveBeenCalledOnce();
    await service.handleWebviewMessage({ command: "flowRefresh", requestId });
    expect(callGraph.indexForFlow).toHaveBeenCalledTimes(2);
    expect(vs.withProgress).toHaveBeenCalledOnce();
    expect(flows().at(-1)).toMatchObject({ entry: flows()[0].entry, stale: false });
    // Not found again in the file: the request keeps its name and line, buildFlowModel decides (here, the index still has it).
    callGraph.extractFileSymbols.mockResolvedValueOnce({ nodes: [], edges: [], rootDir: root });
    await service.handleWebviewMessage({ command: "flowRefresh", requestId: flows().at(-1)!.requestId });
    expect(flows()).toHaveLength(3);
    expect(flows().at(-1)?.entry).toBe(flows()[0].entry);
    // Unsupported or re-indexing: nothing.
    callGraph.extractFileSymbols.mockResolvedValueOnce(undefined);
    await service.handleWebviewMessage({ command: "flowRefresh", requestId: flows().at(-1)!.requestId });
    expect(callGraph.indexForFlow).toHaveBeenCalledTimes(3);
  });

  it("re-scopes from a file crumb with its symbol pick, never from a path of the webview", async () => {
    const service = create();
    await service.showAtCursor(editorAt("src/order.ts", 2));
    vs.quickPick.mockResolvedValueOnce(undefined);
    await service.handleWebviewMessage({ command: "diagramRescope", tab: "flow", crumb: { kind: "file", label: "x", key: "../../etc/passwd" } });
    expect(callGraph.extractFileSymbols).toHaveBeenLastCalledWith(ORDER_FILE(), "typescript");
    await service.handleWebviewMessage({ command: "diagramRescope", tab: "flow", crumb: { kind: "symbol", label: "placeOrder" } });
    expect(vs.quickPick).toHaveBeenCalledOnce();
  });

  it("follows the cursor once per 300 ms burst, on the Flow or the Folder tab, until turned off", async () => {
    vi.useFakeTimers();
    const followFolder = vi.fn(async () => true);
    const service = create({ followFolder });
    const showAtCursor = vi.spyOn(service, "showAtCursor").mockResolvedValue(false);
    await service.handleWebviewMessage({ command: "diagramFollow", enabled: true });
    expect(posted.at(-1)).toEqual({ type: "diagramContext", hasWorkspace: true, follow: true });
    const select = (relative: string) => {
      for (const listener of vs.listeners.selection) listener({ textEditor: editorAt(relative, 2) });
    };
    select("src/order.ts");
    select("src/order.ts");
    vi.advanceTimersByTime(FOLLOW_DEBOUNCE_MS - 1);
    select("src/order.ts");
    vi.advanceTimersByTime(FOLLOW_DEBOUNCE_MS);
    expect(showAtCursor).toHaveBeenCalledOnce();
    expect(showAtCursor).toHaveBeenCalledWith(expect.anything(), { quiet: true });

    service.setFollow(true, "folder");
    for (const listener of vs.listeners.active) listener(editorAt("src/store.ts", 0));
    vi.advanceTimersByTime(FOLLOW_DEBOUNCE_MS);
    select("src/order.ts");
    vi.advanceTimersByTime(FOLLOW_DEBOUNCE_MS);
    for (const listener of vs.listeners.active) listener({ document: { uri: { fsPath: path.join(os.tmpdir(), "elsewhere", "x.ts") } } });
    vi.advanceTimersByTime(FOLLOW_DEBOUNCE_MS);
    for (const listener of vs.listeners.active) listener(undefined);
    vi.advanceTimersByTime(FOLLOW_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(followFolder.mock.calls).toEqual([["src"]]);

    // A breadcrumb click turns Follow off.
    await service.handleWebviewMessage({ command: "diagramRescope", tab: "flow", crumb: { kind: "symbol", label: "x" } });
    expect(service.getE2EState().follow).toBe(false);
    expect(vs.listeners.selection.size).toBe(0);
    select("src/order.ts");
    vi.advanceTimersByTime(FOLLOW_DEBOUNCE_MS);
    expect(showAtCursor).toHaveBeenCalledOnce();
    service.setFollow(true);
    service.dispose();
    expect(vs.listeners.active.size).toBe(0);
  });

  it("posts only the Flow controls of the E2E driver, checked", () => {
    const service = create();
    service.setControls(undefined);
    service.setControls({ tab: "nope" as never, flowNode: -1, flowEdge: 1.5, follow: "yes" as never });
    expect(posted).toEqual([]);
    service.setControls({ tab: "flow", flowNode: 2, flowEdge: 0, follow: true });
    expect(posted).toEqual([{ type: "architectureControls", tab: "flow", flowNode: 2, flowEdge: 0, follow: true }]);
    service.setControls({ cancelFlow: true });
    expect(posted).toHaveLength(1);
  });
});

describe("flowGeometry", () => {
  const step = (id: string) => ({ id, title: id, file: "a.ts", line: 1, lane: "main" as const, symbolCount: 1 });
  const call = (from: string, to: string, line: number) => ({ from, to, file: "a.ts", line, relation: "CALLS" as const, lane: "main" as const });
  const box = (id: string, x: number) => ({ id, x, y: 0, width: 10, height: 5, text: id, meta: "", entry: false, title: id });
  const model = { entry: "a", language: "typescript", lanes: "detected", maxSteps: 8, nodes: [step("a"), step("b")], edges: [call("a", "a", 2), call("a", "b", 3)], omittedSteps: 0 } as FlowModel;

  it("maps each placed edge to its model edge by index, a dropped self-call included", () => {
    const layout = { nodes: [box("a", 0), box("b", 20)], edges: [{ edge: 1, from: "a", to: "b", label: { x: 5, y: 6, text: "line 3" } }] } as unknown as FlowLayout;
    const { nodes, edges } = flowGeometry(model, layout);
    expect(nodes.map((node) => [node.name, node.x])).toEqual([["Step 1 of 2: a, a.ts:1, main lane", 0], ["Step 2 of 2: b, a.ts:1, main lane", 20]]);
    expect(edges).toEqual([{ from: "a", to: "b", file: "a.ts", line: 3, relation: "CALLS", lane: "main", name: "Call a → b at a.ts:3, main lane", label: { x: 5, y: 6, text: "line 3" } }]);
  });

  it("refuses a layout whose boxes are not the model's steps", () => {
    expect(() => flowGeometry(model, { nodes: [box("b", 0), box("a", 0)], edges: [] } as unknown as FlowLayout)).toThrow("internal error");
    expect(() => flowGeometry(model, { nodes: [box("a", 0)], edges: [] } as unknown as FlowLayout)).toThrow("internal error");
  });
});
