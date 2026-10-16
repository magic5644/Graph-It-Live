import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeFile } from "../../src/analyzer/architecture/ArchitectureGraphBuilder";
import type { IndexerStatusSnapshot } from "../../src/analyzer/IndexerStatus";
import {
  ArchitectureViewService,
  MAX_RENDERED_GROUPS,
  maskWorkspaceRoot,
  type ArchitectureViewServiceOptions,
} from "../../src/extension/services/ArchitectureViewService";
import type { ArchitectureExtensionMessage, ArchitectureSummaryMessage } from "../../src/shared/architecture-types";
import type { CommunityMode } from "../../src/shared/graph-types";
import { normalizePath } from "../../src/shared/path";

// ui imports store twice; main.ts sits at the root, outside any folder group.
const workspace: Record<string, string[]> = {
  "main.ts": ["src/ui/view.ts"],
  "src/ui/view.ts": ["src/store/state.ts"],
  "src/ui/form.ts": ["src/store/state.ts"],
  "src/store/state.ts": [],
};

const idle = { state: "idle" } as IndexerStatusSnapshot;

async function writeWorkspace(root: string, files: Record<string, string[]>): Promise<void> {
  for (const relative of Object.keys(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), "");
  }
}

function analyzerFor(root: string, files: Record<string, string[]>): AnalyzeFile {
  return async (filePath) =>
    (files[normalizePath(path.relative(root, filePath))] ?? []).map(relative =>
      ({ path: path.join(root, relative), type: "import" as const, line: 1, module: relative }));
}

