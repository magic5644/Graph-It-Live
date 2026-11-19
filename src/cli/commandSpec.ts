/**
 * What each CLI command accepts, in one place: its options, how many positionals it reads and
 * the output formats it really renders. main() checks a command line against it before any
 * work, and the contract tests check the help text and every format against it.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { closestNames } from "../analyzer/utils/SymbolLookup";
import { CliError, ExitCode } from "./errors";
import type { CliOutputFormat } from "./formatter";

/** `flag`: no value; `value`: one value; `optional-value`: a value when the next token is not an option. */
export type OptionKind = "flag" | "value" | "optional-value";

export interface CommandSpec {
  /** Formats the command renders; the first one is what it writes without --format. */
  readonly formats: readonly CliOutputFormat[];
  readonly options: Readonly<Record<string, OptionKind>>;
  readonly maxPositionals: number;
  /** Any `--<name>` is accepted: `tool` passes them to the MCP tool, which checks them. */
  readonly passthrough?: true;
}

const REPORT: readonly CliOutputFormat[] = ["text", "json", "toon", "markdown"];
const GRAPH: readonly CliOutputFormat[] = [...REPORT, "mermaid"];

export const COMMAND_SPECS: Readonly<Record<string, CommandSpec>> = {
  scan: { formats: REPORT, options: {}, maxPositionals: 0 },
  summary: { formats: REPORT, options: {}, maxPositionals: 1 },
  trace: { formats: GRAPH, options: { "--maxDepth": "value" }, maxPositionals: 1 },
  explain: { formats: REPORT, options: {}, maxPositionals: 1 },
  path: { formats: GRAPH, options: { "--maxDepth": "value", "--communities": "value" }, maxPositionals: 1 },
  "path-in": { formats: GRAPH, options: {}, maxPositionals: 1 },
  "check-dependencies": { formats: GRAPH, options: {}, maxPositionals: 1 },
  cycles: { formats: REPORT, options: {}, maxPositionals: 1 },
  architecture: {
    formats: [...GRAPH, "csv"],
    options: {
      "--maxFiles": "value", "--communities": "value", "--groups": "flag", "--level": "value",
      "--folder": "value", "--from": "value", "--to": "value", "--matrix": "flag",
    },
    maxPositionals: 0,
  },
  "check-architecture": {
    formats: [...REPORT, "sarif"],
    options: { "--config": "value", "--baseline": "value", "--update-baseline": "flag", "--verbose": "flag" },
    maxPositionals: 0,
  },
  init: {
    formats: REPORT,
    options: { "--yes": "flag", "--dry-run": "flag", "--output": "value", "--focus": "value" },
    maxPositionals: 0,
  },
  diagram: {
    formats: ["html", "svg", "diagram-spec"],
    options: {
      "--view": "value", "--folder": "value", "--theme": "value", "--output": "value",
      "--rules": "flag", "--config": "value", "--baseline": "optional-value",
    },
    maxPositionals: 1,
  },
  check: {
    formats: REPORT,
    options: { "--minConfidence": "value", "--verbose": "flag", "--unreferencedFiles": "flag" },
    maxPositionals: 1,
  },
  "review-pr": {
    formats: [...REPORT, "sarif"],
    // --max-files: the spelling of 1.25.4 and earlier, still passed by the review gate action.
    options: { "--base": "value", "--head": "value", "--depth": "value", "--maxFiles": "value", "--max-files": "value" },
    maxPositionals: 0,
  },
  serve: { formats: ["text"], options: {}, maxPositionals: 0 },
  tool: { formats: GRAPH, options: { "--list": "flag", "--args": "value" }, maxPositionals: 1, passthrough: true },
  install: { formats: ["text"], options: {}, maxPositionals: 0 },
  update: { formats: ["text"], options: {}, maxPositionals: 0 },
  query: { formats: ["text", "json", "toon"], options: { "--depth": "value", "--token-budget": "value" }, maxPositionals: Infinity },
  context: {
    formats: ["text", "json", "toon"],
    options: {
      "--mode": "value", "--seeds": "value", "--relations": "value", "--scope": "value", "--depth": "value",
      "--max-nodes": "value", "--token-budget": "value", "--directed": "flag", "--cursor": "value",
      "--detail": "value", "--from": "value", "--to": "value",
    },
    maxPositionals: Infinity,
  },
  wiki: {
    formats: ["markdown", "json", "toon"],
    options: { "--output": "value", "--force": "flag", "--scope": "value", "--exclude": "value", "--top": "value" },
    maxPositionals: 0,
  },
  stats: { formats: ["text", "json", "markdown"], options: { "--stats-dir": "value" }, maxPositionals: 0 },
  export: { formats: ["html"], options: { "--output": "value", "-o": "value", "--communities": "value" }, maxPositionals: 1 },
};

