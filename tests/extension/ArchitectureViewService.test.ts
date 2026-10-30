import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeFile } from "../../src/analyzer/architecture/ArchitectureGraphBuilder";
import type { IndexerStatusSnapshot } from "../../src/analyzer/IndexerStatus";
import {
  ArchitectureViewService,
  maskWorkspaceRoot,
  writtenBefore,
  type ArchitectureViewServiceOptions,
} from "../../src/extension/services/ArchitectureViewService";
import {
  DEFAULT_RENDERED_GROUPS,
  MAX_RENDERED_GROUPS,
  type ArchitectureControlsMessage,
  type ArchitectureExtensionMessage,
  type ArchitectureFolderLevelMessage,
  type ArchitectureFoundMessage,
  type ArchitectureMatrixMessage,
  type ArchitectureStateMessage,
  type ArchitectureSummaryMessage,
} from "../../src/shared/architecture-types";
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

/** A real edit: its mtime is after any build started so far. */
function touch(root: string, relative: string): Promise<void> {
  const later = new Date(Date.now() + 1000);
  return fs.utimes(path.join(root, relative), later, later);
}

describe("ArchitectureViewService", () => {
  let root: string;
  let posted: ArchitectureExtensionMessage[];
  let communityMode: CommunityMode;
  let opened: string[];
  let revealed: string[];
  let settingsOpened: boolean[];
  let warnings: string[];

  const summaries = () => posted.filter((message): message is ArchitectureSummaryMessage => message.type === "architectureSummary");
  const states = () => posted.filter(message => message.type === "architectureState");
  /** Lets a build subscribe to the index status: it does once the startup index settled. */
  const subscribed = () => new Promise<void>(resolve => setImmediate(resolve));
  const createService = (overrides: Partial<ArchitectureViewServiceOptions> = {}) =>
    new ArchitectureViewService({
      workspaceRoot: root,
      analyzeFile: analyzerFor(root, workspace),
      isResolverConfig: (filePath) => /tsconfig[^\\/]*\.json$/.test(filePath) || filePath.endsWith("base.json"),
      readCommunityMode: () => communityMode,
      subscribeToIndexStatus: (callback) => {
        callback(idle);
        return () => {};
      },
      whenStartupIndexSettled: async () => {},
      post: (message) => posted.push(message),
      openFile: async (absolutePath) => {
        opened.push(absolutePath);
      },
      revealInFileGraph: async (absolutePath) => {
        revealed.push(absolutePath);
      },
      openSettings: () => settingsOpened.push(true),
      warn: (message) => warnings.push(message),
      unresolvedImportersOf: () => [],
      ...overrides,
    });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-view-")));
    await writeWorkspace(root, workspace);
    posted = [];
    opened = [];
    revealed = [];
    settingsOpened = [];
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
      cycleUnits: [],
    });
  });

  it("sends the units of each cycle, from the cycle edges, as one entry", async () => {
    // a ↔ b form a cycle; c depends on a only.
    const cyclic = { "a/x.ts": ["b/y.ts"], "b/y.ts": ["a/x.ts"], "c/z.ts": ["a/x.ts"] };
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-cycle-")));
    try {
      await writeWorkspace(other, cyclic);
      await createService({ workspaceRoot: other, analyzeFile: analyzerFor(other, cyclic) }).build();
      const units = summaries()[0].units!;
      expect(units.cycles).toBe(1);
      expect(units.cycleUnits?.map((members) => members.toSorted())).toEqual([["a", "b"]]);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("opens the settings for the empty state's action", async () => {
    await createService().handleWebviewMessage({ command: "architectureOpenSettings" });
    expect(settingsOpened).toEqual([true]);
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
    await touch(root, "src/ui/view.ts");
    service.markStale(path.join(root, "src/ui/view.ts"), "change");
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);

    await service.build();
    service.markStale(path.join(root, "src/new.ts"), "create");
    expect(summaries().at(-1)?.stale).toBe(true);
  });

  // #431: an extends target named base.json is not in the graph, yet it changes how imports resolve.
  it("marks stale for a resolver config the graph does not contain, and not for another JSON file", async () => {
    const service = createService();
    await service.build();
    service.markStale(path.join(root, "data.json"), "change");
    service.markStale(path.join(root, "data.json"), "create");
    service.markStale(path.join(root, "data.json"), "delete");
    expect(summaries()).toHaveLength(1);
    service.markStale(path.join(root, "config", "base.json"), "change");
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);
  });

  // macOS delivers watcher events late: after the Refresh that already read those files.
  it("ignores late create and change events for content written before the build", async () => {
    await fs.writeFile(path.join(root, "src/late.ts"), "export const late = 1;\n");
    const earlier = new Date(Date.now() - 1000);
    for (const file of ["src/late.ts", "src/ui/view.ts"]) await fs.utimes(path.join(root, file), earlier, earlier);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const analyze = analyzerFor(root, workspace);
    const service = createService({ analyzeFile: async (filePath) => { await gate; return analyze(filePath); } });
    const running = service.build();
    service.markStale(path.join(root, "src/late.ts"), "create");
    release();
    await running;
    service.markStale(path.join(root, "src/late.ts"), "create");
    service.markStale(path.join(root, "src/ui/view.ts"), "change");
    expect(summaries().map(summary => summary.stale)).toEqual([false]);
    await fs.rm(path.join(root, "src/ui/view.ts"));
    service.markStale(path.join(root, "src/ui/view.ts"), "delete");
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);
  });

  it("still marks stale for a late create that indexed files import unresolved (#387)", async () => {
    await fs.writeFile(path.join(root, "src/late.ts"), "export const late = 1;\n");
    const earlier = new Date(Date.now() - 1000);
    await fs.utimes(path.join(root, "src/late.ts"), earlier, earlier);
    const late = path.join(root, "src/late.ts");
    const service = createService({ unresolvedImportersOf: (filePath) => (filePath === late ? [path.join(root, "main.ts")] : []) });
    await service.build();
    service.markStale(late, "create");
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);
  });

  // #478: macOS sends a package.json write's change event late; the re-index it may start marks the view stale itself.
  it("marks stale for a resolver config written after the build, not for a late event of one written before", async () => {
    const config = path.join(root, "packages/app/tsconfig.json");
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, "{}");
    const earlier = new Date(Date.now() - 1000);
    await fs.utimes(config, earlier, earlier);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const analyze = analyzerFor(root, workspace);
    const service = createService({ analyzeFile: async (filePath) => { await gate; return analyze(filePath); } });
    const running = service.build();
    service.markStale(config, "change");
    release();
    await running;
    service.markStale(config, "create");
    expect(summaries().map(summary => summary.stale)).toEqual([false]);

    await touch(root, "packages/app/tsconfig.json");
    service.markStale(config, "change");
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);
  });

  it("marks stale when an index run starts after the build read the index, not while the build waits for it", async () => {
    const listeners: ((snapshot: IndexerStatusSnapshot) => void)[] = [];
    const service = createService({
      subscribeToIndexStatus: (callback) => {
        listeners.push(callback);
        callback({ state: listeners.length === 1 ? "counting" : "indexing" } as IndexerStatusSnapshot);
        return () => listeners.splice(listeners.indexOf(callback), 1);
      },
    });
    const notify = (state: IndexerStatusSnapshot["state"]) => [...listeners].forEach(listener => listener({ state } as IndexerStatusSnapshot));

    const waiting = service.build();
    await subscribed();
    notify("counting");
    notify("complete");
    await waiting;
    expect(summaries().map(summary => summary.stale)).toEqual([false]);

    notify("indexing");
    expect(summaries()).toHaveLength(1);
    notify("counting");
    expect(summaries().map(summary => summary.stale)).toEqual([false, true]);

    service.dispose();
    expect(listeners).toEqual([]);
  });

  /** A service whose builds read once `release` is called; `notify` sends an index state to its own subscription. */
  const gatedService = () => {
    let notify!: (snapshot: IndexerStatusSnapshot) => void;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const analyze = analyzerFor(root, workspace);
    const service = createService({
      analyzeFile: async (filePath) => { await gate; return analyze(filePath); },
      subscribeToIndexStatus: (callback) => {
        notify ??= callback;
        callback(idle);
        return () => {};
      },
    });
    return { service, release, notify: (state: IndexerStatusSnapshot["state"]) => notify({ state } as IndexerStatusSnapshot) };
  };

  it("carries an index run that starts while the build reads into its summary", async () => {
    const { service, release, notify } = gatedService();
    const running = service.build();
    await subscribed();
    notify("counting");
    release();
    await running;
    expect(summaries().map(summary => summary.stale)).toEqual([true]);
  });

  // The startup index run started while the mount's build read; Refresh replaced that build and read after the run.
  it("does not carry an aborted build's index run into the next build", async () => {
    const { service, release, notify } = gatedService();
    const aborted = service.build();
    await subscribed();
    notify("counting");
    const next = service.build();
    release();
    await Promise.all([aborted, next]);
    expect(summaries().map(summary => summary.stale)).toEqual([false]);
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
    await touch(root, "src/store/state.ts");
    next.markStale(path.join(root, "src/store/state.ts"), "change");
    release();
    await second;
    expect(summaries().at(-1)?.stale).toBe(true);
  });

  it("keeps the largest groups of each unit, and the layers and edge kinds inside units", async () => {
    const big = MAX_RENDERED_GROUPS + 2;
    const many = Object.fromEntries([
      // big/d0 imports big/d1 and small/x: every other big folder has no import.
      ...Array.from({ length: big }, (_, index) => [`big/d${index}/a.ts`, index === 0 ? ["big/d1/a.ts", "small/x/a.ts"] : []]),
      ["small/x/a.ts", ["small/y/a.ts"]],
      ["small/y/a.ts", ["small/x/a.ts"]],
    ]);
    const wide = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-units-")));
    try {
      await writeWorkspace(wide, many);
      await createService({ workspaceRoot: wide, analyzeFile: analyzerFor(wide, many) }).build();
      const [summary] = summaries();
      const unitOf = summary.units!.groupUnits;
      expect(summary.groups.filter(group => unitOf[group.id] === "big")).toHaveLength(DEFAULT_RENDERED_GROUPS);
      expect(summary.groups.filter(group => unitOf[group.id] === "small")).toHaveLength(2);
      expect(summary.maxGroups).toBe(DEFAULT_RENDERED_GROUPS);
      expect(summary.hiddenGroups).toBe(big - DEFAULT_RENDERED_GROUPS);
      expect(summary.units!.groupsByUnit).toEqual({
        big: { totalGroups: big, hiddenGroups: big - DEFAULT_RENDERED_GROUPS, hiddenGroupEdges: 0 },
        small: { totalGroups: 2, hiddenGroups: 0, hiddenGroupEdges: 0 },
      });
      const id = (key: string) => summary.groups.find(group => group.key === key)!.id;
      expect(summary.units!.groupLayers[id("big/d0")]).toBe(1);
      expect(summary.units!.groupEdgeKinds[`${id("small/x")}>${id("small/y")}`]).toBe("cycle");
      // The d0 → x edge crosses units: only d0 → d1 links big folders, so the other drawn ones are isolated.
      expect(summary.isolatedGroups).toHaveLength(DEFAULT_RENDERED_GROUPS - 2);
      expect(summary.isolatedGroups).not.toContain(id("big/d0"));
      expect(summary.isolatedGroups).not.toContain(id("small/x"));
    } finally {
      await fs.rm(wide, { recursive: true, force: true });
    }
  });

  it("marks groups without a drawn edge isolated, the unassigned files included (louvain)", async () => {
    communityMode = "louvain";
    await createService().build();
    const [summary] = summaries();
    // main.ts → ui → store: one Louvain group per import chain, no file left unassigned.
    expect(summary.unassigned.fileCount).toBe(0);
    expect(summary.isolatedGroups).toEqual(summary.groups.filter(group => !summary.groupEdges.some(edge => edge.from === group.id || edge.to === group.id)).map(group => group.id));

    const lonely = { ...workspace, "readme.ts": [] };
    const root2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-lonely-")));
    try {
      await writeWorkspace(root2, lonely);
      await createService({ workspaceRoot: root2, analyzeFile: analyzerFor(root2, lonely) }).build();
      const withLonely = summaries().at(-1)!;
      expect(withLonely.unassigned.fileCount).toBe(1);
      expect(withLonely.isolatedGroups).toContain(0);
    } finally {
      await fs.rm(root2, { recursive: true, force: true });
    }
  });

  it("finds hidden groups by label or key, and Show more groups sends the summary and entered levels again", async () => {
    const many = Object.fromEntries(Array.from({ length: MAX_RENDERED_GROUPS + 2 }, (_, index) => [`big/d${index}/a.ts`, []]));
    const wide = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-more-")));
    try {
      await writeWorkspace(wide, many);
      const service = createService({ workspaceRoot: wide, analyzeFile: analyzerFor(wide, many) });
      await service.build();
      const [summary] = summaries();
      const { revision } = summary;
      const found = () => posted.filter((message): message is ArchitectureFoundMessage => message.type === "architectureFound").at(-1);

      await service.handleWebviewMessage({ command: "architectureFind", revision, unit: "big", query: " BIG/ " });
      expect(found()).toMatchObject({ revision, unit: "big", query: " BIG/ ", total: summary.hiddenGroups });
      expect(found()?.matches).toHaveLength(10);
      await service.handleWebviewMessage({ command: "architectureFind", revision, unit: "small", query: "big/" });
      expect(found()?.total).toBe(0);
      await service.handleWebviewMessage({ command: "architectureFind", revision, query: "  " });
      expect(found()?.total).toBe(0);
      await service.handleWebviewMessage({ command: "architectureFind", revision: "old", query: "big" });
      expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: revision });

      // An entered folder is sent again too, with the new cap.
      await service.handleWebviewMessage({ command: "architectureEnterFolder", revision, folder: "big" });
      posted.length = 0;
      await service.handleWebviewMessage({ command: "architectureShowMoreGroups", revision });
      const [more, folder] = posted as [ArchitectureSummaryMessage, ArchitectureFolderLevelMessage];
      expect(more).toMatchObject({ type: "architectureSummary", revision, stale: false, maxGroups: MAX_RENDERED_GROUPS, hiddenGroups: 2 });
      expect(more.groups).toHaveLength(MAX_RENDERED_GROUPS);
      expect(folder).toMatchObject({ type: "architectureFolderLevel", revision, folder: "big" });
      expect(folder.level.maxGroups).toBe(MAX_RENDERED_GROUPS);
      await service.handleWebviewMessage({ command: "architectureFind", revision, unit: "big", query: "big/" });
      expect(found()?.total).toBe(2);

      posted.length = 0;
      await service.handleWebviewMessage({ command: "architectureShowMoreGroups", revision });
      expect(posted).toEqual([]);
      // The cap stays raised for the next builds.
      await service.build();
      expect(summaries().at(-1)?.maxGroups).toBe(MAX_RENDERED_GROUPS);
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

  it("answers the matrix of the units, of an entered unit and of a folder, read from that level's graph", async () => {
    const service = createService();
    await service.build();
    const [summary] = summaries();
    const matrixOf = async (request: { folder?: string; unit?: string; revision?: string }) => {
      await service.handleWebviewMessage({ command: "architectureMatrix", revision: summary.revision, ...request });
      return posted.at(-1) as ArchitectureMatrixMessage;
    };

    // (root) imports src: src (layer 0) comes first, and its two internal pairs sit on the diagonal.
    const units = await matrixOf({});
    expect(units).toMatchObject({ type: "architectureMatrix", revision: summary.revision, nestedGroups: [], digest: "(root)>src=1;src>src=2" });
    expect(units.matrix.rows.map(row => [row.id, row.label])).toEqual([["src", "src"], ["(root)", "(root)"]]);
    expect(units.matrix.cells).toEqual([{ row: 0, column: 0, fileEdgeCount: 2, upward: false }, { row: 1, column: 0, fileEdgeCount: 1, upward: false }]);

    // Inside src: the summary's group ids, named within the unit; ui imports store twice.
    const inside = await matrixOf({ unit: "src" });
    const id = (key: string) => summary.groups.find(group => group.key === key)!.id;
    expect(inside).toMatchObject({ unit: "src", folder: undefined });
    expect(inside.matrix.rows.map(row => [row.id, row.label])).toEqual([[id("src/store"), "store"], [id("src/ui"), "ui"]]);
    expect(inside.matrix.cells).toEqual([{ row: 1, column: 0, fileEdgeCount: 2, upward: false }]);

    await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: summary.revision, folder: "src/ui" });
    const level = (posted.at(-1) as ArchitectureFolderLevelMessage).level;
    const folder = await matrixOf({ revision: level.revision, folder: "src/ui", unit: "src" });
    expect(folder.matrix.rows.map(row => [row.key, row.label])).toEqual([["src/ui", "ui"]]);
    expect(folder.matrix.cells).toEqual([]);

    await service.handleWebviewMessage({ command: "architectureMatrix", revision: "old" });
    expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: summary.revision });
  });

  it("answers the matrix of every group in Louvain mode", async () => {
    communityMode = "louvain";
    const service = createService();
    await service.build();
    const [summary] = summaries();
    await service.handleWebviewMessage({ command: "architectureMatrix", revision: summary.revision });
    const { matrix } = posted.at(-1) as ArchitectureMatrixMessage;
    expect(matrix.totals.fileEdges).toBe(summary.totals.fileEdges);
    expect(matrix.rows).toHaveLength(summary.groups.length + (summary.unassigned.fileCount > 0 ? 1 : 0));
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
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0)); // files are analyzed in parallel: the first one holds the build
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
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0)); // files are analyzed in parallel: the first one holds the build
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
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0)); // files are analyzed in parallel: the first one holds the build
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
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0)); // files are analyzed in parallel: the first one holds the build
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
      // The reason names the folder and the exclusions; the webview offers Open settings.
      expect((posted.at(-1) as ArchitectureStateMessage).message).toBe(
        `No supported source file in "${path.basename(empty)}". Files excluded by .graphitignore or the Graph-It-Live settings are not analysed.`);
      expect(summaries()).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("posts error when the build throws, and Retry builds again", async () => {
    let fail = false;
    const service = createService({
      subscribeToIndexStatus: (callback) => {
        if (fail) throw new Error("index unavailable");
        callback(idle);
        return () => {};
      },
    });

    fail = true;
    await service.build();
    expect(posted.at(-1)).toEqual({ type: "architectureState", status: "error", message: "index unavailable" });

    let subscriptions = 0;
    // The service's own subscription succeeds; the build's throws.
    const leaking = createService({
      subscribeToIndexStatus: () => {
        subscriptions += 1;
        if (subscriptions > 1) throw new Error(`EACCES: scandir '${root}/src'`);
        return () => {};
      },
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
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0)); // files are analyzed in parallel: the first one holds the build
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
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0)); // files are analyzed in parallel: the first one holds the build
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

    // listeners[0] is the service's own subscription.
    const first = service.build();
    await subscribed();
    const second = service.build();
    await first;
    await subscribed();
    listeners[2](idle);
    await second;
    expect(posted.at(-1)?.type).toBe("architectureSummary");
    listeners[1]({ state: "indexing" } as IndexerStatusSnapshot);

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

  /** A service whose builds wait for `settle`, as for the startup index; `notify` sends an index state to the build's subscription. */
  const startupGatedService = (initialState: IndexerStatusSnapshot["state"] = "idle") => {
    let settle!: () => void;
    let notify!: (state: IndexerStatusSnapshot["state"]) => void;
    const startup = new Promise<void>(resolve => { settle = resolve; });
    const analyzeFile = vi.fn(analyzerFor(root, workspace));
    const service = createService({
      analyzeFile,
      whenStartupIndexSettled: () => startup,
      subscribeToIndexStatus: (callback) => {
        notify = (state) => callback({ state } as IndexerStatusSnapshot);
        notify(initialState);
        return () => {};
      },
    });
    return { service, analyzeFile, settle, notify: (state: IndexerStatusSnapshot["state"]) => notify(state) };
  };

  // #433: the index status reads idle while the startup index is scheduled; a build reading then is stale once it starts.
  it("waits for the startup index to settle before reading, and stops waiting when disposed", async () => {
    const { service, analyzeFile, settle } = startupGatedService();

    const build = service.build();
    await subscribed();
    expect(analyzeFile).not.toHaveBeenCalled();
    settle();
    await build;
    expect(summaries().map(summary => summary.stale)).toEqual([false]);

    const pending = startupGatedService().service;
    const waiting = pending.build();
    pending.dispose();
    await waiting;
    expect(summaries()).toHaveLength(1);
  });

  it("reads once the startup index settled and the index run it started finished", async () => {
    const { service, analyzeFile, settle, notify } = startupGatedService("indexing");

    const build = service.build();
    settle();
    await subscribed();
    expect(analyzeFile).not.toHaveBeenCalled();
    notify("complete");
    await build;
    expect(summaries().map(summary => summary.stale)).toEqual([false]);
  });

  it("reads once for the build that replaced one waiting for the startup index", async () => {
    const { service, analyzeFile, settle } = startupGatedService();

    const replaced = service.build();
    const next = service.build();
    settle();
    await Promise.all([replaced, next]);
    expect(new Set(analyzeFile.mock.calls.map(([file]) => file)).size).toBe(analyzeFile.mock.calls.length);
    expect(summaries()).toHaveLength(1);
  });

  it("shows the indexing wait while the startup index runs, then reads once both settled", async () => {
    const { service, analyzeFile, settle, notify } = startupGatedService();

    const build = service.build();
    notify("counting");
    expect(states().at(-1)?.message).toBe("Waiting for indexing to finish…");
    notify("complete");
    await subscribed();
    expect(analyzeFile).not.toHaveBeenCalled();
    settle();
    await build;
    expect(summaries().map(summary => summary.stale)).toEqual([false]);
  });

  it("reports an error when waiting for the startup index fails", async () => {
    const service = createService({ whenStartupIndexSettled: () => Promise.reject(new Error("startup failed")) });
    await service.build();
    expect(summaries()).toEqual([]);
    expect(states().at(-1)?.status).toBe("error");
  });

  it("reports progress as a percentage of analysed files", async () => {
    await createService().build();
    expect(states().some(state => state.message === "Waiting for indexing to finish…")).toBe(false);
    expect(states().some(state => state.percent !== undefined && state.percent > 0)).toBe(true);
    expect(states().find(state => state.percent !== undefined)?.message).toMatch(/^Building architecture: \d+ of 4 files$/);
  });

  // 400 files through Louvain: ~3 s on Windows runners, over the 5 s default once (VS Code 1.143.1 compatibility run).
  it("caps rendered louvain groups at 50, keeps totals from the full aggregation, and sends every unit-scoped group", { timeout: 30_000 }, async () => {
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
      expect(summary.groups).toHaveLength(DEFAULT_RENDERED_GROUPS);
      expect(summary.hiddenGroups).toBe(groups - DEFAULT_RENDERED_GROUPS);
      expect(summary.hiddenGroupEdges).toBe(0);
      expect(summary.totals.files).toBe(2 * groups);
      // No import crosses two groups: every drawn group is isolated.
      expect(summary.isolatedGroups).toHaveLength(DEFAULT_RENDERED_GROUPS);

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

    const rendered = {
      command: "architectureRendered" as const,
      revision: "abc",
      renderedGroups: 3,
      renderedGroupEdges: 2,
      communityMode: "path" as const,
      stale: true,
      overlappingGroups: 1,
      overflowingLabels: 2,
      positions: "path:ui@0,0",
    };
    await service.handleWebviewMessage(rendered);
    expect(service.getE2EState()).toEqual({
      buildCount: 0, renderCount: 1, groupCount: 3, groupEdgeCount: 2, revision: "abc", communityMode: "path", stale: true,
      overlappingGroups: 1, overflowingLabels: 2, positions: "path:ui@0,0", unit: undefined, folder: undefined, unitLevel: undefined,
      violationEdges: 0, rules: [], roles: [], resizeCount: 0, viewSize: { width: 0, height: 0 },
      interactionCount: 0, interaction: null, detailCount: 0, detail: null, matrixCount: 0, matrix: null, dependents: null,
      // The whole report too, for the measures without a key of their own (header height, zoom…).
      rendered,
    });

    const painted = {
      command: "architectureMatrixRendered" as const, revision: "abc", rows: 2, cells: 3, fileEdges: 5, upwardCells: 1, cycles: 1,
      renderedCells: 3, digest: "a>b=1", paintMs: 12, cause: "matrix" as const,
    };
    await service.handleWebviewMessage(painted);
    expect(service.getE2EState()).toMatchObject({ renderCount: 1, matrixCount: 1, matrix: painted });
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

    service.setControls({ view: "matrix", matrixCell: { row: "src", column: "(root)" }, matrixHeader: "src" });
    expect(posted.at(-1)).toMatchObject({ view: "matrix", matrixCell: { row: "src", column: "(root)" }, matrixHeader: "src" });
    service.setControls({ view: "table", matrixCell: { row: "src", column: 3 }, matrixHeader: 4 } as never);
    expect(posted.at(-1)).toMatchObject({ view: undefined, matrixCell: undefined, matrixHeader: undefined });
    // Canvas controls: zoom actions, navigation keys (at most 20), a legend unit and the cycle count, nothing else.
    service.setControls({ zoom: "fit", keys: ["Tab", "ArrowDown", "Enter", "x"], legendUnit: "src", cycleCount: true });
    expect(posted.at(-1)).toMatchObject({ zoom: "fit", keys: ["ArrowDown", "Enter"], legendUnit: "src", cycleCount: true });
    service.setControls({ zoom: "spin", keys: "ArrowDown", legendUnit: 3, cycleCount: "yes" } as never);
    expect(posted.at(-1)).toMatchObject({ zoom: undefined, keys: undefined, legendUnit: undefined, cycleCount: undefined });
    service.setControls({ keys: Array.from({ length: 30 }, () => "0") });
    expect((posted.at(-1) as ArchitectureControlsMessage).keys).toHaveLength(20);
    service.setControls({ dependentsOf: "src/ui", revealFile: "main.ts", clearDependents: true });
    expect(posted.at(-1)).toMatchObject({ dependentsOf: "src/ui", revealFile: "main.ts", clearDependents: true });
    service.setControls({ dependentsOf: 1, revealFile: "x".repeat(300), clearDependents: "yes" } as never);
    expect(posted.at(-1)).toMatchObject({ dependentsOf: undefined, revealFile: "x".repeat(256), clearDependents: undefined });
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
    ])("refuses %s without opening, revealing or walking anything", async (_name, relativePath) => {
      const { service, revision } = await built();
      const count = posted.length;
      await service.handleWebviewMessage({ command: "architectureOpenFile", revision, relativePath });
      await service.handleWebviewMessage({ command: "architectureRevealInFileGraph", revision, relativePath });
      await service.handleWebviewMessage({ command: "architectureDependents", revision, unit: "src", seed: { kind: "file", relativePath } });
      expect(opened).toEqual([]);
      expect(revealed).toEqual([]);
      expect(posted).toHaveLength(count);
      expect(warnings).toEqual([
        expect.stringContaining("refused to open a file"),
        expect.stringContaining("refused to open a file"),
        expect.stringContaining("not a file of the architecture graph"),
      ]);
      expect(warnings[0]).not.toContain(root);
    });

    it("reveals a file of the graph in the file Dependency Graph, Windows separators included", async () => {
      const { service, revision } = await built();
      await service.handleWebviewMessage({ command: "architectureRevealInFileGraph", revision, relativePath: String.raw`src\ui\view.ts` });
      expect(revealed).toEqual([path.join(root, "src/ui/view.ts")]);
      expect(opened).toEqual([]);
      await service.handleWebviewMessage({ command: "architectureRevealInFileGraph", revision: "old", relativePath: "main.ts" });
      expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: revision });
      expect(revealed).toHaveLength(1);
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

    describe("dependents by group", () => {
      it("groups the dependents of a unit by unit at the units level", async () => {
        const { service, revision } = await built();
        await service.handleWebviewMessage({ command: "architectureDependents", revision, seed: { kind: "unit", key: "src" } });
        expect(posted.at(-1)).toEqual({
          type: "architectureDependentsResult", revision, folder: undefined, unit: undefined, seed: { kind: "unit", key: "src" },
          seedLabel: "src", seedGroups: ["src"], reachedFiles: 1, totals: { files: 1, groups: 1 },
          groups: [{ key: "(root)", label: "(root)", directFiles: 1, transitiveFiles: 1, minDepth: 1 }],
          insideSeedGroup: { directFiles: 0, transitiveFiles: 0 }, maxDepthReached: false,
          provenance: expect.stringContaining("Static import relations only"),
        });
      });

      it("groups the dependents of a group or a file by the summary's groups inside a unit, and pages a group's files", async () => {
        const { service, revision } = await built();
        const expected = {
          seedGroups: ["src/store"], reachedFiles: 3,
          groups: [
            { key: "src/ui", label: "src/ui", directFiles: 2, transitiveFiles: 2, minDepth: 1 },
            { key: "(root)", label: "(root)", directFiles: 0, transitiveFiles: 1, minDepth: 2 },
          ],
          insideSeedGroup: { directFiles: 0, transitiveFiles: 0 },
        };
        await service.handleWebviewMessage({ command: "architectureDependents", revision, unit: "src", seed: { kind: "group", groupId: 2 } });
        expect(posted.at(-1)).toMatchObject({ unit: "src", seedLabel: "src/store", ...expected });
        await service.handleWebviewMessage({ command: "architectureDependents", revision, unit: "src", seed: { kind: "file", relativePath: "src/store/state.ts" } });
        expect(posted.at(-1)).toMatchObject({ seedLabel: "src/store/state.ts", ...expected });

        const seed = { kind: "group" as const, groupId: 2 };
        await service.handleWebviewMessage({ command: "architectureDependentFiles", revision, unit: "src", seed, groupKey: "src/ui" });
        expect(posted.at(-1)).toEqual({
          type: "architectureDependentFilesPage", revision, folder: undefined, unit: "src", seed, groupKey: "src/ui",
          files: [{ relativePath: "src/ui/form.ts", depth: 1 }, { relativePath: "src/ui/view.ts", depth: 1 }],
          page: { total: 2, offset: 0, returned: 2, truncated: false, nextOffset: undefined },
        });
        await service.handleWebviewMessage({ command: "architectureDependentFiles", revision, unit: "src", seed, groupKey: "src/ui", offset: 1 });
        expect(posted.at(-1)).toMatchObject({ files: [{ relativePath: "src/ui/view.ts" }], page: { offset: 1, returned: 1 } });
      });

      it("answers a stale revision with the current one, an empty seed with no dependents, and logs an unknown seed kind", async () => {
        const { service, revision } = await built();
        await service.handleWebviewMessage({ command: "architectureDependents", revision: "old", seed: { kind: "unit", key: "src" } });
        expect(posted.at(-1)).toEqual({ type: "architectureRevisionChanged", currentRevision: revision });
        // The panel never waits: an unknown group or unit answers with nothing reached.
        await service.handleWebviewMessage({ command: "architectureDependents", revision, seed: { kind: "group", groupId: 99 } });
        expect(posted.at(-1)).toMatchObject({ seedLabel: "group 99", seedGroups: [], reachedFiles: 0, groups: [] });
        await service.handleWebviewMessage({ command: "architectureDependents", revision, seed: { kind: "unit", key: "nowhere" } });
        expect(posted.at(-1)).toMatchObject({ seedLabel: "nowhere", reachedFiles: 0, groups: [] });
        await service.handleWebviewMessage({ command: "architectureDependentFiles", revision, seed: { kind: "unit", key: "nowhere" }, groupKey: "src" });
        expect(posted.at(-1)).toMatchObject({ files: [], page: { total: 0 } });
        const count = posted.length;
        await service.handleWebviewMessage({ command: "architectureDependents", revision, seed: { kind: "symbol" } } as never);
        expect(posted).toHaveLength(count);
        expect(warnings).toEqual(["Architecture view: unknown dependents seed"]);
      });

      it("has no unit seed in Louvain mode", async () => {
        communityMode = "louvain";
        const { service, revision } = await built();
        await service.handleWebviewMessage({ command: "architectureDependents", revision, seed: { kind: "unit", key: "src" } });
        expect(warnings).toEqual(["Architecture view: unknown dependents seed"]);
        await service.handleWebviewMessage({ command: "architectureDependents", revision, seed: { kind: "file", relativePath: "src/store/state.ts" } });
        expect(posted.at(-1)).toMatchObject({ type: "architectureDependentsResult", reachedFiles: 3 });
      });

      it("groups an entered folder's dependents by its groups, and the files outside it by the summary's", async () => {
        const nested = {
          "app/src/core/engine.ts": ["app/src/core/util/math.ts", "app/src/ui/view.ts"],
          "app/src/core/util/math.ts": [],
          "app/src/ui/view.ts": ["app/src/core/util/math.ts"],
        };
        const deep = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-dependents-")));
        try {
          await writeWorkspace(deep, nested);
          const service = createService({ workspaceRoot: deep, analyzeFile: analyzerFor(deep, nested) });
          await service.build();
          const [summary] = summaries();
          await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: summary.revision, folder: "app/core" });
          const { level } = posted.at(-1) as ArchitectureFolderLevelMessage;
          const util = level.groups.find((group) => group.key === "app/core/util")!.id;
          await service.handleWebviewMessage({
            command: "architectureDependents", revision: level.revision, folder: "app/core", unit: "app", seed: { kind: "group", groupId: util },
          });
          expect(posted.at(-1)).toMatchObject({
            folder: "app/core", seedLabel: "app/core/util", seedGroups: ["app/core/util"],
            groups: [
              { key: "app/core", directFiles: 1, transitiveFiles: 1, minDepth: 1 },
              { key: "app/ui", directFiles: 1, transitiveFiles: 1, minDepth: 1 },
            ],
          });
        } finally {
          await fs.rm(deep, { recursive: true, force: true });
        }
      });

      it("keeps the dependents render for E2E", async () => {
        const { service } = await built();
        const rendered = { command: "architectureDependentsRendered" as const, seedLabel: "src", rows: ["(root)=1/1@1"], highlightedGroups: 1, view: "graph" as const };
        await service.handleWebviewMessage(rendered);
        expect(service.getE2EState().dependents).toEqual(rendered);
      });
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

describe("writtenBefore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "written-before-"));
    await fs.writeFile(path.join(dir, "a.ts"), "");
    await fs.utimes(path.join(dir, "a.ts"), new Date(1000), new Date(1000));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is true for a create or change of content older than the build start", () => {
    expect(writtenBefore(path.join(dir, "a.ts"), "change", 2000)).toBe(true);
    expect(writtenBefore(path.join(dir, "a.ts"), "create", 2000)).toBe(true);
  });

  it("is false for content written at or after the build start", () => {
    expect(writtenBefore(path.join(dir, "a.ts"), "change", 1000)).toBe(false);
  });

  it("is false for a deletion, a missing file, no path or no build", () => {
    expect(writtenBefore(path.join(dir, "a.ts"), "delete", 2000)).toBe(false);
    expect(writtenBefore(path.join(dir, String.raw`missing\b.ts`), "create", 2000)).toBe(false);
    expect(writtenBefore(undefined, "change", 2000)).toBe(false);
    expect(writtenBefore(path.join(dir, "a.ts"), "change", undefined)).toBe(false);
  });
});
