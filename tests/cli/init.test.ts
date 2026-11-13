import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCommandHelp } from "@/cli/commandHelp";
import { run as checkArchitecture } from "@/cli/commands/checkArchitecture";
import { GUARD_SNIPPETS, run, type InitIo } from "@/cli/commands/init";
import type { InitResult } from "@/cli/commands/initReport";
import { classifyError, ExitCode } from "@/cli/errors";
import type { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { RULES_CONFIG, startRulesWorker } from "../analyzer/architecture/rulesWorkspace";
import { CliProgress } from "@/cli/progress";

vi.mock("@/mcp/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools")>()),
  // The real scan needs the reverse index of a full CLI run (covered by the E2E test).
  executeScanDeadCode: vi.fn().mockImplementation(async ({ unreferencedFiles, minConfidence }: { unreferencedFiles?: boolean; minConfidence?: string }) => {
    const symbol = (name: string, confidence: string) => ({ name, line: 2, id: name, kind: "VariableDeclaration", isExported: true, confidence });
    const high = { relativePath: "backend/src/api.ts", unusedSymbols: [symbol("api", "high")] };
    // Listed with --focus only (minConfidence low): a medium export in backend, a low one outside it.
    const below = [
      { relativePath: "backend/src/db.ts", unusedSymbols: [symbol("query", "medium")] },
      { relativePath: "mfe/cart/src/view.ts", unusedSymbols: [symbol("unusedView", "low")] },
    ];
    return unreferencedFiles
      ? {
        // A file gone since the scan has no line count.
        unreferencedFiles: [
          { relativePath: "backend/src/api.ts", exports: 1, confidence: "low", reasons: ["no-importer"] },
          { relativePath: "backend/src/gone.ts", exports: 0, confidence: "medium", reasons: ["test-only-use"] },
        ],
      }
      : { entries: minConfidence === "low" ? [high, ...below] : [high], byConfidence: { high: 1, medium: 2, low: 3 } };
  }),
}));

const CONFIG = "graphit.architecture.json";
const BASELINE = "graphit.architecture.baseline.json";
const offline: InitIo = { interactive: false, confirm: vi.fn() };

