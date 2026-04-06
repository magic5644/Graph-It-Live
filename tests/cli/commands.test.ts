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
  it("--list returns all 20 MCP tool names", async () => {
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
    // Verify descriptions are included
    expect(output).toContain("Show direct imports and exports");
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
});

// ---------------------------------------------------------------------------
// commandHelp
// ---------------------------------------------------------------------------

describe("commandHelp", () => {
  it("returns help for each known command", async () => {
    const { getCommandHelp } = await import("../../src/cli/commandHelp.js");
    const commands = ["scan", "summary", "trace", "explain", "path", "check", "serve", "tool", "install"];
    for (const cmd of commands) {
      const help = getCommandHelp(cmd);
      expect(help).toContain(`graph-it ${cmd}`);
    }
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
    const { findWorkspaceRoot } = await import("../../src/cli/runtime.js");
    const subDir = path.join(tmpDir, "src");
    const root = findWorkspaceRoot(subDir);
    expect(root).toBe(tmpDir);
  });
});
