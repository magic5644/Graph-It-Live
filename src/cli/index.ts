#!/usr/bin/env node
/**
 * Graph-It-Live CLI Entry Point
 *
 * Usage: graph-it <command> [options]
 *
 * Commands:
 *   scan              Index the workspace
 *   summary [file]    Workspace overview (+ optional codemap)
 *   trace <sym>       Trace execution flow from a symbol
 *   explain <file>    Explain file logic
 *   path <file>       Crawl dependency graph from file
 *   path-in <file>    List files that depend on a file
 *   check-dependencies <file>  Check incoming and outgoing dependencies
 *   cycles <file>     List confirmed dependency cycles involving file
 *   architecture      Build full workspace architecture graph
 *   check <file>      Check for unused symbols
 *   serve             Launch MCP stdio server
 *   tool <name>       Invoke any MCP tool directly
 *   install           Install CLI to system PATH (opt-in)
 *   update            Update CLI to the latest npm version
 *
 * Options:
 *   --workspace, -w   Workspace root (default: auto-detected)
 *   --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
 *   --help, -h        Show this help message
 *   --version, -v     Show version
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import { flushSession } from "../analyzer/stats/statsPersistence";
import { sessionStats } from "../shared/sessionStats";
import { classifyError, CliError, ExitCode } from "./errors";
import type { CliOutputFormat } from "./formatter";
import { CLI_OUTPUT_FORMATS } from "./formatter";
import { CliRuntime, findWorkspaceRoot } from "./runtime";
import { maybeNotifyCliUpdate } from "./versionCheck";

// ============================================================================
// Version (injected at build time via define, fallback for dev/test)
// ============================================================================
const VERSION = process.env.CLI_VERSION ?? "0.0.0-dev";

// Session stats: this process is the CLI entry point.
sessionStats.setSource("cli");

// Idempotent stats flush — end-of-run and exit paths may both fire.
let statsFlushed = false;
function flushStatsOnce(): void {
  if (statsFlushed) {
    return;
  }
  statsFlushed = true;
  try {
    // flushSession is synchronous — safe inside an exit handler.
    flushSession(sessionStats.snapshot());
  } catch {
    // Stats persistence is best-effort — never break the CLI run.
  }
}

// Covers every exit path (main uses process.exit throughout).
process.on("exit", () => {
  flushStatsOnce();
});

// Node does not emit 'exit' on unhandled SIGINT/SIGTERM (e.g. Ctrl+C during a
// long run) — flush, then exit with the conventional signal code.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    flushStatsOnce();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

const HELP = `
graph-it — Graph-It-Live standalone CLI

Usage: graph-it <command> [options]

Commands:
  scan              Index/re-index the workspace
  summary [file]    Workspace overview (+ optional per-file codemap)
  trace <sym>       Trace execution flow: file.ts#FunctionName
  explain <file>    Analyze file logic (intra-file call hierarchy)
  path <file>       Crawl dependency graph from entry file
  path-in <file>    Find incoming dependencies (who imports this file)
  check-dependencies <file>
                    Check incoming and outgoing dependencies for a file
  cycles <file>     List confirmed dependency cycles for a file
  architecture      Build full workspace architecture graph
  check <file>      Find unused exported symbols
  serve             Launch MCP stdio server (passthrough)
  tool <name>       Invoke any MCP tool: graph-it tool get_index_status
  install           Install CLI to system PATH (VS Code opt-in)
  update            Update graph-it to the latest version on npm
  query <question>   Query the codebase with natural language
  stats             Session token stats (TOON encoding size vs JSON equivalent + LLM usage)

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help
  --version, -v     Show version

Output Format Availability:
  Format    | scan | summary | trace | explain | path | architecture | check | tool
  ----------|------|---------|-------|---------|------|--------------|-------|-----
  text      |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |      ✓       |   ✓   |  ✓
  json      |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |      ✓       |   ✓   |  ✓
  toon      |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |      ✓       |   ✓   |  ✓
  markdown  |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |      ✓       |   ✓   |  ✓
  mermaid   |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |      ✓       |   ✓   |  ✓

MCP Client Integration:
  Use "graph-it serve" as the MCP server command in any MCP-compatible client.

  Claude Desktop (~/.config/claude/claude_desktop_config.json or macOS equivalent):
    {
      "mcpServers": {
        "graph-it-live": {
          "command": "graph-it",
          "args": ["serve"],
          "env": { "WORKSPACE_ROOT": "/path/to/project" }
        }
      }
    }

  VS Code / Cursor (.vscode/mcp.json or .cursor/mcp.json):
    {
      "servers": {
        "graph-it-live": {
          "type": "stdio",
          "command": "graph-it",
          "args": ["serve"],
          "env": { "WORKSPACE_ROOT": "\${workspaceFolder}" }
        }
      }
    }

  Claude Code CLI:
    claude mcp add graph-it -- graph-it serve

  Windsurf (~/.codeium/windsurf/mcp_config.json):
    {
      "mcpServers": {
        "graph-it-live": {
          "command": "graph-it",
          "args": ["serve"],
          "env": { "WORKSPACE_ROOT": "\${workspaceFolder}" }
        }
      }
    }

  Run "graph-it tool --list" to see all 20 available MCP tools.

Examples:
  graph-it scan
  graph-it summary
  graph-it trace src/index.ts#main
  graph-it explain src/utils.ts
  graph-it path src/index.ts
  graph-it path-in src/index.ts
  graph-it check-dependencies src/index.ts
  graph-it cycles src/index.ts
  graph-it architecture
  graph-it architecture --format mermaid
  graph-it check src/api.ts
  graph-it tool analyze_dependencies --filePath=/abs/path/file.ts
  graph-it update
`.trimStart();

// ============================================================================
// Helpers
// ============================================================================

function commandWantsHelp(command: string, commandArgs: string[], rawArgvSlice: string[]): boolean {
  return commandArgs.includes("--help") || commandArgs.includes("-h") ||
    (rawArgvSlice.includes("--help") && rawArgvSlice.indexOf(command) < rawArgvSlice.indexOf("--help")) ||
    (rawArgvSlice.includes("-h") && rawArgvSlice.indexOf(command) < rawArgvSlice.indexOf("-h"));
}

// ============================================================================
// Main
// ============================================================================

/** Handle the no-command case: launch REPL in TTY, print help otherwise. */
async function handleNoCommand(values: Record<string, unknown>): Promise<void> {
  if (process.stdin.isTTY) {
    const workspaceRaw = (values.workspace as string | undefined) ?? process.cwd();
    const workspaceRoot = findWorkspaceRoot(path.resolve(workspaceRaw));
    await maybeNotifyCliUpdate({ workspaceRoot, currentVersion: VERSION });
    const { run } = await import("./commands/repl.js");
    await run(new CliRuntime(workspaceRoot));
    process.exit(ExitCode.SUCCESS);
  }
  process.stdout.write(HELP);
  process.exit(ExitCode.SUCCESS);
}

