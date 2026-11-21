import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  editor: undefined as unknown,
  info: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {
    createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }),
    get activeTextEditor() { return mocks.editor; },
    showInformationMessage: mocks.info,
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    workspaceFolders: undefined,
    asRelativePath: (p: string) => p,
    onDidSaveTextDocument: () => ({ dispose: vi.fn() }),
  },
  commands: { executeCommand: vi.fn() },
}));

import { CallGraphViewService, symbolAtLine } from "@/extension/services/CallGraphViewService";

type Internals = {
  reindexing: boolean;
  ensureIndexer(): Promise<unknown>;
  ensureExtractor(root: string): unknown;
  indexWorkspace(...args: unknown[]): Promise<void>;
  indexImportTargets(...args: unknown[]): Promise<void>;
};

const editorAt = (fsPath: string, languageId: string) => ({ document: { uri: { fsPath }, languageId }, selection: { active: { line: 0 } } });

function token(cancelled = false) {
  const listeners: (() => void)[] = [];
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: (listener: () => void) => (listeners.push(listener), { dispose: () => {} }),
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) listener();
    },
  };
}

function serviceAt(root: string | undefined) {
  const service = new CallGraphViewService({ subscriptions: [] } as never, async () => [], () => root);
  const internals = service as unknown as Internals;
  const indexer = { indexFile: vi.fn(), resolveExternalEdges: vi.fn(() => ({ resolved: 0 })), getDb: () => "db" };
  const extractor = { extractFile: vi.fn(async () => ({ nodes: [{ id: "a#run", name: "run", startLine: 1, endLine: 4 }], edges: [{ sourceId: "x" }] })) };
  internals.ensureIndexer = async () => indexer;
  internals.ensureExtractor = vi.fn(() => extractor);
  internals.indexWorkspace = vi.fn(async () => {});
  internals.indexImportTargets = vi.fn(async () => {});
  return { service, internals, indexer, extractor };
}

describe("symbolAtLine", () => {
  const nodes = [
    { id: "outer", startLine: 0, endLine: 20 },
    { id: "inner", startLine: 5, endLine: 8 },
    { id: "after", startLine: 30, endLine: 32 },
  ];

  it("picks the most specific symbol holding the line", () => {
    expect(symbolAtLine(nodes, 6)?.id).toBe("inner");
    expect(symbolAtLine(nodes, 5)?.id).toBe("inner");
    expect(symbolAtLine(nodes, 2)?.id).toBe("outer");
    expect(symbolAtLine(nodes, 32)?.id).toBe("after");
  });

  it("guesses nothing between symbols or in an empty file", () => {
    expect(symbolAtLine(nodes, 25)).toBeNull();
    expect(symbolAtLine([], 0)).toBeNull();
  });
});

