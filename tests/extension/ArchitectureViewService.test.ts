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
import type { ArchitectureExtensionMessage, ArchitectureFolderLevelMessage, ArchitectureSummaryMessage } from "../../src/shared/architecture-types";
import type { CommunityMode } from "../../src/shared/graph-types";
import { normalizePath } from "../../src/shared/path";

// ui imports store twice; main.ts sits at the root. No package: units are src and (root).
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
  let opened: string[];
  let warnings: string[];

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
      openFile: async (absolutePath) => {
        opened.push(absolutePath);
      },
      warn: (message) => warnings.push(message),
      ...overrides,
    });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-view-")));
    await writeWorkspace(root, workspace);
    posted = [];
    opened = [];
    warnings = [];
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
      unassigned: { fileCount: 0, internalEdgeCount: 0 },
      hiddenGroups: 0,
      hiddenGroupEdges: 0,
    });
    expect(summary.revision).toBe(summary.context.revision);
    // Folder groups are scoped to their unit, ids in the units' order: (root) above src.
    expect(summary.groups.map(group => [group.id, group.key])).toEqual([[3, "src/ui"], [1, "(root)"], [2, "src/store"]]);
    // Inside a unit, a group is named by its folder.
    expect(summary.groups.map(group => group.label)).toEqual(["ui", "(root)", "store"]);
    expect(summary.groupEdges.map(edge => [edge.fromLabel, edge.toLabel, edge.fileEdgeCount]))
      .toEqual([["(root)", "ui", 1], ["ui", "store", 2]]);
    expect(summary.units).toMatchObject({
      units: [{ key: "(root)", layer: 1, fileCount: 1 }, { key: "src", layer: 0, fileCount: 3 }],
      unitEdges: [{ from: "(root)", to: "src", fileEdgeCount: 1, kind: "down" }],
      upwardEdges: 0,
      cycles: 0,
      totals: { files: 4, fileEdges: 3, intraUnitEdges: 2, interUnitEdges: 1 },
      groupUnits: { 1: "(root)", 2: "src", 3: "src" },
    });
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

  it("marks stale only for a change to a file of the graph, a deletion of one, or a creation", async () => {
    const service = createService();
    await service.build();
    service.markStale(path.join(root, "dist/bundle.js"), "change");
    service.markStale(path.join(root, ".serverless/handler.js"), "delete");
    expect(summaries()).toHaveLength(1);
    service.markStale(path.join(root, "src/ui/view.ts"), "change");
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);

    await service.build();
    service.markStale(path.join(root, "src/new.ts"), "create");
    expect(summaries().at(-1)?.stale).toBe(true);
  });

  it("ignores changes to files outside the graph made during a build", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const analyze = analyzerFor(root, workspace);
    const service = createService({ analyzeFile: async (filePath) => { await gate; return analyze(filePath); } });
    const running = service.build();
    service.markStale(path.join(root, "build/out.js"), "change");
    release();
    await running;
    expect(summaries()[0].stale).toBe(false);

    const gated = new Promise<void>(resolve => { release = resolve; });
    const next = createService({ analyzeFile: async (filePath) => { await gated; return analyze(filePath); } });
    const second = next.build();
    next.markStale(path.join(root, "src/store/state.ts"), "change");
    release();
    await second;
    expect(summaries().at(-1)?.stale).toBe(true);
  });

  it("keeps the largest groups of each unit, and the layers and edge kinds inside units", async () => {
    const many = Object.fromEntries([
      ...Array.from({ length: MAX_RENDERED_GROUPS + 2 }, (_, index) => [`big/d${index}/a.ts`, index === 0 ? ["big/d1/a.ts"] : []]),
      ["small/x/a.ts", ["small/y/a.ts"]],
      ["small/y/a.ts", ["small/x/a.ts"]],
    ]);
    const wide = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-units-")));
    try {
      await writeWorkspace(wide, many);
      await createService({ workspaceRoot: wide, analyzeFile: analyzerFor(wide, many) }).build();
      const [summary] = summaries();
      const unitOf = summary.units!.groupUnits;
      expect(summary.groups.filter(group => unitOf[group.id] === "big")).toHaveLength(MAX_RENDERED_GROUPS);
      expect(summary.groups.filter(group => unitOf[group.id] === "small")).toHaveLength(2);
      expect(summary.hiddenGroups).toBe(2);
      const id = (key: string) => summary.groups.find(group => group.key === key)!.id;
      expect(summary.units!.groupLayers[id("big/d0")]).toBe(1);
      expect(summary.units!.groupEdgeKinds[`${id("small/x")}>${id("small/y")}`]).toBe("cycle");
    } finally {
      await fs.rm(wide, { recursive: true, force: true });
    }
  });

  it("answers a folder level, then the group pages, evidence and files of that level", async () => {
    const nested = {
      "app/src/core/engine.ts": ["app/src/core/util/math.ts", "app/src/ui/view.ts"],
      "app/src/core/util/math.ts": [],
      "app/src/ui/view.ts": ["app/src/core/util/math.ts"],
    };
    const deep = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-folders-")));
    try {
      await writeWorkspace(deep, nested);
      const service = createService({ workspaceRoot: deep, analyzeFile: analyzerFor(deep, nested) });
      await service.build();
      const [summary] = summaries();
      const top = (key: string) => summary.groups.find(group => group.key === key)!.id;
      expect(summary.units!.nestedGroups).toEqual([top("app/core")]);

      await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: summary.revision, folder: "app/core" });
      const entered = posted.at(-1) as ArchitectureFolderLevelMessage;
      expect(entered).toMatchObject({ type: "architectureFolderLevel", revision: summary.revision, folder: "app/core" });
      const { level } = entered;
      expect(level.revision).not.toBe(summary.revision);
      expect(level.groups.map(group => `${group.label}:${group.fileCount}`).sort()).toEqual(["core:1", "util:1"]);
      expect(level.groupEdges.map(edge => `${edge.fromLabel}>${edge.toLabel}`)).toEqual(["core>util"]);
      expect(level.units!.nestedGroups).toEqual([]);

      const util = level.groups.find(group => group.key === "app/core/util")!.id;
      const core = level.groups.find(group => group.key === "app/core")!.id;
      await service.handleWebviewMessage({ command: "architectureExpandGroup", revision: level.revision, folder: "app/core", groupId: util });
      expect(posted.at(-1)).toMatchObject({ type: "architectureGroupDetail", folder: "app/core", detail: { files: [{ relativePath: "app/src/core/util/math.ts" }] } });
      await service.handleWebviewMessage({ command: "architectureEvidence", revision: level.revision, folder: "app/core", from: core, to: util });
      expect(posted.at(-1)).toMatchObject({ type: "architectureEvidencePage", pairs: [{ source: "app/src/core/engine.ts", target: "app/src/core/util/math.ts" }] });
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision: level.revision, folder: "app/core", relativePath: "app/src/core/engine.ts" });
      expect(opened).toEqual([path.join(deep, "app/src/core/engine.ts")]);
      // A file of the workspace outside the level is not one of its files.
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision: level.revision, folder: "app/core", relativePath: "app/src/ui/view.ts" });
      expect(opened).toHaveLength(1);
      expect(warnings.at(-1)).toContain("refused to open a file");

      // The level's ids are not the top level's: the top revision with the folder, or the reverse, is stale.
      await service.handleWebviewMessage({ command: "architectureExpandGroup", revision: summary.revision, folder: "app/core", groupId: util });
      expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: summary.revision });
      await service.handleWebviewMessage({ command: "architectureEvidence", revision: level.revision, from: core, to: util });
      expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: summary.revision });

      const count = posted.length;
      await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: summary.revision, folder: "nowhere" });
      expect(posted).toHaveLength(count);
      expect(warnings.at(-1)).toBe('Architecture view: no file below "nowhere"');
      await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: "old", folder: "app/core" });
      expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: summary.revision });
    } finally {
      await fs.rm(deep, { recursive: true, force: true });
    }
  });

  it("has no folder levels in Louvain mode", async () => {
    communityMode = "louvain";
    const service = createService();
    await service.build();
    const [summary] = summaries();
    const count = posted.length;
    await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: summary.revision, folder: "src" });
    expect(posted).toHaveLength(count);
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
    posted = [];
    release();
    await running;
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

  it("never posts the progress of an aborted build after the next build's summary", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const service = createService({ analyzeFile: async () => { calls += 1; if (calls === 1) await gate; return []; } });

    const first = service.build();
    await vi.waitFor(() => expect(calls).toBe(1));
    await service.build();
    expect(posted.at(-1)?.type).toBe("architectureSummary");
    release();
    await first;

    expect(posted.at(-1)?.type).toBe("architectureSummary");
  });

  it("never posts the indexing wait of an aborted build after the next build's summary", async () => {
    const listeners: ((snapshot: IndexerStatusSnapshot) => void)[] = [];
    // Listeners are never removed: models a notification already dispatched to the aborted build's listener.
    const service = createService({ subscribeToIndexStatus: (callback) => { listeners.push(callback); return () => {}; } });

    const first = service.build();
    const second = service.build();
    await first;
    listeners[1](idle);
    await second;
    expect(posted.at(-1)?.type).toBe("architectureSummary");
    listeners[0]({ state: "indexing" } as IndexerStatusSnapshot);

    expect(posted.at(-1)?.type).toBe("architectureSummary");
    expect(states().some(state => state.message === "Waiting for indexing to finish…")).toBe(false);
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

  it("caps rendered louvain groups at 150, keeps totals from the full aggregation, and sends every unit-scoped group", async () => {
    const groups = 200;
    // One import per folder: Louvain keeps each pair as its own community.
    const many = Object.fromEntries(Array.from({ length: groups }, (_, index) => [
      [`g${index}/a.ts`, [`g${index}/b.ts`]],
      [`g${index}/b.ts`, []],
    ]).flat());
    const wide = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-wide-")));
    try {
      await writeWorkspace(wide, many);
      communityMode = "louvain";
      await createService({ workspaceRoot: wide, analyzeFile: analyzerFor(wide, many) }).build();
      const [summary] = summaries();
      expect(summary.units).toBeUndefined();
      expect(summary.groups).toHaveLength(MAX_RENDERED_GROUPS);
      expect(summary.hiddenGroups).toBe(groups - MAX_RENDERED_GROUPS);
      expect(summary.totals.files).toBe(2 * groups);

      communityMode = "path";
      await createService({ workspaceRoot: wide, analyzeFile: analyzerFor(wide, many) }).build();
      const byUnit = summaries()[1];
      expect(byUnit.groups).toHaveLength(groups);
      expect(byUnit.hiddenGroups).toBe(0);
      expect(byUnit.units?.units).toHaveLength(groups);
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
      overlappingGroups: 1, overflowingLabels: 2, positions: "path:ui@0,0", unit: undefined, folder: undefined, unitLevel: undefined,
      resizeCount: 0, viewSize: { width: 0, height: 0 },
      interactionCount: 0, interaction: null, detailCount: 0, detail: null,
    });
  });

  it("counts resizes and keeps the last view size, without counting a render", async () => {
    const service = createService();
    await service.handleWebviewMessage({ command: "architectureResized", width: 300, height: 200 });
    await service.handleWebviewMessage({ command: "architectureResized", width: 420, height: 200 });
    expect(service.getE2EState()).toMatchObject({ renderCount: 0, resizeCount: 2, viewSize: { width: 420, height: 200 } });
  });

  it("keeps the last interaction and forwards the E2E controls to the webview", async () => {
    const service = createService();
    const interacted = {
      command: "architectureInteracted" as const,
      highlightedGroups: 2,
      fadedGroups: 1,
      labelledEdges: 1,
      shownGroupEdges: 3,
    };
    await service.handleWebviewMessage(interacted);
    await service.handleWebviewMessage({ ...interacted, highlightedGroups: 0 });
    expect(service.getE2EState()).toMatchObject({
      renderCount: 0,
      interactionCount: 2,
      interaction: { ...interacted, highlightedGroups: 0 },
    });

    service.setControls({ find: "ui", minImports: 2 });
    expect(posted.at(-1)).toEqual({ type: "architectureControls", find: "ui", minImports: 2 });

    service.setControls({ find: 123, minImports: Number.NaN } as never);
    expect(posted.at(-1)).toEqual({ type: "architectureControls", find: undefined, minImports: undefined });
    service.setControls({ find: "x".repeat(300), minImports: 0 });
    expect(posted.at(-1)).toEqual({ type: "architectureControls", find: "x".repeat(256), minImports: undefined });
    service.setControls(undefined);
    expect(posted.at(-1)).toEqual({ type: "architectureControls", find: undefined, minImports: undefined });
  });

  describe("group detail, evidence and opening files", () => {
    const built = async () => {
      const service = createService();
      await service.show();
      return { service, revision: summaries()[0].revision };
    };

    it("answers a group page and the evidence of an edge with the summary's revision", async () => {
      const { service, revision } = await built();
      await service.handleWebviewMessage({ command: "architectureExpandGroup", revision, groupId: 3 });
      await service.handleWebviewMessage({
        command: "architectureEvidence", revision, from: 3, to: 2, sourceFile: "src/ui/view.ts",
      });

      expect(posted.at(-2)).toMatchObject({
        type: "architectureGroupDetail",
        revision,
        detail: { group: { key: "src/ui" }, files: [{ relativePath: "src/ui/view.ts" }, { relativePath: "src/ui/form.ts" }] },
      });
      expect(posted.at(-1)).toEqual({
        type: "architectureEvidencePage",
        revision,
        from: 3,
        to: 2,
        sourceFile: "src/ui/view.ts",
        targetFile: undefined,
        pairs: [{ source: "src/ui/view.ts", target: "src/store/state.ts" }],
        page: { total: 1, offset: 0, returned: 1, truncated: false, nextOffset: undefined },
      });
    });

    it("answers the file pairs of a unit edge by unit key, opens one, and warns on an unknown unit or without units", async () => {
      const { service, revision } = await built();
      await service.handleWebviewMessage({ command: "architectureUnitEvidence", revision, from: "(root)", to: "src" });
      expect(posted.at(-1)).toEqual({
        type: "architectureEvidencePage",
        revision,
        from: "(root)",
        to: "src",
        pairs: [{ source: "main.ts", target: "src/ui/view.ts" }],
        page: { total: 1, offset: 0, returned: 1, truncated: false, nextOffset: undefined },
      });
      await service.handleWebviewMessage({ command: "architectureUnitEvidence", revision, from: "(root)", to: "src", offset: 1 });
      expect(posted.at(-1)).toMatchObject({ pairs: [], page: { total: 1, offset: 1, returned: 0 } });
      // A path coming back from the panel, in Windows form, opens the file of the units' graph.
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision, relativePath: "src\\ui\\view.ts" });
      expect(opened).toEqual([path.join(root, "src/ui/view.ts")]);

      const count = posted.length;
      await service.handleWebviewMessage({ command: "architectureUnitEvidence", revision, from: "nowhere", to: "src" });
      expect(posted).toHaveLength(count);
      expect(warnings.at(-1)).toContain('Unknown unit "nowhere"');
      await service.handleWebviewMessage({ command: "architectureUnitEvidence", revision: "old", from: "(root)", to: "src" });
      expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: revision });

      communityMode = "louvain";
      await service.build();
      await service.handleWebviewMessage({ command: "architectureUnitEvidence", revision: summaries().at(-1)!.revision, from: "(root)", to: "src" });
      expect(warnings.at(-1)).toContain("unit edges only exist in path mode");
    });

    it("answers a stale revision, or a request before any build, with the current revision", async () => {
      const early = createService();
      await early.handleWebviewMessage({ command: "architectureExpandGroup", revision: "old", groupId: 1 });
      expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: "" });

      const { service, revision } = await built();
      for (const message of [
        { command: "architectureExpandGroup", revision: "old", groupId: 1 },
        { command: "architectureEvidence", revision: "old", from: 1, to: 2 },
        { command: "architectureOpenFile", revision: "old", relativePath: "main.ts" },
      ] as const) {
        posted = [];
        await service.handleWebviewMessage(message);
        expect(posted).toEqual([{ type: "architectureRevisionChanged", currentRevision: revision }]);
      }
      expect(opened).toEqual([]);
    });

    it.each([-1, 1.5, Number.NaN, "2"])("reads the first page for the invalid offset %s", async (offset) => {
      const { service, revision } = await built();
      await service.handleWebviewMessage({ command: "architectureExpandGroup", revision, groupId: 3, offset } as never);
      expect(posted.at(-1)).toMatchObject({ detail: { page: { offset: 0 } } });
      await service.handleWebviewMessage({ command: "architectureEvidence", revision, from: 3, to: 2, offset } as never);
      expect(posted.at(-1)).toMatchObject({ page: { offset: 0, total: 2 } });
    });

    it("keeps answering a stale-marked summary, whose revision is unchanged", async () => {
      const { service, revision } = await built();
      service.markStale();
      await service.handleWebviewMessage({ command: "architectureExpandGroup", revision, groupId: 1 });
      expect(posted.at(-1)).toMatchObject({ type: "architectureGroupDetail", detail: { files: [{ relativePath: "main.ts" }] } });
    });

    it("logs an unknown group instead of answering", async () => {
      const { service, revision } = await built();
      const count = posted.length;
      await service.handleWebviewMessage({ command: "architectureExpandGroup", revision, groupId: 99 });
      expect(posted).toHaveLength(count);
      expect(warnings).toEqual([expect.stringContaining('Unknown group "99"')]);
    });

    it("opens a file of the graph by its workspace-relative path", async () => {
      const { service, revision } = await built();
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision, relativePath: "src/ui/view.ts" });
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision, relativePath: String.raw`src\ui\form.ts` });
      expect(opened).toEqual([path.join(root, "src/ui/view.ts"), path.join(root, "src/ui/form.ts")]);
      expect(warnings).toEqual([]);
    });

    it.each([
      ["a parent path", "../outside.ts"],
      ["a Windows parent path", String.raw`..\outside.ts`],
      ["a nested parent path", "src/../../outside.ts"],
      ["a POSIX absolute path", "/etc/passwd"],
      ["a Windows absolute path", String.raw`C:\Windows\win.ini`],
      ["a file outside the graph", "src/ui/missing.ts"],
      ["a null byte", "main.ts\0"],
    ])("refuses %s without opening anything", async (_name, relativePath) => {
      const { service, revision } = await built();
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision, relativePath });
      expect(opened).toEqual([]);
      expect(warnings).toEqual([expect.stringContaining("refused to open a file")]);
      expect(warnings[0]).not.toContain(root);
    });

    it("refuses a graph file replaced by a symlink leaving the workspace since the build", async () => {
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-outside-")));
      try {
        const { service, revision } = await built();
        await fs.writeFile(path.join(outside, "secret.ts"), "");
        await fs.rm(path.join(root, "src/ui/form.ts"));
        await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "src/ui/form.ts"));
        await service.handleWebviewMessage({ command: "architectureOpenFile", revision, relativePath: "src/ui/form.ts" });
        expect(opened).toEqual([]);
        expect(warnings).toEqual([expect.stringContaining("symbolic link")]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("logs a failure to open a validated file", async () => {
      const service = createService({ openFile: async () => { throw new Error("cannot open"); } });
      await service.show();
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision: summaries()[0].revision, relativePath: "main.ts" });
      expect(warnings).toEqual(["Architecture view: refused to open a file (cannot open)"]);
    });

    it("keeps the last detail render and forwards the expansion controls", async () => {
      const service = createService();
      const detail = {
        command: "architectureDetailRendered" as const,
        expandedGroups: 1, expandedFileCount: 4, renderedFiles: 4, groupLevelEdges: 2, capReached: false,
      };
      await service.handleWebviewMessage(detail);
      expect(service.getE2EState()).toMatchObject({ detailCount: 1, detail });

      service.setControls({ unit: "apps/web", expand: "ui", collapse: "store", evidenceOf: "ui", openEvidenceRow: 0 });
      expect(posted.at(-1)).toMatchObject({ unit: "apps/web", expand: "ui", collapse: "store", evidenceOf: "ui", openEvidenceRow: 0 });
      service.setControls({ unit: 3, folder: 4, expand: 1, openEvidenceRow: -1 } as never);
      expect(posted.at(-1)).toMatchObject({ unit: undefined, folder: undefined, expand: undefined, openEvidenceRow: undefined });
      service.setControls({ folder: "apps/web/pages" });
      expect(posted.at(-1)).toMatchObject({ folder: "apps/web/pages" });
      await service.handleWebviewMessage({
        command: "architectureRendered", revision: "abc", renderedGroups: 2, renderedGroupEdges: 1, communityMode: "path", stale: false,
        overlappingGroups: 0, overflowingLabels: 0, positions: "", unit: "apps/web", folder: "apps/web/pages",
      });
      expect(service.getE2EState().folder).toBe("apps/web/pages");
    });
  });
});
