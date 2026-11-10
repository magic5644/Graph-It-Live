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

vi.mock("@/mcp/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools")>()),
  // The real scan needs the reverse index of a full CLI run (covered by the E2E test).
  executeScanDeadCode: vi.fn().mockResolvedValue({
    entries: [{ relativePath: "backend/src/api.ts", unusedSymbols: [{ name: "api", line: 2, id: "x", kind: "VariableDeclaration", isExported: true }] }],
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
    runtime = { workspaceRoot: root, ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState: () => null } as unknown as CliRuntime;
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
    expect(result.assessment.matrixFindings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(["upward-cell", "cycle-block", "entry-row"]));
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

  it("writes the diagrams and report.md to --output, linked from the report", async () => {
    const result = await init(["--output", "docs/architecture/"]);
    const dir = "docs/architecture";
    expect(result.diagrams.map((diagram) => diagram.file)).toEqual(expect.arrayContaining([`${dir}/units.svg`, `${dir}/matrix.svg`, `${dir}/folder-1-shared-ui.svg`]));
    expect(result.written).toEqual(expect.arrayContaining([CONFIG, `${dir}/units.svg`, `${dir}/report.md`]));
    for (const diagram of result.diagrams) expect(read(diagram.file)).toMatch(/^<svg/);
    const report = read(`${dir}/report.md`);
    expect(report).toContain("([diagram](units.svg))");
    expect(report).toContain("([diagram](folder-1-shared-ui.svg))");
    // On stdout the links are workspace-relative.
    expect(await run(["--dry-run"], runtime, "markdown", offline)).toContain("# Architecture guard (graph-it init)");
  });

  it("asks before replacing a baseline left without its config", async () => {
    fs.writeFileSync(file(BASELINE), '{ "version": 1, "violations": [] }\n');
    expect(await init()).toMatchObject({ status: "kept", written: [] });
    expect(fs.existsSync(file(CONFIG))).toBe(false);
    expect(await init(["--yes"])).toMatchObject({ status: "updated", written: [`${BASELINE}.bak`, CONFIG, BASELINE] });
  });

  it("reads --output with backslashes, and refuses a file", async () => {
    expect((await init(["--output", String.raw`docs\architecture`])).written).toContain("docs/architecture/report.md");
    fs.writeFileSync(file("notes.md"), "");
    const error = await errorOf(init(["--output", "notes.md"]));
    expect(error.message).toContain("--output must be a directory");
    expect(fs.existsSync(file(CONFIG))).toBe(true);
  });

  it("writes to the workspace root with --output .", async () => {
    const result = await init(["--output", "."]);
    expect(result.written).toEqual(expect.arrayContaining(["units.svg", "report.md"]));
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
    expect(text).toMatch(/^graphit\.architecture\.json: dry run: nothing written/);
    expect(text).toContain(`pre-commit: ${GUARD_SNIPPETS.preCommit}`);
    expect(text).toMatch(/Quick wins \(\d+, by effort\):/);
    expect(text).toMatch(/Matrix reading \(\d+\):/);
    expect(await run(["--dry-run"], runtime, "toon", offline)).toContain("dry-run");
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
