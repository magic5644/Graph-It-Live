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
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
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

  it("keeps the review gate's --max-files spelling and refuses --groups with --level units", () => {
    expect(cli(["review-pr", "--base", "HEAD", "--max-files", "5", "--format", "json"]).status).toBe(0);
    const both = cli(["architecture", "--groups", "--level", "units"]);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("--groups is the folder groups of the workspace");
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
    expect([...helpFormats].sort(), `${command} --format line`).toEqual([...new Set(spec.formats)].sort());
  });
});
