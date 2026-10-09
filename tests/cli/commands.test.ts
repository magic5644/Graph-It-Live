/**
 * CLI command integration tests.
 *
 * Mocks Spider and AstWorkerHost to avoid WASM in unit tests.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures helpers
// ---------------------------------------------------------------------------

function createFixtureProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-cmd-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), 'import "./utils";\nexport const x = 1;\n');
  fs.writeFileSync(path.join(dir, "src", "utils.ts"), 'export function helper(): void {}\n');
  return dir;
}

// ---------------------------------------------------------------------------
// tool --list
// ---------------------------------------------------------------------------

describe("tool command", () => {
  it("--list returns every CLI tool name with its summary", async () => {
    const { run } = await import("../../src/cli/commands/tool.js");

    // Provide a minimal runtime stub — --list doesn't touch spider
    const runtimeStub = {
      ensureIndexed: vi.fn(),
      workspaceRoot: "/tmp",
    } as unknown as import("../../src/cli/runtime").CliRuntime;

    const output = await run(["--list"], runtimeStub, "text");
    expect(output).toContain("analyze_dependencies");
    expect(output).toContain("crawl_dependency_graph");
    expect(output).toContain("find_referencing_files");
    expect(output).toContain("expand_node");
    expect(output).toContain("parse_imports");
    expect(output).toContain("verify_dependency_usage");
    expect(output).toContain("resolve_module_path");
    expect(output).toContain("get_index_status");
    expect(output).toContain("invalidate_files");
    expect(output).toContain("rebuild_index");
    expect(output).toContain("get_symbol_graph");
    expect(output).toContain("find_unused_symbols");
    expect(output).toContain("get_symbol_dependents");
    expect(output).toContain("trace_function_execution");
    expect(output).toContain("get_symbol_callers");
    expect(output).toContain("analyze_breaking_changes");
    expect(output).toContain("get_impact_analysis");
    expect(output).toContain("analyze_file_logic");
    expect(output).toContain("generate_codemap");
    expect(output).toContain("query_call_graph");
    expect(output).toContain("scan_dead_code");
    // Verify descriptions are included
    expect(output).toContain("Lists the import/export statements of one file");
  });

  it("no args returns brief list", async () => {
    const { run } = await import("../../src/cli/commands/tool.js");
    const runtimeStub = {
      ensureIndexed: vi.fn(),
      workspaceRoot: "/tmp",
    } as unknown as import("../../src/cli/runtime").CliRuntime;

    const output = await run([], runtimeStub, "text");
    expect(output).toContain("Available tools:");
    expect(output).toContain("analyze_dependencies");
  });

  describe("parseToolArgs", () => {
    it("merges --args JSON with named flags (issue #159)", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(parseToolArgs(["--filePath=/abs/a.ts", "--args", '{"knownPaths":[]}'])).toEqual({
        filePath: "/abs/a.ts",
        knownPaths: [],
      });
    });

    it("lets named flags override --args keys regardless of position", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(parseToolArgs(["--depth=3", "--args", '{"depth":1,"scope":"src/**"}'])).toEqual({
        depth: 3,
        scope: "src/**",
      });
      expect(parseToolArgs(["--args", '{"depth":1}', "--depth=3"])).toEqual({ depth: 3 });
    });

    it("does not read the --args value as a named flag", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(() => parseToolArgs(["--args", "--x=1"])).toThrow("Invalid JSON after --args");
    });

    it("rejects invalid or non-object --args JSON", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(() => parseToolArgs(["--args", "{bad"])).toThrow("Invalid JSON after --args");
      expect(() => parseToolArgs(["--args", "[1]"])).toThrow("--args must be a JSON object");
      expect(() => parseToolArgs(["--args", "null"])).toThrow("--args must be a JSON object");
    });

    it("rejects --args with a missing or empty value", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(() => parseToolArgs(["--args"])).toThrow("Invalid JSON after --args");
      expect(() => parseToolArgs(["--args", ""])).toThrow("Invalid JSON after --args");
    });

    it("reads a space-separated value like the = form (issue #268)", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(parseToolArgs(["--filePath", "/x"])).toEqual({ filePath: "/x" });
      expect(parseToolArgs(["--filePath", String.raw`C:\repo\a.ts`])).toEqual({ filePath: String.raw`C:\repo\a.ts` });
      expect(parseToolArgs(["--depth", "2"])).toEqual({ depth: 2 });
      expect(parseToolArgs(["--depth", "-1"])).toEqual({ depth: -1 });
      expect(parseToolArgs(["--relationTypes", '["calls"]'])).toEqual({ relationTypes: ["calls"] });
    });

    it("lets a space-separated flag override --args keys", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(parseToolArgs(["--depth", "3", "--args", '{"depth":1,"scope":"src/**"}'])).toEqual({
        depth: 3,
        scope: "src/**",
      });
    });

    it("lets a boolean parameter stand alone before another flag", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      const booleans = new Set(["includeTypeOnly"]);
      expect(parseToolArgs(["--includeTypeOnly", "--filePath", "/x"], booleans)).toEqual({
        includeTypeOnly: true,
        filePath: "/x",
      });
      expect(parseToolArgs(["--filePath", "/x", "--includeTypeOnly"], booleans)).toEqual({
        filePath: "/x",
        includeTypeOnly: true,
      });
      expect(parseToolArgs(["--includeTypeOnly", "false"], booleans)).toEqual({ includeTypeOnly: false });
      expect(parseToolArgs(["--includeTypeOnly=false"], booleans)).toEqual({ includeTypeOnly: false });
    });

    it("rejects a non-boolean flag with no value", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(() => parseToolArgs(["--filePath"])).toThrow("--filePath needs a value");
      expect(() => parseToolArgs(["--filePath", "--depth=2"])).toThrow("--filePath needs a value");
    });

    it("rejects a stray positional instead of dropping it", async () => {
      const { parseToolArgs } = await import("../../src/cli/commands/tool.js");
      expect(() => parseToolArgs(["/abs/a.ts"])).toThrow('Unexpected argument "/abs/a.ts"');
      expect(() => parseToolArgs(["--depth=2", "extra"])).toThrow("--<name>=<value> or --<name> <value>");
    });
  });

  describe("getToolHelp", () => {
    it("lists the tool's parameters with type, required flag and description (issue #268)", async () => {
      const { getToolHelp } = await import("../../src/cli/commands/tool.js");
      const help = getToolHelp("query_call_graph") ?? "";
      expect(help).toContain("graph-it tool query_call_graph");
      expect(help).toMatch(/--filePath <string>\s+required/);
      expect(help).toMatch(/--includeTypeOnly <boolean>\s+optional/);
      expect(help).toContain("--relationTypes <array>");
      expect(help).toContain("graph-it tool query_call_graph --filePath <filePath> --symbolName <symbolName>");
    });

    it("says a tool without parameters has none", async () => {
      const { getToolHelp } = await import("../../src/cli/commands/tool.js");
      expect(getToolHelp("get_index_status")).toContain("(none)");
    });

    it("returns undefined for an unknown or MCP-only tool", async () => {
      const { getToolHelp } = await import("../../src/cli/commands/tool.js");
      expect(getToolHelp("nope")).toBeUndefined();
      expect(getToolHelp("set_workspace")).toBeUndefined();
    });
  });

});

// ---------------------------------------------------------------------------
// commandHelp
// ---------------------------------------------------------------------------

describe("commandHelp", () => {
  it("returns help for each known command", async () => {
    const { getCommandHelp } = await import("../../src/cli/commandHelp.js");
    const commands = ["scan", "summary", "trace", "explain", "path", "path-in", "check-dependencies", "cycles", "architecture", "check", "serve", "tool", "install", "review-pr", "query", "wiki", "stats", "export"];
    for (const cmd of commands) {
      const help = getCommandHelp(cmd);
      expect(help).toContain(`graph-it ${cmd}`);
    }
  });

  it("documents context --detail and the real stats directory", async () => {
    const { getCommandHelp } = await import("../../src/cli/commandHelp.js");
    expect(getCommandHelp("context")).toContain("--detail <level>       compact|standard|full");
    expect(getCommandHelp("stats")).toContain("(default: ~/.graph-it/stats)");
  });

  it("returns fallback for unknown commands", async () => {
    const { getCommandHelp } = await import("../../src/cli/commandHelp.js");
    const help = getCommandHelp("nonexistent");
    expect(help).toContain("Unknown command");
  });
});

// ---------------------------------------------------------------------------
// findWorkspaceRoot + CliRuntime state persistence (CLI-level integration)
// ---------------------------------------------------------------------------

describe("findWorkspaceRoot integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createFixtureProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects fixture project root from subdirectory", async () => {
    const { findWorkspaceRoot } = await import("../../src/analyzer/utils/workspaceBoundary.js");
    const subDir = path.join(tmpDir, "src");
    const root = findWorkspaceRoot(subDir);
    expect(root).toBe(tmpDir);
  });
});