describe("ArchitectureViewService", () => {
  let root: string;
  let posted: ArchitectureExtensionMessage[];
  let communityMode: CommunityMode;

  const summaries = () => posted.filter((message): message is ArchitectureSummaryMessage => message.type === "architectureSummary");
  const states = () => posted.filter(message => message.type === "architectureState");
  const createService = (overrides: Partial<ArchitectureViewServiceOptions> = {}) =>
    new ArchitectureViewService({
      workspaceRoot: root,
      analyzeFile: analyzerFor(root, workspace),
      readCommunityMode: () => communityMode,
      subscribeToIndexStatus: (callback) => {
        callback(idle);
        return () => {};
      },
      post: (message) => posted.push(message),
      ...overrides,
    });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-view-")));
    await writeWorkspace(root, workspace);
    posted = [];
    communityMode = "path";
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("posts building, then a summary with the full aggregation's counts", async () => {
    await createService().handleWebviewMessage({ command: "architectureMounted" });

    expect(posted[0]).toMatchObject({ type: "architectureState", status: "building" });
    const [summary] = summaries();
    expect(summaries()).toHaveLength(1);
    expect(summary).toMatchObject({
      stale: false,
      scannedFiles: 4,
      analyzedFiles: 4,
      totals: { files: 4, fileEdges: 3, intraGroupEdges: 0, interGroupEdges: 3 },
      unassigned: { fileCount: 1, internalEdgeCount: 0 },
      hiddenGroups: 0,
      hiddenGroupEdges: 0,
    });
    expect(summary.revision).toBe(summary.context.revision);
    expect(summary.groups.map(group => group.key)).toEqual(["ui", "store"]);
    expect(summary.groupEdges.map(edge => [edge.fromLabel, edge.toLabel, edge.fileEdgeCount]))
      .toEqual([["unassigned", "ui", 1], ["ui", "store", 2]]);
  });

  it("reposts the cached summary on mount and rebuilds when communityMode changes", async () => {
    const service = createService();
    await service.show();
    await service.show();
    expect(summaries()).toHaveLength(2);
    expect(service.getE2EState().buildCount).toBe(1);

    await service.handleCommunityModeChange();
    expect(service.getE2EState().buildCount).toBe(1);

    communityMode = "louvain";
    await service.handleCommunityModeChange();
    expect(service.getE2EState().buildCount).toBe(2);
    expect(summaries().at(-1)?.context.communityMode).toBe("louvain");
    expect(summaries().at(-1)?.revision).not.toBe(summaries()[0].revision);
  });

  it("does not rebuild on a communityMode change before anything was built", async () => {
    await createService().handleCommunityModeChange();
    expect(posted).toEqual([]);
  });

  it("marks the cached summary stale once, without rebuilding, until Refresh", async () => {
    const service = createService();
    service.markStale();
    expect(posted).toEqual([]);

    await service.build();
    service.markStale();
    service.markStale();
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);
    expect(summaries()[1].revision).toBe(summaries()[0].revision);
    expect(service.getE2EState().buildCount).toBe(1);

    await service.handleWebviewMessage({ command: "architectureRefresh" });
    expect(summaries().at(-1)?.stale).toBe(false);
    expect(service.getE2EState().buildCount).toBe(2);
  });

  it("posts the summary stale when a file changed during its build", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = createService({ analyzeFile: async () => { await gate; return []; } });

    const running = service.build();
    service.markStale();
    expect(posted.some(message => message.type === "architectureSummary")).toBe(false);
    release();
    await running;
    expect(summaries()[0].stale).toBe(true);

    await service.build();
    expect(summaries()[1].stale).toBe(false);
  });

  it("keeps a change seen by an aborted build for the build that replaces it", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const service = createService({ analyzeFile: async () => { calls += 1; if (calls === 1) await gate; return []; } });

    const first = service.build();
    await vi.waitFor(() => expect(calls).toBe(1));
    service.markStale();
    const second = service.build();
    release();
    await Promise.all([first, second]);

    expect(summaries().map(summary => summary.stale)).toEqual([true]);
  });

  it("builds the new mode when mounted while a build of the old mode runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const service = createService({ analyzeFile: async () => { calls += 1; if (calls === 1) await gate; return []; } });

    const first = service.build();
    await vi.waitFor(() => expect(calls).toBe(1));
    communityMode = "louvain";
    const second = service.show();
    release();
    await Promise.all([first, second]);

    expect(summaries().map(summary => summary.context.communityMode)).toEqual(["louvain"]);
    expect(service.getE2EState().buildCount).toBe(1);
  });

  it("rebuilds in the new mode when the setting changes during a build", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const service = createService({ analyzeFile: async () => { calls += 1; if (calls === 1) await gate; return []; } });

    const first = service.build();
    await vi.waitFor(() => expect(calls).toBe(1));
    communityMode = "louvain";
    const second = service.handleCommunityModeChange();
    await service.handleCommunityModeChange(); // already building louvain
    release();
    await Promise.all([first, second]);

    expect(summaries().map(summary => summary.context.communityMode)).toEqual(["louvain"]);
  });

  it("stops for good once disposed, even during analysis", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const service = createService({ analyzeFile: async () => { calls += 1; await gate; return []; } });

    const running = service.build();
    await vi.waitFor(() => expect(calls).toBe(1));
    service.dispose();
    release();
    await running;
    posted = [];
    service.markStale();
    await service.build();
    await service.show();
    await service.handleWebviewMessage({ command: "architectureRefresh" });

    expect(posted).toEqual([]);
    expect(service.getE2EState().buildCount).toBe(0);
  });

  it("posts empty when the workspace has no source file", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-empty-"));
    try {
      await createService({ workspaceRoot: empty }).build();
      expect(posted.at(-1)).toMatchObject({ type: "architectureState", status: "empty" });
      expect(summaries()).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("posts error when the build throws, and Retry builds again", async () => {
    let fail = true;
    const service = createService({
      subscribeToIndexStatus: (callback) => {
        if (fail) throw new Error("index unavailable");
        callback(idle);
        return () => {};
      },
    });

    await service.build();
    expect(posted.at(-1)).toEqual({ type: "architectureState", status: "error", message: "index unavailable" });

    const leaking = createService({
      subscribeToIndexStatus: () => { throw new Error(`EACCES: scandir '${root}/src'`); },
    });
    await leaking.build();
    expect(posted.at(-1)).toMatchObject({ status: "error", message: "EACCES: scandir '<workspace>/src'" });

    fail = false;
    await service.handleWebviewMessage({ command: "architectureRefresh" });
    expect(summaries()).toHaveLength(1);
  });

  it("masks the workspace root in every Windows separator form", () => {
    const root = String.raw`C:\Users\dev\ws`;
    expect(maskWorkspaceRoot(String.raw`EACCES: scandir 'C:\Users\dev\ws\src'`, root)).toBe(String.raw`EACCES: scandir '<workspace>\src'`);
    expect(maskWorkspaceRoot("EACCES: scandir 'C:/Users/dev/ws/src'", root)).toBe("EACCES: scandir '<workspace>/src'");
    expect(maskWorkspaceRoot("ENOENT 'c:/Users/dev/ws/a.ts'", root)).toBe("ENOENT '<workspace>/a.ts'");
    expect(maskWorkspaceRoot("unrelated", "")).toBe("unrelated");
  });

  it("counts files whose analysis throws as failed, and still posts a summary", async () => {
    await createService({ analyzeFile: async () => { throw new Error("parse error"); } }).build();
    expect(summaries()[0].context.failedFiles).toBe(4);
    expect(summaries()[0].totals.fileEdges).toBe(0);
  });

  it("never posts the summary of an aborted build", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const analyze = analyzerFor(root, workspace);
    let calls = 0;
    const service = createService({
      analyzeFile: async (filePath) => {
        calls += 1;
        if (calls === 1) await gate;
        return analyze(filePath);
      },
    });

    const first = service.build();
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = service.build();
    release();
    await Promise.all([first, second]);

    expect(summaries()).toHaveLength(1);
    expect(service.getE2EState().buildCount).toBe(1);
    expect(states().some(state => state.status === "error")).toBe(false);
  });

  it("lets a mount during a build wait for that build instead of starting another", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = createService({ analyzeFile: async () => { await gate; return []; } });

    const running = service.build();
    await service.show();
    release();
    await running;

    expect(summaries()).toHaveLength(1);
    expect(service.getE2EState().buildCount).toBe(1);
  });

  it("waits for indexing to finish before analysing, and stops waiting when disposed", async () => {
    let notify!: (snapshot: IndexerStatusSnapshot) => void;
    const unsubscribe = vi.fn();
    const analyzeFile = vi.fn(analyzerFor(root, workspace));
    const service = createService({
      analyzeFile,
      subscribeToIndexStatus: (callback) => {
        notify = callback;
        callback({ state: "indexing" } as IndexerStatusSnapshot);
        return unsubscribe;
      },
    });

    const build = service.build();
    await Promise.resolve();
    expect(analyzeFile).not.toHaveBeenCalled();
    expect(states().map(state => state.message)).toEqual(["Building architecture…", "Waiting for indexing to finish…"]);
    notify({ state: "complete" } as IndexerStatusSnapshot);
    await build;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(summaries()).toHaveLength(1);

    const waiting = service.build();
    service.dispose();
    await waiting;
    expect(summaries()).toHaveLength(1);
    expect(states().at(-1)?.status).toBe("building");
  });

  it("reports progress as a percentage of analysed files", async () => {
    await createService().build();
    expect(states().some(state => state.message === "Waiting for indexing to finish…")).toBe(false);
    expect(states().some(state => state.percent !== undefined && state.percent > 0)).toBe(true);
  });

  it("caps rendered groups at 150 and keeps totals from the full aggregation", async () => {
    const groups = 200;
    const many = Object.fromEntries(Array.from({ length: groups }, (_, index) => [`g${index}/a.ts`, []]));
    const wide = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-wide-")));
    try {
      await writeWorkspace(wide, many);
      await createService({ workspaceRoot: wide, analyzeFile: analyzerFor(wide, many) }).build();
      const [summary] = summaries();
      expect(summary.groups).toHaveLength(MAX_RENDERED_GROUPS);
      expect(summary.hiddenGroups).toBe(groups - MAX_RENDERED_GROUPS);
      expect(summary.totals.files).toBe(groups);
    } finally {
      await fs.rm(wide, { recursive: true, force: true });
    }
  });

  it("exposes what the webview last rendered", async () => {
    const service = createService();
    expect(service.getE2EState()).toMatchObject({ renderCount: 0, groupCount: 0, groupEdgeCount: 0, stale: false });

    await service.handleWebviewMessage({
      command: "architectureRendered",
      revision: "abc",
      renderedGroups: 3,
      renderedGroupEdges: 2,
      communityMode: "path",
      stale: true,
      overlappingGroups: 1,
      overflowingLabels: 2,
      positions: "path:ui@0,0",
    });
    expect(service.getE2EState()).toEqual({
      buildCount: 0, renderCount: 1, groupCount: 3, groupEdgeCount: 2, revision: "abc", communityMode: "path", stale: true,
      overlappingGroups: 1, overflowingLabels: 2, positions: "path:ui@0,0", resizeCount: 0, viewSize: { width: 0, height: 0 },
    });
  });

  it("counts resizes and keeps the last view size, without counting a render", async () => {
    const service = createService();
    await service.handleWebviewMessage({ command: "architectureResized", width: 300, height: 200 });
    await service.handleWebviewMessage({ command: "architectureResized", width: 420, height: 200 });
    expect(service.getE2EState()).toMatchObject({ renderCount: 0, resizeCount: 2, viewSize: { width: 420, height: 200 } });
  });
});
