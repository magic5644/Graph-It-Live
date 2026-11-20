/**
 * CLI user contract (#767, .claude/rules/user-contract.md): every command × declared format ×
 * {valid input, unknown option, invalid value, missing target}, driven through the built binary.
 *
 * The rows come from COMMAND_SPECS, so a new command, option or format fails here until it has its
 * rows. serve, install and update have only failure rows: a valid run starts a server or installs.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_NAMES, COMMAND_SPECS } from "../../src/cli/commandSpec";
import { getCommandHelp } from "../../src/cli/commandHelp";
import type { CliOutputFormat } from "../../src/cli/formatter";
import { elementsWorkspace, rootWorkspace } from "./architectureUnitsFixture";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY);
const TIMEOUT_MS = 120_000;
const SIDE_EFFECT_COMMANDS = new Set(["serve", "install", "update"]);

let root = "";
let statsDir = "";

/** Valid arguments of each command, per format when one needs its own (csv needs --matrix). */
function validArgs(command: string, format: CliOutputFormat): string[] {
  const rows: Record<string, string[]> = {
    scan: [],
    summary: [],
    trace: ["src/a.ts#run"],
    explain: ["src/a.ts"],
    path: ["src/a.ts"],
    "path-in": ["src/b.ts"],
    "check-dependencies": ["src/a.ts"],
    cycles: ["src/a.ts"],
    architecture: format === "csv" ? ["--matrix"] : [],
    "check-architecture": [],
    init: ["--dry-run"],
    diagram: ["--output", "-"],
    check: [],
    "review-pr": ["--base", "HEAD"],
    tool: format === "mermaid" ? ["crawl_dependency_graph", `--entryFile=${path.join(root, "src/a.ts")}`] : ["get_index_status"],
    query: ["what calls helper"],
    context: ["what calls helper"],
    wiki: ["--output", `wiki-${format}`],
    stats: ["--stats-dir", statsDir],
    export: ["--output", "-"],
  };
  return rows[command];
}

/** One invalid value per command: the value is read, refused, and named. */
const INVALID_VALUE: Record<string, { args: string[]; message: string }> = {
  scan: { args: ["--format"], message: "--format needs a value" },
  summary: { args: ["--format"], message: "--format needs a value" },
  trace: { args: ["src/a.ts#run", "--maxDepth", "0"], message: '--maxDepth must be an integer between 1 and 100, got "0"' },
  explain: { args: ["src/a.ts", "--format"], message: "--format needs a value" },
  path: { args: ["src/a.ts", "--communities", "bogus"], message: '--communities must be path or louvain, got "bogus"' },
  "path-in": { args: ["src/b.ts", "--format"], message: "--format needs a value" },
  "check-dependencies": { args: ["src/a.ts", "--format"], message: "--format needs a value" },
  cycles: { args: ["src/a.ts", "--format"], message: "--format needs a value" },
  architecture: { args: ["--level", "foo"], message: '--level must be groups or units, got "foo"' },
  "check-architecture": { args: ["--config"], message: "--config needs a value" },
  init: { args: ["--focus"], message: "--focus needs a value" },
  diagram: { args: ["--view", "nope"], message: '--view must be units or folder or matrix, got "nope"' },
  check: { args: ["--minConfidence", "x"], message: "--minConfidence" },
  "review-pr": { args: ["--base", "HEAD", "--depth", "99"], message: '--depth must be an integer between 1 and 10, got "99"' },
  serve: { args: ["--format"], message: "--format needs a value" },
  tool: { args: ["get_index_status", "--args", "{"], message: "Invalid JSON after --args" },
  install: { args: ["--format"], message: "--format needs a value" },
  update: { args: ["--format"], message: "--format needs a value" },
  query: { args: ["what", "--depth", "x"], message: '--depth must be an integer' },
  context: { args: ["what", "--detail", "huge"], message: "--detail:" },
  wiki: { args: ["--top", "0"], message: "--top" },
  stats: { args: ["--stats-dir"], message: "--stats-dir needs a value" },
  export: { args: ["--communities", "x"], message: '--communities must be path or louvain, got "x"' },
};