describe("CallGraphViewService flow hooks (#795)", () => {
  beforeEach(() => {
    mocks.info.mockReset();
    mocks.editor = undefined;
  });

  it("names the feature in its refusals", () => {
    const { service } = serviceAt("/repo");
    expect(service.activeSourceEditor("Flow Diagram", undefined)).toBeUndefined();
    expect(mocks.info).toHaveBeenLastCalledWith("Graph-It-Live: Open a source file and position the cursor on a symbol first.");
    expect(service.activeSourceEditor("Flow Diagram", editorAt("/repo/README.md", "markdown") as never)).toBeUndefined();
    expect(mocks.info.mock.lastCall?.[0]).toMatch(/^Graph-It-Live: Flow Diagram is not supported for "markdown"\. Supported: /);
    expect(service.activeSourceEditor("Flow Diagram", editorAt("/repo/a.graphql", "plaintext") as never)?.lang).toBe("graphql");
  });

  it("reads the language from the id, else the extension", () => {
    const { service } = serviceAt("/repo");
    expect(service.isFlowSupported({ languageId: "typescriptreact", uri: { fsPath: "/repo/a.tsx" } })).toBe("typescript");
    expect(service.isFlowSupported({ uri: { fsPath: "/repo/a.py" } })).toBe("python");
    expect(service.isFlowSupported({ uri: { fsPath: "/repo/a.csproj" } })).toBeNull();
    expect(service.isFlowSupported({ uri: { fsPath: "/repo/README.md" } })).toBeNull();
  });

  it("extracts and indexes one file against the workspace, or the loose file's folder", async () => {
    const { service, indexer, internals } = serviceAt("/repo");
    const symbols = await service.extractFileSymbols("/repo/src/a.ts", "typescript");
    expect(symbols).toMatchObject({ rootDir: "/repo", nodes: [{ name: "run" }] });
    expect(indexer.indexFile).toHaveBeenCalledOnce();
    const loose = serviceAt(undefined);
    expect((await loose.service.extractFileSymbols("/tmp/a/main.ts", "typescript"))?.rootDir).toBe("/tmp/a");
    expect(internals.indexWorkspace).not.toHaveBeenCalled();
  });

  it("refuses while re-indexing: once aloud, silently when quiet", async () => {
    const { service, internals } = serviceAt("/repo");
    internals.reindexing = true;
    expect(await service.extractFileSymbols("/repo/a.ts", "typescript", { quiet: true })).toBeUndefined();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(await service.extractFileSymbols("/repo/a.ts", "typescript")).toBeUndefined();
    expect(mocks.info).toHaveBeenCalledWith("Graph-It-Live: the call graph is re-indexing; run the command again when it finishes.");
    service.dispose();
    expect(await service.extractFileSymbols("/repo/a.ts", "typescript")).toBeUndefined();
    expect(await service.indexForFlow({ filePath: "/repo/a.ts", edges: [], rootDir: "/repo" }, { token: token() as never })).toBeUndefined();
  });

  it("indexes the workspace silently, then the file's imports and cross-file calls", async () => {
    const { service, internals, indexer } = serviceAt("/repo");
    const result = await service.indexForFlow({ filePath: "/repo/src/a.ts", edges: [], rootDir: "/repo" }, { token: token() as never });
    expect(result).toMatchObject({ db: "db" });
    expect(internals.indexWorkspace).toHaveBeenCalledWith("/repo", expect.anything(), expect.anything(), "/repo/src/a.ts", true);
    expect(internals.indexImportTargets).toHaveBeenCalledOnce();
    expect(indexer.resolveExternalEdges).toHaveBeenCalledOnce();
  });

  it("stops waiting on cancel; the walk goes on", async () => {
    const { service, internals, indexer } = serviceAt("/repo");
    let finish = () => {};
    internals.indexWorkspace = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cancel = token();
    const waited = service.indexForFlow({ filePath: "/repo/a.ts", edges: [], rootDir: "/repo" }, { token: cancel as never });
    await Promise.resolve();
    await Promise.resolve();
    cancel.cancel();
    expect(await waited).toBeUndefined();
    finish();
    expect(indexer.resolveExternalEdges).not.toHaveBeenCalled();
  });

  it("abandons silently when another file became active during the wait", async () => {
    const { service, internals } = serviceAt("/repo");
    mocks.editor = editorAt("/repo/other.ts", "typescript");
    const step1 = { filePath: "/repo/a.ts", edges: [], rootDir: "/repo" };
    expect(await service.indexForFlow(step1, { token: token() as never, expectActiveFile: "/repo/a.ts" })).toBeUndefined();
    expect(internals.indexImportTargets).not.toHaveBeenCalled();
    mocks.editor = undefined;
    expect(await service.indexForFlow(step1, { token: token() as never, expectActiveFile: "/repo/a.ts" })).toBeUndefined();
    mocks.editor = editorAt("/repo/a.ts", "typescript");
    expect(await service.indexForFlow(step1, { token: token() as never, expectActiveFile: "/repo/a.ts" })).toBeDefined();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("returns nothing when cancelled while the imports were indexed", async () => {
    const { service, internals, indexer } = serviceAt("/repo");
    const cancel = token();
    internals.indexImportTargets = vi.fn(async () => cancel.cancel());
    expect(await service.indexForFlow({ filePath: "/repo/a.ts", edges: [], rootDir: "/repo" }, { token: cancel as never })).toBeUndefined();
    expect(indexer.resolveExternalEdges).not.toHaveBeenCalled();
  });
});