describe("graph-it init", { timeout: 60_000 }, () => {
  let root: string;
  let runtime: CliRuntime;
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => fs.readFileSync(file(name), "utf8");
  const init = async (args: string[] = [], io: InitIo = offline): Promise<InitResult> => JSON.parse(await run(args, runtime, "json", io));
  const errorOf = async (promise: Promise<unknown>) => classifyError(await promise.then(() => undefined, (error: unknown) => error));

  beforeEach(() => {
    root = startRulesWorker();
    fs.rmSync(file(CONFIG));
    runtime = { workspaceRoot: root, progress: new CliProgress(false), ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState: () => null } as unknown as CliRuntime;
  });

  afterEach(() => {
    workerState.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes a config from the current code that check-architecture passes, and nothing else", async () => {
    const result = await init();
    expect(result).toMatchObject({ status: "created", written: [CONFIG], acceptedViolations: 0, diagrams: [] });
    expect(fs.existsSync(file(BASELINE))).toBe(false);
    const config = JSON.parse(read(CONFIG));
    expect(config.elements["shared-ui"]).toEqual({ unit: "shared/ui" });
    // shared/ui and shared/utils import each other: left out of noCycles, still bound by their allowOnly.
    expect(config.elements["acyclic-units"].unit).not.toContain("shared/ui");
    expect(config.rules.find((rule: { name: string }) => rule.name === "shared-ui-imports").allowOnly).toEqual(["shared-utils"]);
    const check = JSON.parse(await checkArchitecture([], runtime, "json"));
    expect(check).toMatchObject({ passed: true, totals: { violations: 0, unmatchedFiles: 0 }, configWarnings: [] });
    // Quick wins and matrix reading come with it.
    expect(result.assessment.quickWins.map((win) => win.kind)).toEqual(expect.arrayContaining(["cycle-break", "dead-code"]));
    expect(result.assessment.matrixFindings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(["entry-row"]));
  });

  it("changes nothing on a second run", async () => {
    await init();
    const before = read(CONFIG);
    expect(await init()).toMatchObject({ status: "unchanged", written: [], changes: [] });
    expect(read(CONFIG)).toBe(before);
  });

  it("writes nothing at all on a dry run", async () => {
    expect(await init(["--dry-run", "--output", "report"])).toMatchObject({ status: "dry-run", written: [], diagrams: [] });
    expect(fs.readdirSync(root)).not.toContain(CONFIG);
    expect(fs.readdirSync(root)).not.toContain("report");
  });

  describe("with an existing config", () => {
    const original = `${JSON.stringify(RULES_CONFIG, null, 2)}\n`;

    beforeEach(() => fs.writeFileSync(file(CONFIG), original));

    it("keeps it outside a terminal and still reports the changes", async () => {
      const result = await init();
      expect(result).toMatchObject({ status: "kept", written: [] });
      expect(result.changes).toEqual(expect.arrayContaining([expect.stringMatching(/^\+ rule "backend-2-imports"/), expect.stringMatching(/^\+ accepted violation /)]));
      expect(offline.confirm).not.toHaveBeenCalled();
      expect(read(CONFIG)).toBe(original);
      expect(fs.existsSync(file(BASELINE))).toBe(false);
    });

    it("keeps it when the person answers no", async () => {
      const io = { interactive: true, confirm: vi.fn().mockResolvedValue(false) };
      expect(await init([], io)).toMatchObject({ status: "kept", written: [] });
      expect(io.confirm).toHaveBeenCalledWith(expect.arrayContaining([expect.stringMatching(/^\+ element /)]));
      expect(read(CONFIG)).toBe(original);
    });

    it.each([
      ["a confirmation", [], { interactive: true, confirm: vi.fn().mockResolvedValue(true) }],
      ["--yes", ["--yes"], offline],
    ])("merges into it after %s, keeping *.bak copies and every hand-written rule", async (_name, args, io) => {
      fs.writeFileSync(file(BASELINE), '{ "version": 1, "violations": [] }\n');
      const result = await init(args, io);
      expect(result).toMatchObject({ status: "updated", written: [`${CONFIG}.bak`, `${BASELINE}.bak`, CONFIG, BASELINE] });
      expect(read(`${CONFIG}.bak`)).toBe(original);
      const config = JSON.parse(read(CONFIG));
      expect(config.rules.slice(0, RULES_CONFIG.rules.length)).toEqual(RULES_CONFIG.rules);
      // The violations of the hand-written rules are accepted: check-architecture passes on day one.
      expect(result.acceptedViolations).toBeGreaterThan(0);
      expect(JSON.parse(await checkArchitecture([], runtime, "json"))).toMatchObject({ passed: true, totals: { newViolations: 0, unmatchedFiles: 0 } });
    });

    it("leaves it alone on a dry run, even with --yes", async () => {
      expect(await init(["--dry-run", "--yes"])).toMatchObject({ status: "dry-run", written: [] });
      expect(read(CONFIG)).toBe(original);
      expect(fs.readdirSync(root).filter((name) => name.includes(".bak"))).toEqual([]);
    });

    it("never replaces an earlier backup", async () => {
      fs.writeFileSync(file(`${CONFIG}.bak`), "first backup");
      expect((await init(["--yes"])).written).toEqual([`${CONFIG}.bak.2`, CONFIG, BASELINE]);
      expect(read(`${CONFIG}.bak`)).toBe("first backup");
      expect(read(`${CONFIG}.bak.2`)).toBe(original);
    });

    it("refuses an invalid config instead of replacing it", async () => {
      fs.writeFileSync(file(CONFIG), "{ not json");
      expect((await errorOf(init(["--yes"]))).message).toContain(CONFIG);
      expect(read(CONFIG)).toBe("{ not json");
    });
  });

  it("shows each phase on stderr when progress is on, with the same output as without it (#717)", async () => {
    const quiet = await run(["--output", "docs/architecture/", "--yes"], runtime, "text", offline);
    fs.rmSync(file(CONFIG)); // the same first run again
    let stderr = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      runtime.progress = new CliProgress(true);
      const shown = await run(["--output", "docs/architecture/", "--yes"], runtime, "text", offline);
      expect(shown).toBe(quiet);
    } finally {
      write.mockRestore();
    }
    const finished = stderr.split("\n").filter(Boolean).map((line) => line.split("\r\u001B[K").at(-1) ?? "");
    expect(finished.map((line) => line.replace(/ [\d/]+ \(| \(.*$/g, "|").split("|")[0].trim())).toEqual([
      "Analyzing architecture",
      "Analyzing unused exports",
      "Finding unreferenced files",
      "Assessing architecture",
      "Laying out diagrams",
      "Writing the HTML page",
    ]);
    expect(finished[0]).toMatch(/^ {2}Analyzing architecture \d+\/\d+ \(\d+\.\ds\)$/);
  });

  it("writes the diagrams and report.md to --output, linked from the report", async () => {
    const result = await init(["--output", "docs/architecture/"]);
    const dir = "docs/architecture";
    expect(result.diagrams.map((diagram) => diagram.file)).toEqual(expect.arrayContaining([`${dir}/units.svg`, `${dir}/matrix.svg`, `${dir}/folder-1-shared-ui.svg`]));
    expect(result.written).toEqual([CONFIG]);
    expect(result.reportFiles).toEqual(expect.arrayContaining([`${dir}/units.svg`, `${dir}/index.html`, `${dir}/report.md`]));
    expect(result.page).toBe(`${dir}/index.html`);
    for (const diagram of result.diagrams) expect(read(diagram.file)).toMatch(/^<svg/);
    expect(read(`${dir}/matrix.svg`)).toContain("row imports column: N file pairs");
    // units.svg: every unit kept, the shared-ui / shared-utils cycle drawn by its cut only.
    const units = read(`${dir}/units.svg`);
    expect(units.match(/<rect class="node"/g)).toHaveLength(9);
    expect(units).toContain("a cycle drawn by the edges that cut it only: 1 in the level (1 file pair); 1 other edge inside cycles not drawn");
    const report = read(`${dir}/report.md`);
    expect(report).toContain("([diagram](units.svg))");
    expect(report).toContain("([diagram](folder-1-shared-ui.svg))");
    expect(report).toContain("Explore: [index.html](index.html): units as groups");
    // The page: one group per unit, the units of the report, its findings, and no absolute path.
    const page = read(`${dir}/index.html`);
    const groups = JSON.parse(page.split("const groupsData = ")[1].split(";\n")[0]) as { label: string; fileCount: number }[];
    expect(groups.map((group) => group.label)).toEqual(expect.arrayContaining(["backend", "frontend", "shared/ui", "shared/utils", "(root)"]));
    expect(groups).toHaveLength(result.assessment.totals.units);
    expect(groups.reduce((sum, group) => sum + group.fileCount, 0)).toBe(result.assessment.totals.files);
    expect(page).toContain(`"title":"Dead files"`);
    expect(page).not.toContain(root);
    // On stdout the links are workspace-relative.
    expect(await run(["--dry-run"], runtime, "markdown", offline)).toContain("# Architecture report (graph-it init)");
  });

  it("asks before replacing a baseline left without its config", async () => {
    fs.writeFileSync(file(BASELINE), '{ "version": 1, "violations": [] }\n');
    expect(await init()).toMatchObject({ status: "kept", written: [] });
    expect(fs.existsSync(file(CONFIG))).toBe(false);
    expect(await init(["--yes"])).toMatchObject({ status: "updated", written: [`${BASELINE}.bak`, CONFIG, BASELINE] });
  });

  it("reads --output with backslashes, and refuses a file", async () => {
    expect((await init(["--output", String.raw`docs\architecture`])).reportFiles).toContain("docs/architecture/report.md");
    fs.writeFileSync(file("notes.md"), "");
    const error = await errorOf(init(["--output", "notes.md"]));
    expect(error.message).toContain("--output must be a directory");
    expect(fs.existsSync(file(CONFIG))).toBe(true);
  });

  it("writes to the workspace root with --output .", async () => {
    const result = await init(["--output", "."]);
    expect(result.reportFiles).toEqual(expect.arrayContaining(["units.svg", "report.md"]));
  });

  it.each([
    ["--output outside the workspace", ["--output", "../elsewhere"], ExitCode.SECURITY_VIOLATION],
    ["an unsupported format", [], ExitCode.UNSUPPORTED_FORMAT],
  ])("refuses %s before any work", async (name, args, exitCode) => {
    const error = await errorOf(run(args, runtime, name.includes("format") ? "csv" : "json", offline));
    expect(error.exitCode).toBe(exitCode);
    expect(runtime.ensureIndexed).not.toHaveBeenCalled();
    expect(fs.existsSync(file(CONFIG))).toBe(false);
  });

  describe("never writes out of the workspace", () => {
    let outside: string;

    beforeEach(() => {
      outside = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "outside-")));
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it("through a linked output directory", async () => {
      // A junction needs no privilege on Windows; elsewhere it is a directory symlink.
      fs.symlinkSync(outside, file("report"), "junction");
      expect((await errorOf(init(["--output", "report"]))).exitCode).toBe(ExitCode.SECURITY_VIOLATION);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(file(CONFIG))).toBe(false);
    });

    it("through a hard-linked config", async () => {
      const target = path.join(outside, "target.json");
      fs.writeFileSync(target, JSON.stringify({ elements: {}, rules: [] }));
      fs.linkSync(target, file(CONFIG));
      expect((await errorOf(init(["--yes"]))).exitCode).toBe(ExitCode.SECURITY_VIOLATION);
      expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ elements: {}, rules: [] });
    });

    it.skipIf(process.platform === "win32")("through a symbolic link to a file", async () => {
      fs.symlinkSync(path.join(outside, "target.json"), file(CONFIG));
      expect((await errorOf(init())).exitCode).toBe(ExitCode.SECURITY_VIOLATION);
      expect(fs.existsSync(path.join(outside, "target.json"))).toBe(false);
    });

    it("over a directory in the way", async () => {
      fs.mkdirSync(file("report/units.svg"), { recursive: true });
      expect((await errorOf(init(["--output", "report"]))).message).toMatch(/not a regular file/);
    });
  });

  it("prints the text report with the guard snippets", async () => {
    const text = await run(["--dry-run"], runtime, "text", offline);
    expect(text).toMatch(/^Rules: graphit\.architecture\.json: dry run: nothing written/);
    expect(text).toContain(`pre-commit: ${GUARD_SNIPPETS.preCommit}`);
    expect(text).toMatch(/Cycles to cut \(\d+\):/);
    expect(text.indexOf("Summary:")).toBeLessThan(text.indexOf("Guard:"));
    expect(await run(["--dry-run"], runtime, "toon", offline)).toContain("dry-run");
    expect(text).toContain("Unused exports: 1 high-confidence in 1 file (2 medium, 3 low not listed: graph-it check --minConfidence low)");
  });

  describe("--focus", () => {
    it("restricts the report and its totals to a unit and its direct neighbours", async () => {
      const whole = await init(["--dry-run"]);
      const result = await init(["--dry-run", "--focus", "backend"]);
      expect(result.focus).toBe("backend");
      // backend/src/{api,db}.ts; neighbours: functions/billing, frontend, (root) scripts, shared/utils.
      expect(result.assessment.totals).toMatchObject({ files: 2, units: 5, unitEdges: 4, unitCycles: 0, unusedExports: 1, unusedExportsMedium: 1, unusedExportsLow: 0, deadFiles: 1 });
      expect(result.assessment.quickWins.map((win) => win.kind)).not.toContain("cycle-break");
      expect(result.assessment.quickWins.every((win) => win.units.includes("backend"))).toBe(true);
      const neighbours = ["backend", "functions/billing", "frontend", "(root)", "shared/utils"];
      expect(result.assessment.matrixFindings.flatMap((finding) => finding.rows).every((row) => neighbours.includes(row))).toBe(true);
      // The rules files still cover the whole workspace.
      expect(result.changes).toEqual(whole.changes);
      const text = await run(["--dry-run", "--focus", "backend"], runtime, "text", offline);
      expect(text).toContain("Focus: backend and its direct neighbours only");
      expect(text).toContain("Size: 2 files in backend, 5 units with its neighbours, 4 unit edges through it");
    });

    it.each([
      ["a package name", "@acme/shared-ui", "shared/ui"],
      ["a directory", "backend/src/", "backend"],
      ["a directory with backslashes", String.raw`backend\src`, "backend"],
    ])("accepts %s", async (_name, focus, key) => {
      expect((await init(["--dry-run", "--focus", focus])).focus).toBe(key);
    });

    it("keeps the unit cycle of the focus", async () => {
      const result = await init(["--dry-run", "--focus", "shared/ui"]);
      expect(result.assessment.quickWins.map((win) => win.kind)).toContain("cycle-break");
      expect(result.assessment.totals.unitCycles).toBe(1);
    });

    it("draws the focus units and its folder first", async () => {
      const result = await init(["--focus", "backend", "--output", "report"]);
      const folders = result.diagrams.filter((diagram) => diagram.view === "folder").map((diagram) => diagram.file);
      expect(folders[0]).toBe("report/folder-1-backend.svg");
      expect(read("report/units.svg").match(/<rect class="node"/g)).toHaveLength(5);
      expect(read("report/report.md")).toContain("- Focus: backend and its direct neighbours only");
      const page = read("report/index.html");
      expect(page).toContain("scope: backend and its direct neighbours");
      expect(page).toContain('"focus":{"label":"backend","files":["backend/src/api.ts","backend/src/db.ts"]}');
      expect(JSON.parse(page.split("const groupsData = ")[1].split(";\n")[0])).toHaveLength(result.assessment.totals.units);
    });

    it.each([
      ["an unknown name, with the close ones", ["--focus", "backnd"], /no unit, package or folder named "backnd"\. Did you mean: backend\?/],
      ["a name far from any", ["--focus", "zzzzzzzzzz"], /graph-it architecture --level units lists the units/],
      ["a directory holding several units", ["--focus", "shared"], /--focus "shared" holds several units \(shared\/ui, shared\/utils\): pass one of them\./],
    ])("refuses %s before writing anything", async (_name, args, message) => {
      const error = await errorOf(init(args));
      expect(error.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(error.message).toMatch(message);
      expect(fs.existsSync(file(CONFIG))).toBe(false);
    });

    it.each([
      ["twice", ["--focus", "backend", "--focus", "frontend"], "--focus takes one unit or folder"],
      ["without a value", ["--focus", ""], "--focus must be a unit, a package name or a folder"],
    ])("refuses --focus %s before any work", async (_name, args, message) => {
      expect((await errorOf(init(args))).message).toContain(message);
      expect(runtime.ensureIndexed).not.toHaveBeenCalled();
    });
  });

  it("lists only high-confidence dead code as quick wins and counts the other levels", async () => {
    const { executeScanDeadCode } = await import("@/mcp/tools");
    const result = await init(["--dry-run"]);
    expect(executeScanDeadCode).toHaveBeenCalledWith({ minConfidence: "high" }, undefined, expect.any(Function));
    expect(executeScanDeadCode).toHaveBeenCalledWith({ unreferencedFiles: true }, undefined, expect.any(Function));
    expect(result.assessment.totals).toMatchObject({ deadCodeFiles: 1, unusedExports: 1, unusedExportsMedium: 2, unusedExportsLow: 3, deadFiles: 2 });
    const lines = fs.readFileSync(file("backend/src/api.ts"), "utf8").trimEnd().split("\n").length;
    expect(result.assessment.deadFiles.flatMap((group) => group.files)).toEqual([
      expect.objectContaining({ relativePath: "backend/src/api.ts", lines }),
      expect.not.objectContaining({ lines: expect.anything() }),
    ]);
  });
});

describe("GUARD_SNIPPETS", () => {
  it("only use commands and options graph-it check-architecture documents", () => {
    const help = getCommandHelp("check-architecture");
    for (const snippet of Object.values(GUARD_SNIPPETS)) {
      for (const line of snippet.split("\n").filter((text) => text.includes("check-architecture"))) {
        const command = line.slice(line.indexOf("check-architecture"));
        expect(help).toContain(`graph-it ${command.split(" >")[0]}`);
        for (const option of command.match(/--[\w-]+/g) ?? []) expect(help).toContain(option);
      }
    }
  });
});