async function maybeRunStartupUpdateCheck(command: string, workspaceRoot: string): Promise<void> {
  if (command === "install" || command === "update") {
    return;
  }

  await maybeNotifyCliUpdate({
    workspaceRoot,
    currentVersion: VERSION,
  });
}

async function main(): Promise<void> {
  let parsedArgs: ReturnType<typeof parseArgs>;

  try {
    parsedArgs = parseArgs({
      args: process.argv.slice(2),
      options: {
        workspace: { type: "string", short: "w" },
        format: { type: "string", short: "f" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(ExitCode.GENERAL_ERROR);
  }

  const { values, positionals } = parsedArgs;

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(ExitCode.SUCCESS);
  }

  if (values.version) {
    process.stdout.write(`graph-it-live v${VERSION}\n`);
    process.exit(ExitCode.SUCCESS);
  }

  const [command, ...commandArgs] = positionals;

  if (!command) {
    await handleNoCommand(values);
    return;
  }

  // Per-command --help dispatch (check both parsed positionals and raw argv flags)
  const rawArgvSlice = process.argv.slice(2);
  if (commandWantsHelp(command, commandArgs, rawArgvSlice)) {
    const { getCommandHelp } = await import("./commandHelp.js");
    process.stdout.write(getCommandHelp(command));
    process.exit(ExitCode.SUCCESS);
  }

  // Preserve raw argv only for `tool`, where subcommand-specific flags may need
  // to survive top-level parsing. Other commands should use parsed positionals so
  // global flags like --workspace/--format are not treated as command args.
  const argvAfterBinary = process.argv.slice(2);
  const commandPosInArgv = argvAfterBinary.findIndex(
    (a, i) => a === command && !argvAfterBinary.slice(0, i).some(prev => !prev.startsWith("-") && prev !== command),
  );
  const rawCommandArgs = (command === "tool" || command === "architecture") && commandPosInArgv >= 0
    ? argvAfterBinary.slice(commandPosInArgv + 1)
    : commandArgs;

  // Validate output format
  const format = (values.format ?? "text") as CliOutputFormat;
  if (!CLI_OUTPUT_FORMATS.includes(format)) {
    process.stderr.write(
      `Error: Unknown format "${format}". Valid formats: ${CLI_OUTPUT_FORMATS.join(", ")}\n`,
    );
    process.exit(ExitCode.GENERAL_ERROR);
  }

  // Resolve workspace
  const workspaceRaw = (values.workspace as string | undefined) ?? process.cwd();
  const workspaceRoot = findWorkspaceRoot(path.resolve(workspaceRaw));
  const runtime = new CliRuntime(workspaceRoot);

  // Commands that don't need a workspace (skip runtime init to avoid side-effects)
  const WORKSPACE_FREE = new Set(["install", "update", "stats"]);

  try {
    if (!WORKSPACE_FREE.has(command)) {
      runtime.enableErrorCollection();
      await runtime.init();
      runtime.disableErrorCollection(); // Discard init errors (parse/analysis)
    }

    await maybeRunStartupUpdateCheck(command, workspaceRoot);

    runtime.enableErrorCollection();
    const output = await dispatch(command, rawCommandArgs, runtime, format);
    runtime.disableErrorCollection(); // Discard command parse errors
    if (output) {
      process.stdout.write(output.endsWith("\n") ? output : output + "\n");
    }
    process.exitCode = ExitCode.SUCCESS;
  } catch (err) {
    const { message, exitCode } = classifyError(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = exitCode;
  } finally {
    await runtime.dispose().catch(() => {/* best-effort */});
  }
}

// ============================================================================
// Command Dispatcher
// ============================================================================

async function dispatch(
  command: string,
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  switch (command) {
    case "scan": {
      const { run } = await import("./commands/scan.js");
      return run(args, runtime, format);
    }
    case "summary": {
      const { run } = await import("./commands/summary.js");
      return run(args, runtime, format);
    }
    case "trace": {
      const { run } = await import("./commands/trace.js");
      return run(args, runtime, format);
    }
    case "explain": {
      const { run } = await import("./commands/explain.js");
      return run(args, runtime, format);
    }
    case "path": {
      const { run } = await import("./commands/path.js");
      return run(args, runtime, format);
    }
    case "path-in": {
      const { run } = await import("./commands/pathIn.js");
      return run(args, runtime, format);
    }
    case "check-dependencies": {
      const { run } = await import("./commands/checkDependencies.js");
      return run(args, runtime, format);
    }
    case "cycles": {
      const { run } = await import("./commands/cycles.js");
      return run(args, runtime, format);
    }
    case "architecture": {
      const { run } = await import("./commands/architecture.js");
      return run(args, runtime, format);
    }
    case "check": {
      const { run } = await import("./commands/check.js");
      return run(args, runtime, format);
    }
    case "serve": {
      const { run } = await import("./commands/serve.js");
      return run(args, runtime, format);
    }
    case "tool": {
      const { run } = await import("./commands/tool.js");
      return run(args, runtime, format);
    }
    case "install": {
      const { run } = await import("./install.js");
      return run(args, runtime, format);
    }
    case "update": {
      const { run } = await import("./commands/update.js");
      return run(args, runtime, format);
    }
    case "query": {
      const { run } = await import("./commands/query.js");
      return run(args, runtime, format);
    }
    case "wiki": {
      const { run } = await import("./commands/wiki.js");
      return run(args, runtime, format);
    }
    case "stats": {
      const { run } = await import("./commands/stats.js");
      return run(args, runtime, format);
    }
    case "export": {
      if (format === "html") {
        const { runExportHtml } = await import("./commands/ExportHtmlCommand.js");
        const workspaceName = runtime.workspaceRoot.split("/").pop() ?? "workspace";
        await runExportHtml(runtime, workspaceName, args);
        return "";
      }
      throw new CliError(
        `Command "export" only supports --format html. Got: "${format}".`,
        ExitCode.GENERAL_ERROR,
      );
    }
    default:
      throw new CliError(
        `Unknown command "${command}". Run graph-it --help for usage.`,
        ExitCode.GENERAL_ERROR,
      );
  }
}

// Start
main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(ExitCode.GENERAL_ERROR);
});
