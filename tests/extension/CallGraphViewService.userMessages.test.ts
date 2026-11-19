import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  editor: undefined as unknown,
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {
    createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }),
    get activeTextEditor() { return mocks.editor; },
    showInformationMessage: mocks.info,
    showErrorMessage: mocks.error,
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    workspaceFolders: undefined,
    asRelativePath: (p: string) => p.replace("/repo/", ""),
    onDidSaveTextDocument: () => ({ dispose: vi.fn() }),
  },
  commands: { executeCommand: vi.fn() },
}));

import { CallGraphViewService } from "@/extension/services/CallGraphViewService";

const ROOT = "/repo";

type Internals = {
  reindexing: boolean;
  ensureIndexer(): Promise<unknown>;
  ensureExtractor(root: string): unknown;
  indexWorkspace(): Promise<void>;
  indexImportTargets(): Promise<void>;
};

/** A service whose extractor returns `nodes` for the active file and whose index query fails with `failure`. */
function serviceWith(nodes: Array<{ id: string; name: string; startLine: number; endLine: number }>, failure: Error) {
  const service = new CallGraphViewService({ subscriptions: [] } as never, async () => [], () => ROOT);
  const internals = service as unknown as Internals;
  internals.ensureIndexer = async () => ({
    indexFile: vi.fn(),
    resolveExternalEdges: () => ({ resolved: 0 }),
    getDb: () => { throw failure; },
  });
  internals.ensureExtractor = () => ({ extractFile: async () => ({ nodes, edges: [] }) });
  internals.indexWorkspace = async () => {};
  internals.indexImportTargets = async () => {};
  return { service, internals };
}

const editorAt = (fsPath: string, languageId: string, line: number) => ({
  document: { uri: { fsPath }, languageId },
  selection: { active: { line } },
});

describe("CallGraphViewService says why it shows nothing, or something else (#770)", () => {
  beforeEach(() => {
    mocks.info.mockReset();
    mocks.error.mockReset();
    mocks.editor = undefined;
  });

  it("refuses without an editor and on an unsupported language", () => {
    const { service } = serviceWith([], new Error("unused"));
    expect(service.canShow()).toBe(false);
    expect(mocks.info).toHaveBeenLastCalledWith("Graph-It-Live: Open a source file and position the cursor on a symbol first.");

    mocks.editor = editorAt("/repo/README.md", "markdown", 0);
    expect(service.canShow()).toBe(false);
    expect(mocks.info.mock.lastCall?.[0]).toMatch(/^Graph-It-Live: Call Graph is not supported for "markdown"/);

    mocks.info.mockReset();
    mocks.editor = editorAt("/repo/schema.graphql", "plaintext", 0);
    expect(service.canShow()).toBe(true);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  // Show Call Graph asks canShow() before switching the toolbar to call-graph mode.
  it("cannot show during a re-index, and says so once", () => {
    mocks.editor = editorAt("/repo/src/a.ts", "typescript", 0);
    const { service, internals } = serviceWith([], new Error("unused"));
    internals.reindexing = true;
    expect(service.canShow()).toBe(false);
    expect(mocks.info).toHaveBeenCalledOnce();
  });

  it("says a re-index is running instead of returning silently", async () => {
    const { service, internals } = serviceWith([], new Error("unused"));
    internals.reindexing = true;
    await service.show();
    await service.showReviewTarget("src/a.ts", undefined, 1);
    expect(mocks.info).toHaveBeenCalledTimes(2);
    expect(mocks.info).toHaveBeenCalledWith("Graph-It-Live: the call graph is re-indexing; run the command again when it finishes.");
  });

  it("names the symbol shown when the cursor is outside every symbol, and reports a failure once with relative paths", async () => {
    mocks.editor = editorAt("/repo/src/a.ts", "typescript", 40);
    const { service } = serviceWith(
      [{ id: "a:first", name: "first", startLine: 2, endLine: 5 }, { id: "a:second", name: "second", startLine: 7, endLine: 9 }],
      new Error(`cannot read ${ROOT}/src/a.ts`),
    );
    await service.show();
    expect(mocks.info).toHaveBeenCalledWith('Graph-It-Live: the cursor is outside every symbol; showing "first", the first one in the file.');
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith("Graph-It-Live: could not build the call graph: cannot read src/a.ts");
  });

  it("stays quiet about the root when the cursor is inside a symbol", async () => {
    mocks.editor = editorAt("/repo/src/a.ts", "typescript", 8);
    const { service } = serviceWith([{ id: "a:second", name: "second", startLine: 7, endLine: 9 }], new Error("db"));
    await service.show();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("says the file has no symbol", async () => {
    mocks.editor = editorAt("/repo/src/empty.ts", "typescript", 0);
    const { service } = serviceWith([], new Error("db"));
    await service.show();
    expect(mocks.info).toHaveBeenCalledWith("Graph-It-Live: src/empty.ts has no symbol to show in the call graph.");
  });
});
