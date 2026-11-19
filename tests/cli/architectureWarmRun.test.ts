import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { run as architecture } from "@/cli/commands/architecture";
import { run as checkArchitecture } from "@/cli/commands/checkArchitecture";
import { run as diagram } from "@/cli/commands/diagram";
import { run as summary } from "@/cli/commands/summary";
import type { CliError } from "@/cli/errors";
import { CliProgress } from "@/cli/progress";
import type { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { executeCheckArchitecture, executeExploreArchitecture, executeExportArchitectureDiagram } from "@/mcp/tools/architecture";
import { normalizePath } from "@/shared/path";
import { startRulesWorker } from "../analyzer/architecture/rulesWorkspace";

// #774: a warm run of the architecture commands re-parsed every file; the restored index already holds its imports.
describe("architecture commands on a restored index", { timeout: 60_000 }, () => {
  let root: string;
  let index: string;
  let runtime: CliRuntime;

  beforeEach(async () => {
    root = startRulesWorker();
    runtime = { workspaceRoot: root, progress: new CliProgress(false), ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState: () => null } as unknown as CliRuntime;
    const cold = newSpider();
    await cold.buildFullIndex();
    index = cold.getSerializedReverseIndex() ?? "";
    await cold.dispose();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    workerState.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The output without its timestamps: the MCP diagram is dated at the call. */
  const stable = (output: unknown) => JSON.stringify(output).replaceAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "TS");
  const newSpider = () => new SpiderBuilder().withRootDir(root).withExcludeNodeModules(true).withReverseIndex(true).build();

  const commands: Array<[string, () => Promise<unknown>]> = [
    // The workspace breaks its rules: the report comes with the failure.
    ["check-architecture", () => checkArchitecture([], runtime, "json").catch((error: CliError) => error.output)],
    ["summary", () => summary([], runtime, "json")],
    ["architecture", () => architecture([], runtime, "json")],
    ["diagram", () => diagram(["--output", "-"], runtime, "diagram-spec")],
    ["MCP check_architecture", () => executeCheckArchitecture({})],
    ["MCP explore_architecture", () => executeExploreArchitecture({})],
    ["MCP export_architecture_diagram", () => executeExportArchitectureDiagram({ diagramFormat: "diagram-spec" })],
  ];

  it.each(commands)("%s parses nothing when nothing changed, only the edited file after one edit", async (_name, command) => {
    /** A new process restoring the saved index, as a warm CLI run does. */
    const warmRun = async () => {
      const spider = newSpider();
      expect(spider.enableReverseIndex(index)).toBe(true);
      workerState.spider = spider;
      return stable(await command());
    };
    workerState.spider = newSpider();
    const cold = stable(await command());
    expect(cold?.length).toBeGreaterThan(100);
    const parsed = vi.spyOn(Parser.prototype, "parseImports");

    expect(await warmRun()).toBe(cold);
    expect(parsed).not.toHaveBeenCalled();

    // Appended after the last import: the dependencies, so the output, stay the same.
    const changed = path.join(root, "shared/ui/src/index.ts");
    fs.appendFileSync(changed, "\n// edited\n");
    expect(await warmRun()).toBe(cold);
    expect(parsed.mock.calls.map(([filePath]) => normalizePath(filePath))).toEqual([normalizePath(changed)]);
  });
});