export const COMMAND_NAMES = Object.keys(COMMAND_SPECS);

/** ` Did you mean x?` when `wanted` is close to one of `names`, else "". */
function suggestion(names: string[], wanted: string): string {
  const [closest] = closestNames(names, wanted, 1);
  return closest ? ` Did you mean ${closest}?` : "";
}

/** The spec of `command`; an unknown command exits 1 with the closest one. */
export function commandSpec(command: string): CommandSpec {
  const spec = COMMAND_SPECS[command];
  if (spec) return spec;
  throw new CliError(`Unknown command "${command}".${suggestion(COMMAND_NAMES, command)} Run graph-it --help for the commands.`, ExitCode.GENERAL_ERROR);
}

/**
 * The format to run with: `requested` when the command renders it, else exit 4 naming the ones
 * it does. Without --format, "text": commands that write another format read it as their default.
 */
export function resolveCommandFormat(command: string, requested: string | undefined): CliOutputFormat {
  const { formats } = commandSpec(command);
  if (requested === undefined) return "text";
  const format = formats.find((candidate) => candidate === requested);
  if (format) return format;
  throw new CliError(
    `graph-it ${command} does not write --format ${requested}: use ${formats.join(", ")}.`,
    ExitCode.UNSUPPORTED_FORMAT,
  );
}

const helpHint = (command: string) => `Run graph-it ${command} --help for its options.`;

/** One option of the command line: its name, then its value when it takes one, and the tokens it used. */
function readOption(command: string, spec: CommandSpec, token: string, next: string | undefined): { tokens: string[]; used: number } {
  const equals = token.startsWith("--") ? token.indexOf("=") : -1;
  const name = equals < 0 ? token : token.slice(0, equals);
  const kind = spec.options[name];
  if (kind === undefined) {
    throw new CliError(`Unknown option ${name} for graph-it ${command}.${suggestion(Object.keys(spec.options), name)} ${helpHint(command)}`, ExitCode.GENERAL_ERROR);
  }
  if (equals >= 0) {
    if (kind === "flag") throw new CliError(`${name} takes no value. ${helpHint(command)}`, ExitCode.GENERAL_ERROR);
    return { tokens: [name, token.slice(equals + 1)], used: 1 };
  }
  const hasValue = next !== undefined && (!next.startsWith("-") || next === "-");
  if (kind === "value" && !hasValue) throw new CliError(`${name} needs a value. ${helpHint(command)}`, ExitCode.GENERAL_ERROR);
  return kind !== "flag" && hasValue ? { tokens: [name, next], used: 2 } : { tokens: [name], used: 1 };
}

/**
 * The command's arguments with every positional first, then its options, `--name=value` split in
 * two, so commands read `args[0]` and `indexOf(flag)` wherever the user put them. An unknown
 * option, a missing value or an extra positional exits 1 naming what the command takes.
 */
export function parseCommandArgs(command: string, args: string[]): string[] {
  const spec = commandSpec(command);
  // tool: its own options come first, the MCP tool's parameters after the tool name (checked by its schema).
  if (spec.passthrough && (!args[0]?.startsWith("-") || spec.options[args[0]] !== undefined)) return args;
  const positionals: string[] = [];
  const options: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token.startsWith("-") && token !== "-") {
      const { tokens, used } = readOption(command, spec, token, args[index + 1]);
      options.push(...tokens);
      index += used;
    } else {
      positionals.push(token);
      index += 1;
    }
  }
  if (positionals.length > spec.maxPositionals) {
    const extra = positionals.slice(spec.maxPositionals).join(" ");
    throw new CliError(`Unexpected argument for graph-it ${command}: ${extra}. ${helpHint(command)}`, ExitCode.GENERAL_ERROR);
  }
  return [...positionals, ...options];
}
