import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "../../../src/analyzer/Parser";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import { PathResolver } from "../../../src/analyzer/utils/PathResolver";
import { run as runArchitectureCli } from "../../../src/cli/commands/architecture";
import { ArchitectureViewService } from "../../../src/extension/services/ArchitectureViewService";
import { workerState } from "../../../src/mcp/shared/state";
import { executeExploreArchitecture } from "../../../src/mcp/tools/architecture";
import type { IndexerStatusSnapshot } from "../../../src/analyzer/IndexerStatus";
import type {
  ArchitectureExtensionMessage,
  ArchitectureFolderLevelMessage,
  ArchitectureSummaryMessage,
} from "../../../src/shared/architecture-types";

// Golden output of `graph-it architecture --folder` on a workspace nested three folders deep below
// its unit: the CLI, explore_architecture and the extension's view must report the same levels.
// Generated here, not under tests/fixtures: that folder is the E2E workspace, whose counts it would change.
const NESTED_WORKSPACE: Record<string, string> = {
  "app/src/main.ts": 'import { start } from "./core/engine";\nimport { render } from "./ui/view";\n\nexport const main = () => render(start());\n',
  "app/src/core/engine.ts": 'import { add } from "./util/math";\nimport { render } from "../ui/view";\n\nexport const start = () => add(1, 2);\nexport const redraw = () => render(start());\n',
  "app/src/core/util/math.ts": 'import { ZERO } from "./deep/consts";\n\nexport const add = (a: number, b: number) => a + b + ZERO;\n',
  "app/src/core/util/deep/consts.ts": "export const ZERO = 0;\n",
  "app/src/ui/view.ts": 'import { add } from "../core/util/math";\n\nexport const render = (value: number) => String(add(value, 0));\n',
  "app/src/ui/widgets/button.ts": 'import { render } from "../view";\nimport { log } from "../../../../lib/log";\n\nexport const button = () => log(render(1));\n',
  "app/tests/core/engine.test.ts": 'import { start } from "../../src/core/engine";\n\nexport const check = () => start() === 3;\n',
  "lib/log.ts": "export const log = (message: string) => message;\n",
};
let rootDir: string;
const runtime = { get workspaceRoot() { return rootDir; }, ensureIndexed: async () => undefined, loadState: () => null };
const folders = ["app", "app/core", "app/core/util", "app/ui"];

interface Group { id: number; key: string; fileCount: number; internalEdgeCount: number }
interface Edge { from: number; to: number; fileEdgeCount: number }

/** Groups and edges by key, so levels compare whatever the order and labels. */
function byKey({ groups, groupEdges, nestedGroups }: { groups: Group[]; groupEdges: Edge[]; nestedGroups: number[] }) {
  const keyOf = new Map(groups.map((group) => [group.id, group.key]));
  return {
    groups: groups.map((group) => `${group.key} ${group.fileCount} files ${group.internalEdgeCount} internal`).sort(),
    groupEdges: groupEdges.map((edge) => `${keyOf.get(edge.from)} > ${keyOf.get(edge.to)} ${edge.fileEdgeCount}`).sort(),
    nested: nestedGroups.map((id) => keyOf.get(id)).sort(),
  };
}

async function viewLevels(): Promise<Map<string, ArchitectureFolderLevelMessage>> {
  const posted: ArchitectureExtensionMessage[] = [];
  const service = new ArchitectureViewService({
    workspaceRoot: rootDir,
    analyzeFile: (filePath) => workerState.getSpider().analyze(filePath),
    readCommunityMode: () => "path",
    subscribeToIndexStatus: (callback) => {
      callback({ state: "idle" } as IndexerStatusSnapshot);
      return () => {};
    },
    post: (message) => posted.push(message),
    openFile: async () => {},
    warn: () => {},
  });
  await service.build();
  const summary = posted.find((message): message is ArchitectureSummaryMessage => message.type === "architectureSummary")!;
  for (const folder of folders) await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: summary.revision, folder });
  const levels = posted.filter((message): message is ArchitectureFolderLevelMessage => message.type === "architectureFolderLevel");
  return new Map(levels.map((message) => [message.folder, message]));
}

describe("architecture folder levels golden output: nested workspace", () => {
  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-folders-")));
    for (const [relative, content] of Object.entries(NESTED_WORKSPACE)) {
      fs.mkdirSync(path.dirname(path.join(rootDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, relative), content);
    }
    workerState.parser = new Parser();
    workerState.resolver = new PathResolver(undefined, true, rootDir);
    workerState.spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).build();
    workerState.config = { rootDir, excludeNodeModules: true, maxDepth: 50 };
    workerState.isReady = true;
  });

  afterEach(() => {
    workerState.reset();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("matches the golden CLI, MCP and view levels", async () => {
    const view = await viewLevels();
    const golden: Record<string, unknown> = {};
    for (const folder of folders) {
      const cli = JSON.parse(await runArchitectureCli(["--folder", folder], runtime as never, "json"));
      const mcp = await executeExploreArchitecture({ folder, limit: 500 });
      const level = view.get(folder)!.level;
      expect(mcp.context.revision, folder).toBe(cli.context.revision);
      expect(level.revision, folder).toBe(cli.context.revision);
      expect(byKey(mcp as never), folder).toEqual(byKey(cli));
      expect(byKey({ ...level, nestedGroups: level.units!.nestedGroups }), folder).toEqual(byKey(cli));
      expect(mcp.totals, folder).toEqual(cli.totals);
      expect(level.totals, folder).toEqual(cli.totals);
      golden[folder] = { revision: cli.context.revision, totals: cli.totals, ...byKey(cli) };
    }
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot("__snapshots__/nested-workspace.folders.json");
  });

  it("walks evidence one level down: the file pairs behind a sibling folder edge", async () => {
    const level = await executeExploreArchitecture({ folder: "app", limit: 500 });
    const revision = level.context.revision;
    const evidence = await executeExploreArchitecture({ folder: "app", from: "app/ui", to: "app/core", revision });
    expect(evidence).toMatchObject({ view: "evidence", folder: "app" });
    expect((evidence as { pairs: unknown[] }).pairs).toEqual([{ source: "app/src/ui/view.ts", target: "app/src/core/util/math.ts" }]);
    // A folder level's ids hold for its own revision only.
    await expect(executeExploreArchitecture({ folder: "app/core", group: 1, revision })).rejects.toThrow("Architecture changed");
  });

  it("rejects --folder with --level units or Louvain, an empty --folder and an unknown folder", async () => {
    await expect(runArchitectureCli(["--folder", "app", "--level", "units"], runtime as never, "json")).rejects.toThrow("--folder lists one folder level");
    await expect(runArchitectureCli(["--folder", "app", "--communities", "louvain"], runtime as never, "json")).rejects.toThrow("--folder lists one folder level");
    await expect(runArchitectureCli(["--folder"], runtime as never, "json")).rejects.toThrow("--folder must be a unit or folder key");
    await expect(runArchitectureCli(["--folder", "nowhere"], runtime as never, "json")).rejects.toThrow('No file below folder "nowhere"');
  });
});
