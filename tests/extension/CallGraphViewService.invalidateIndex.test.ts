import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  cacheOpen: vi.fn(),
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
}));

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }) },
  workspace: {
    get workspaceFolders() { return mocks.workspaceFolders; },
    fs: { delete: mocks.deleteFile },
  },
  commands: { executeCommand: vi.fn() },
}));

vi.mock("@/analyzer/cache/IndexCache", () => ({
  IndexCache: { open: mocks.cacheOpen },
}));

import { CallGraphViewService } from "@/extension/services/CallGraphViewService";

type Internals = {
  indexer: { dispose: () => void } | null;
  workspaceIndexedRoot: string | null;
  indexWorkspacePromise: Promise<void> | null;
  reindexPromise: Promise<void> | null;
  disposed: boolean;
  activeOperations: Set<Promise<unknown>>;
};

const CALL_GRAPH_DB = "/ws/.graph-it/cache/callgraph.db";

function createService() {
  const service = new CallGraphViewService({ subscriptions: [] } as never);
  const internals = service as unknown as Internals;
  const indexer = { dispose: vi.fn() };
  internals.indexer = indexer;
  internals.workspaceIndexedRoot = "/ws";
  internals.indexWorkspacePromise = Promise.resolve();
  return { service, internals, indexer };
}

describe("CallGraphViewService.invalidateIndex (#432)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceFolders = [{ uri: { fsPath: "/ws" } }];
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.cacheOpen.mockResolvedValue({ callGraphPath: CALL_GRAPH_DB });
  });

  it("drops the in-memory database and deletes the persisted one", async () => {
    const { service, internals, indexer } = createService();

    await service.invalidateIndex();

    expect(indexer.dispose).toHaveBeenCalledTimes(1);
    expect(internals.indexer).toBeNull();
    expect(internals.workspaceIndexedRoot).toBeNull();
    expect(internals.indexWorkspacePromise).toBeNull();
    expect(service.isIndexed()).toBe(false);
    expect(mocks.deleteFile).toHaveBeenCalledWith({ fsPath: CALL_GRAPH_DB });
  });

  it("does not show the call graph: the next show() rebuilds it", async () => {
    const { service } = createService();
    const show = vi.spyOn(service, "show");

    await service.invalidateIndex();

    expect(show).not.toHaveBeenCalled();
  });

  it("resolves when nothing was ever built", async () => {
    const { service, internals } = createService();
    internals.indexer = null;
    internals.workspaceIndexedRoot = null;

    await expect(service.invalidateIndex()).resolves.toBeUndefined();

    expect(service.isIndexed()).toBe(false);
  });

  it("is idempotent when called twice in a row", async () => {
    const { service, indexer } = createService();

    await service.invalidateIndex();
    await service.invalidateIndex();

    expect(indexer.dispose).toHaveBeenCalledTimes(1);
  });

  it("ignores a persisted file that is already gone", async () => {
    mocks.deleteFile.mockRejectedValue(new Error("ENOENT"));
    const { service, internals } = createService();

    await expect(service.invalidateIndex()).resolves.toBeUndefined();

    expect(internals.indexer).toBeNull();
  });

  it("deletes no file when no workspace is open", async () => {
    mocks.workspaceFolders = undefined;
    const { service, internals, indexer } = createService();
    internals.workspaceIndexedRoot = null;

    await service.invalidateIndex();

    expect(indexer.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.cacheOpen).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("waits for a running operation before dropping, whether it succeeds or fails", async () => {
    const { service, internals, indexer } = createService();
    let finish!: () => void;
    const running = new Promise<void>((resolve) => { finish = resolve; });
    const failing = Promise.reject(new Error("boom"));
    failing.catch(() => undefined);
    internals.activeOperations.add(running).add(failing);

    const invalidated = service.invalidateIndex();
    await Promise.resolve();
    expect(indexer.dispose).not.toHaveBeenCalled();

    finish();
    await invalidated;
    expect(indexer.dispose).toHaveBeenCalledTimes(1);
  });

  it("does nothing once disposed", async () => {
    const { service, internals, indexer } = createService();
    internals.disposed = true;

    await service.invalidateIndex();

    expect(indexer.dispose).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("does not drop when disposed while waiting for a running operation", async () => {
    const { service, internals, indexer } = createService();
    let finish!: () => void;
    internals.activeOperations.add(new Promise<void>((resolve) => { finish = resolve; }));

    const invalidated = service.invalidateIndex();
    internals.disposed = true;
    finish();
    await invalidated;

    expect(indexer.dispose).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("joins a forced re-index already in flight instead of dropping twice", async () => {
    const { service, internals, indexer } = createService();
    const reindex = Promise.resolve();
    internals.reindexPromise = reindex;

    await expect(service.invalidateIndex()).resolves.toBeUndefined();

    expect(indexer.dispose).not.toHaveBeenCalled();
  });
});