/** A target that does not exist, and the message naming it with the closest candidates when there are any. */
const MISSING_TARGET: Record<string, { args: string[]; message: string }> = {
  summary: { args: ["src/aa.ts"], message: "File not found: src/aa.ts. Did you mean: src/a.ts" },
  trace: { args: ["src/a.ts#rnu"], message: "Symbol 'rnu' not found in src/a.ts. Did you mean: run?" },
  explain: { args: ["src/nope.ts"], message: "File not found: src/nope.ts." },
  path: { args: ["src/nope.ts"], message: "File not found: src/nope.ts." },
  "path-in": { args: ["src/nope.ts"], message: "File not found: src/nope.ts." },
  "check-dependencies": { args: ["src/nope.ts"], message: "File not found: src/nope.ts." },
  cycles: { args: ["src/nope.ts"], message: "File not found: src/nope.ts." },
  architecture: { args: ["--level", "units", "--from", "srx", "--to", "src"], message: 'Unknown unit "srx". Did you mean: src?' },
  init: { args: ["--dry-run", "--focus", "nope"], message: '--focus: no unit, package or folder named "nope"' },
  diagram: { args: ["nope", "--output", "-"], message: "Directory not found: nope" },
  "review-pr": { args: ["--base", "nope"], message: 'Unknown Git ref "nope"' },
  tool: { args: ["get_index_statu"], message: "get_index_statu" },
  export: { args: ["srcc", "--output", "-"], message: "Scope not found: srcc. Did you mean: src?" },
};

function cli(args: string[]) {
  const env = { ...process.env };
  // query falls back to its heuristic: no network, same answer on every machine.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return spawnSync(process.execPath, [DIST_ENTRY, ...args], { cwd: root, encoding: "utf-8", env, maxBuffer: 64 * 1024 * 1024 });
}

