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
 *   check <file>      Check for unused symbols
 *   serve             Launch MCP stdio server
 *   tool <name>       Invoke any MCP tool directly
 *   install           Install CLI to system PATH (opt-in)
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

import { parseArgs } from "node:util";
import * as process from "node:process";
import * as path from "node:path";
import { CliError, classifyError, ExitCode } from "./errors";
import type { CliOutputFormat } from "./formatter";
import { CLI_OUTPUT_FORMATS } from "./formatter";
import { findWorkspaceRoot, CliRuntime } from "./runtime";

// ============================================================================
// Version (injected at build time via define, fallback to package.json read)
// ============================================================================
const VERSION = "0.0.1";

const HELP = `
graph-it — Graph-It-Live standalone CLI

Usage: graph-it <command> [options]

Commands:
  scan              Index/re-index the workspace
  summary [file]    Workspace overview (+ optional per-file codemap)
  trace <sym>       Trace execution flow: file.ts#FunctionName
  explain <file>    Analyze file logic (intra-file call hierarchy)
  path <file>       Crawl dependency graph from entry file
  check <file>      Find unused exported symbols
  serve             Launch MCP stdio server (passthrough)
  tool <name>       Invoke any MCP tool: graph-it tool get_index_status
  install           Install CLI to system PATH (VS Code opt-in)

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help
  --version, -v     Show version

Examples:
  graph-it scan
  graph-it summary
  graph-it trace src/index.ts#main
  graph-it explain src/utils.ts
  graph-it path src/index.ts
  graph-it check src/api.ts
  graph-it tool analyze_dependencies --filePath=/abs/path/file.ts
`.trimStart();

// ============================================================================
// Main
// ============================================================================

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
    process.stdout.write(HELP);
    process.exit(ExitCode.SUCCESS);
  }

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

  try {
    await runtime.init();
    const output = await dispatch(command, commandArgs, runtime, format);
    if (output) {
      process.stdout.write(output.endsWith("\n") ? output : output + "\n");
    }
    process.exit(ExitCode.SUCCESS);
  } catch (err) {
    const { message, exitCode } = classifyError(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(exitCode);
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
      const { run } = await import("./commands/scan");
      return run(args, runtime, format);
    }
    case "summary": {
      const { run } = await import("./commands/summary");
      return run(args, runtime, format);
    }
    case "trace": {
      const { run } = await import("./commands/trace");
      return run(args, runtime, format);
    }
    case "explain": {
      const { run } = await import("./commands/explain");
      return run(args, runtime, format);
    }
    case "path": {
      const { run } = await import("./commands/path");
      return run(args, runtime, format);
    }
    case "check": {
      const { run } = await import("./commands/check");
      return run(args, runtime, format);
    }
    case "serve": {
      const { run } = await import("./commands/serve");
      return run(args, runtime, format);
    }
    case "tool": {
      const { run } = await import("./commands/tool");
      return run(args, runtime, format);
    }
    case "install": {
      const { run } = await import("./install");
      return run(args, runtime, format);
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
