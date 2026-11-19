import { describe, expect, it } from "vitest";
import { COMMAND_NAMES, COMMAND_SPECS, commandSpec, parseCommandArgs, resolveCommandFormat } from "@/cli/commandSpec";
import { ExitCode } from "@/cli/errors";

describe("parseCommandArgs", () => {
  it("puts positionals first wherever they sit, and splits --name=value", () => {
    expect(parseCommandArgs("path", ["--communities", "louvain", "src/a.ts", "--maxDepth=3"]))
      .toEqual(["src/a.ts", "--communities", "louvain", "--maxDepth", "3"]);
    expect(parseCommandArgs("diagram", ["--output", "-", "orders"])).toEqual(["orders", "--output", "-"]);
  });

  it("keeps the words of a question together and accepts - as a value", () => {
    expect(parseCommandArgs("query", ["how", "--depth", "2", "does", "it", "work"])).toEqual(["how", "does", "it", "work", "--depth", "2"]);
    expect(parseCommandArgs("export", ["-o", "-"])).toEqual(["-o", "-"]);
  });

  it("reads an optional value only when one follows", () => {
    expect(parseCommandArgs("diagram", ["--rules", "--baseline"])).toEqual(["--rules", "--baseline"]);
    expect(parseCommandArgs("diagram", ["--rules", "--baseline", "b.json"])).toEqual(["--rules", "--baseline", "b.json"]);
    expect(parseCommandArgs("diagram", ["--baseline", "--rules"])).toEqual(["--baseline", "--rules"]);
  });

  it("refuses an unknown option with the closest one (exit 1)", () => {
    expect(() => parseCommandArgs("architecture", ["--maxfiles", "3"])).toThrow(expect.objectContaining({
      exitCode: ExitCode.GENERAL_ERROR,
      message: "Unknown option --maxfiles for graph-it architecture. Did you mean --maxFiles? Run graph-it architecture --help for its options.",
    }));
    expect(() => parseCommandArgs("summary", ["--bogus"])).toThrow("Unknown option --bogus for graph-it summary. Run graph-it summary --help for its options.");
    expect(() => parseCommandArgs("update", ["--check"])).toThrow("Unknown option --check for graph-it update.");
    expect(() => parseCommandArgs("check", ["-x"])).toThrow("Unknown option -x for graph-it check.");
  });

  it("refuses a missing value, a value on a flag and an extra positional (exit 1)", () => {
    expect(() => parseCommandArgs("stats", ["--stats-dir"])).toThrow("--stats-dir needs a value. Run graph-it stats --help for its options.");
    expect(() => parseCommandArgs("trace", ["a.ts#f", "--maxDepth", "--format"])).toThrow("--maxDepth needs a value.");
    expect(() => parseCommandArgs("architecture", ["--matrix=yes"])).toThrow("--matrix takes no value.");
    expect(() => parseCommandArgs("summary", ["a.ts", "b.ts"])).toThrow(expect.objectContaining({
      exitCode: ExitCode.GENERAL_ERROR,
      message: "Unexpected argument for graph-it summary: b.ts. Run graph-it summary --help for its options.",
    }));
    expect(() => parseCommandArgs("scan", ["src"])).toThrow("Unexpected argument for graph-it scan: src.");
  });

  it("passes tool parameters through after the tool name, and checks the tool's own options before it", () => {
    expect(parseCommandArgs("tool", ["get_index_status", "--anything=1"])).toEqual(["get_index_status", "--anything=1"]);
    expect(parseCommandArgs("tool", ["--list"])).toEqual(["--list"]);
    expect(parseCommandArgs("tool", [])).toEqual([]);
    expect(() => parseCommandArgs("tool", ["--lst"])).toThrow("Unknown option --lst for graph-it tool. Did you mean --list?");
  });
});

describe("resolveCommandFormat", () => {
  it("passes text without --format, and a declared format", () => {
    expect(resolveCommandFormat("diagram", undefined)).toBe("text");
    expect(resolveCommandFormat("architecture", "csv")).toBe("csv");
    expect(resolveCommandFormat("export", "html")).toBe("html");
  });

  it("refuses a format the command does not write (exit 4), naming the ones it does", () => {
    expect(() => resolveCommandFormat("summary", "mermaid")).toThrow(expect.objectContaining({
      exitCode: ExitCode.UNSUPPORTED_FORMAT,
      message: "graph-it summary does not write --format mermaid: use text, json, toon, markdown.",
    }));
    expect(() => resolveCommandFormat("wiki", "text")).toThrow("graph-it wiki does not write --format text: use markdown, json, toon.");
    expect(() => resolveCommandFormat("scan", "bogus")).toThrow(expect.objectContaining({ exitCode: ExitCode.UNSUPPORTED_FORMAT }));
  });
});

describe("commandSpec", () => {
  it("refuses an unknown command with the closest one (exit 1)", () => {
    expect(() => commandSpec("archtecture")).toThrow(expect.objectContaining({
      exitCode: ExitCode.GENERAL_ERROR,
      message: 'Unknown command "archtecture". Did you mean architecture? Run graph-it --help for the commands.',
    }));
    expect(() => commandSpec("zzzzzz")).toThrow('Unknown command "zzzzzz". Run graph-it --help for the commands.');
  });

  it("declares at least one format and only known option spellings for every command", () => {
    for (const command of COMMAND_NAMES) {
      const spec = COMMAND_SPECS[command];
      expect(spec.formats.length, command).toBeGreaterThan(0);
      for (const option of Object.keys(spec.options)) expect(option, command).toMatch(/^--?[a-zA-Z][\w-]*$/);
    }
  });
});