/** The output is the requested view: parseable when the format is data, never a diagram of the result's keys. */
function expectView(command: string, format: CliOutputFormat, stdout: string): void {
  expect(stdout.trim(), "empty stdout").not.toBe("");
  // The generic diagram drew one G<n> node per JSON key (`G1["workspaceRoot: …"]`).
  expect(stdout).not.toMatch(/\bG\d+\["/);
  if (format === "json" || format === "sarif" || format === "diagram-spec") expect(() => JSON.parse(stdout)).not.toThrow();
  if (format === "mermaid") expect(stdout).toMatch(/^graph (TD|LR)\n/);
  if (format === "csv") expect(stdout.split("\n")[0]).toContain(",");
  if (format === "svg") expect(stdout).toMatch(/^<svg /);
  if (format === "html") expect(stdout).toMatch(/^<!DOCTYPE html>/i);
  if (format === "markdown" && command !== "wiki") expect(stdout).toMatch(/^#{1,3} /m);
}

describe.skipIf(!distExists)("CLI user contract (E2E)", { timeout: TIMEOUT_MS }, () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-contract-")));
    statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-contract-stats-"));
    fs.writeFileSync(path.join(root, "package.json"), '{ "name": "contract" }\n');
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "src/b.ts"), 'import { util } from "../lib/u";\nexport function helper() { return util(); }\n');
    fs.writeFileSync(path.join(root, "src/a.ts"), 'import { helper } from "./b";\nexport function run() { return helper(); }\n');
    fs.writeFileSync(path.join(root, "lib/u.ts"), 'import { run } from "../src/a";\nexport function util() { return run; }\n');
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" }); // NOSONAR S4036 test fixture: git from the developer's PATH
    git("init", "-q", "--initial-branch=main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    // check-architecture and diagram --rules read the rules init writes.
    expect(cli(["init", "--yes"]).status).toBe(0);
  }, TIMEOUT_MS);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(statsDir, { recursive: true, force: true });
  });

  const validRows = COMMAND_NAMES
    .filter((command) => !SIDE_EFFECT_COMMANDS.has(command))
    .flatMap((command) => COMMAND_SPECS[command].formats.map((format) => [command, format] as const));

  it.each(validRows)("%s -f %s renders the requested view", (command, format) => {
    const result = cli([command, ...validArgs(command, format), "--format", format]);

    expect(result.status, result.stderr).toBe(0);
    expectView(command, format, result.stdout);
  });

  it.each(COMMAND_NAMES)("%s refuses an unknown option (exit 1) before any work", (command) => {
    const result = cli([command, "--bogus-flag", "x"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Error: Unknown option --bogus-flag for graph-it ${command}. Run graph-it ${command} --help for its options.\n`);
  });

  it.each(COMMAND_NAMES)("%s refuses a format it does not write (exit 4), naming the ones it does", (command) => {
    const { formats } = COMMAND_SPECS[command];
    const other = (["mermaid", "html", "json", "text"] as const).find((format) => !formats.includes(format))!;
    const result = cli([command, "--format", other]);

    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Error: graph-it ${command} does not write --format ${other}: use ${formats.join(", ")}.\n`);
  });

  it.each(COMMAND_NAMES)("%s refuses an invalid value (exit 1), naming it", (command) => {
    const { args, message } = INVALID_VALUE[command];
    const result = cli([command, ...args]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toMatch(/\n\s+at |"code":|Command failed/);
  });

  it.each(Object.keys(MISSING_TARGET))("%s refuses a missing target (non-zero exit), with the closest candidates", (command) => {
    const { args, message } = MISSING_TARGET[command];
    const result = cli([command, ...args]);

    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("suggests the closest option, the closest command, and reads positionals wherever they sit", () => {
    expect(cli(["architecture", "--maxfiles", "3"]).stderr).toContain("Unknown option --maxfiles for graph-it architecture. Did you mean --maxFiles?");
    expect(cli(["review-pr", "--maxfile", "3"]).stderr).toContain("Did you mean --maxFiles?");
    const unknown = cli(["archtecture", "--help"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toBe('Error: Unknown command "archtecture". Did you mean architecture? Run graph-it --help for the commands.\n');
    expect(cli(["--bogus", "scan"]).stderr).toContain("Unknown option --bogus.");
    expect(cli(["--worksapce", ".", "scan"]).stderr).toContain("Unknown option --worksapce. Did you mean --workspace?");
    const toolParam = cli(["tool", "crawl_dependency_graph", "--entryFil=src/a.ts"]);
    expect(toolParam.status).toBe(1);
    expect(toolParam.stderr).toContain("Unknown parameter --entryFil for tool crawl_dependency_graph. Did you mean --entryFile?");
    const reordered = cli(["path", "--communities", "louvain", "src/a.ts", "--format", "json"]);
    expect(reordered.status, reordered.stderr).toBe(0);
    expect(JSON.parse(reordered.stdout).nodeCount).toBeGreaterThan(0);
  });

  it("prints the matrix as tables, and holds the output, view and command rules", () => {
    const matrixText = cli(["architecture", "--matrix"]);
    expect(matrixText.status).toBe(0);
    expect(matrixText.stdout).toMatch(/^Dependency matrix \(groups\)\n/);
    expect(cli(["architecture", "--level", "units", "--matrix", "--format", "markdown"]).stdout).toMatch(/^## Dependency matrix \(units\)\n/);
    const expectFailure = (args: string[], status: number, message: string) => {
      const result = cli(args);
      expect(result.status, args.join(" ")).toBe(status);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toContain(message);
    };
    expectFailure(["export", "--output", "../g.html"], 5, "Refusing to write ../g.html: it is outside the workspace");
    // #774: a dry run writes nothing, yet refuses an outside --output like a real run.
    expectFailure(["init", "--dry-run", "--output", "../x"], 5, "--output must be a directory inside the workspace: ../x");
    const dryRun = cli(["init", "--dry-run", "--output", "out"]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain("Report: not written (dry run): out;");
    expect(JSON.parse(cli(["init", "--dry-run", "--output", "out", "--format", "json"]).stdout).reportNotWritten).toBe("out");
    expect(fs.existsSync(path.join(root, "out"))).toBe(false);
    expectFailure(["export", "--output", "g.svg"], 1, "--output g.svg does not match --format html");
    expectFailure(["diagram", "--format", "svg", "--output", "a.html"], 1, "--output a.html does not match --format svg");
    expectFailure(["diagram", "--format", "diagram-spec", "--view", "matrix"], 4, "--format diagram-spec describes --view units or folder");
    expectFailure(["--bogus"], 1, "Unknown option --bogus.");
    expectFailure(["constructor"], 1, 'Unknown command "constructor".');
    const positional = cli(["diagram", "--format", "svg", "--output", "-", "src"]);
    expect(positional.status, positional.stderr).toBe(0);
    expect(positional.stdout).toContain("folder src");
  });

  // #774: a generated file not built yet is reported by every command that lists dead files, with the same facts.
  it("reports an import resolving to no file the same way in check, summary and init", () => {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-unresolved-")));
    try {
      fs.cpSync(path.join(REPO_ROOT, "tests/fixtures/unresolved-generated-import"), fixture, { recursive: true });
      const run = (...args: string[]) => spawnSync(process.execPath, [DIST_ENTRY, ...args], { cwd: fixture, encoding: "utf-8" });
      const json = (...args: string[]) => JSON.parse(run(...args, "--format", "json").stdout);
      const check = json("check", "--unreferencedFiles");

      expect(check.unresolvedImports).toMatchObject({
        count: 3,
        // The generated loader hides the most files: the first example, before the template's imports.
        examples: [
          { file: "backend/src/loader.ts", specifier: "./resolvers.generated" },
          { file: "backend/template/setup.ts", specifier: "../../vitest.config" },
          { file: "backend/template/setup.ts", specifier: "./data/seed.json" },
        ],
        excludedCount: 0,
        next: "Run the build or codegen that emits the missing files, or add the importing files to .graphitignore.",
      });
      expect(check.unreferencedFiles.map((file: { relativePath: string; reasons: string[] }) => [file.relativePath, file.reasons])).toEqual([
        ["backend/src/resolvers/orders.ts", ["no-importer", "unresolved-import-in-workspace"]],
        ["backend/src/resolvers/users.ts", ["no-importer", "unresolved-import-in-workspace"]],
        ["backend/template/setup.ts", ["no-importer"]],
      ]);
      expect(json("summary").unresolvedImports).toEqual(check.unresolvedImports);
      expect(json("init", "--dry-run").unresolvedImports).toEqual(check.unresolvedImports);
      expect(run("init", "--dry-run").stdout).toContain("Unresolved imports: 3 imports of workspace files resolve to no file (e.g. backend/src/loader.ts imports ./resolvers.generated, ");
      expect(run("check", "--unreferencedFiles", "--format", "markdown").stdout).toContain("**Unresolved imports:** 3 imports");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("keeps the review gate's --max-files spelling and refuses --groups with --level units", () => {
    expect(cli(["review-pr", "--base", "HEAD", "--max-files", "5", "--format", "json"]).status).toBe(0);
    const both = cli(["architecture", "--groups", "--level", "units"]);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("--groups is the folder groups of the workspace");
  });
});

// ADR-776 contract rows: units from declared elements, (root) warnings, refused config, element vs project cycles.
describe.skipIf(!distExists)("CLI units contract (#776, E2E)", { timeout: TIMEOUT_MS }, () => {
  const roots: string[] = [];
  const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [DIST_ENTRY, ...args], { cwd: root, encoding: "utf-8" });
  const workspace = (root: string) => (roots.push(root), root);
  let elements = "";

  beforeAll(() => {
    elements = workspace(elementsWorkspace());
  }, TIMEOUT_MS);

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("draws the declared elements, their rules and the cycle between elements; the review sees no detected-project cycle", () => {
    const text = run(elements, "architecture", "--level", "units");
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/^Units: declared elements of graphit.architecture.json\n/);
    expect(text.stdout).toContain("Cycles between declared elements:\n  Units\n  alpha, beta");
    expect(text.stdout).toContain("Rules:\n  Rule            Kind    Severity  Violations  New\n  alpha-not-beta  forbid  warning   1           1");
    expect(text.stdout).toContain("alpha  beta   1           cycle  alpha-not-beta violated");
    expect(text.stdout).not.toMatch(/\[[a-z-]+\?\]/);
    const json = JSON.parse(run(elements, "architecture", "--level", "units", "--format", "json").stdout);
    expect(json).toMatchObject({ unitsFrom: "elements", configFile: "graphit.architecture.json", configWarnings: [] });
    expect(json.units.map((unit: { key: string }) => unit.key).sort()).toEqual(["alpha", "beta", "pkgs"]);
    expect(json.unitEdges.find((edge: { from: string }) => edge.from === "alpha")).toMatchObject({ to: "beta", ruleVerdict: "violated" });
    const review = run(elements, "review-pr", "--base", "HEAD~2", "--head", "HEAD~1", "--format", "markdown");
    expect(review.status, review.stderr).toBe(0);
    expect(review.stdout).toContain("Detected-project cycles: 0 new");
  });

  it("draws no cycle for two detected projects inside one element; the review names them", () => {
    const json = JSON.parse(run(elements, "architecture", "--level", "units", "--format", "json").stdout);
    expect(json.unitEdges.some((edge: { from: string; to: string }) => edge.from === "pkgs" || edge.to === "pkgs")).toBe(false);
    const review = run(elements, "review-pr", "--base", "HEAD~1", "--head", "HEAD", "--format", "markdown");
    expect(review.status, review.stderr).toBe(0);
    expect(review.stdout).toContain("cycle between detected projects packages/p, packages/q");
  });

  it("refuses an unknown unit with the element names closest to it", () => {
    const result = run(elements, "architecture", "--level", "units", "--from", "alpah", "--to", "beta");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown unit "alpah". Did you mean: alpha?');
  });

  it('warns that roles["(root)"] now holds the root files only, naming the new units', () => {
    const root = workspace(rootWorkspace({ elements: {}, rules: [], roles: { "(root)": "tooling" } }));
    const text = run(root, "architecture", "--level", "units");
    expect(text.status, text.stderr).toBe(0);
    const warning = '$.roles["(root)"]: "(root)" now holds only the 1 file at the workspace root; files outside every project moved to the units scripts, tools: name those instead';
    expect(text.stdout).toContain(`Config warnings:\n  Warning\n  ${warning}`);
    expect(text.stdout).toMatch(/^Units: detected projects\n/);
    expect(JSON.parse(run(root, "architecture", "--level", "units", "--format", "json").stdout).configWarnings).toEqual([warning]);
  });

  it("fails on a refused config with one line naming the file and the JSON path", () => {
    const root = workspace(rootWorkspace({ elements: {}, rules: [], roles: { x: "nope" } }));
    const result = run(root, "architecture", "--level", "units");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const errors = result.stderr.split("\n").filter((line) => line.startsWith("Error:"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Error: graphit.architecture.json: \$\.roles\.x: /);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("draws the files no element selects as one (unmatched) unit with a warning, never an empty table", () => {
    const root = workspace(rootWorkspace({ elements: { only: { path: "nowhere/" } }, rules: [] }));
    const text = run(root, "architecture", "--level", "units");
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('$.elements: 3 files match no element; drawn in unit "(unmatched)"');
    expect(text.stdout).toMatch(/\n  \(unmatched\)\s+0\s+\w+\s+.+\s+3\n/);
  });

  it("init --dry-run prints the warning of an older (root) element and writes nothing", () => {
    const root = workspace(rootWorkspace({ elements: { root: { unit: "(root)" } }, rules: [] }));
    const before = fs.readFileSync(path.join(root, "graphit.architecture.json"), "utf8");
    const result = run(root, "init", "--dry-run");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Config warnings:\n  $.elements.root.unit: "(root)" now holds only the 1 file at the workspace root; files outside every project moved to the units scripts, tools: name those instead');
    expect(fs.readFileSync(path.join(root, "graphit.architecture.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(root, "graphit.architecture.baseline.json"))).toBe(false);
  });
});

describe("CLI help matches the declaration", () => {
  const GLOBAL = new Set(["--workspace", "--format", "--help", "--reindex", "--no-cache"]);

  it.each(COMMAND_NAMES)("graph-it %s --help lists every declared option and format, and nothing else", (command) => {
    const help = getCommandHelp(command);
    const spec = COMMAND_SPECS[command];
    const optionsSection = help.slice(help.indexOf("Options:"), help.search(/\n(Examples|Description|MCP Client|With graphit)/));
    const listed = new Set([...optionsSection.matchAll(/^\s+(--?[A-Za-z][\w-]*)/gm)].map((match) => match[1]).filter((name) => !GLOBAL.has(name)));
    // The alias spelled on its own line in the help (--max-files) or inline after a comma (-o).
    for (const [option] of Object.entries(spec.options)) {
      expect(help, `${command} help misses ${option}`).toContain(option);
    }
    for (const option of listed) {
      if (!spec.passthrough) expect(Object.keys(spec.options), `${command} help lists ${option}, which it does not read`).toContain(option);
    }
    const formatLine = help.split("\n").find((line) => /^\s+--format/.test(line));
    const helpFormats = new Set((formatLine ?? "").match(/\b(text|json|toon|markdown|mermaid|csv|sarif|svg|html|diagram-spec)\b/g) ?? ["text"]);
    const sorted = (formats: Iterable<string>) => [...new Set(formats)].sort((left, right) => left.localeCompare(right));
    expect(sorted(helpFormats), `${command} --format line`).toEqual(sorted(spec.formats));
  });
});
