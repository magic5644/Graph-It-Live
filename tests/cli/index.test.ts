/**
 * Unit tests for the top-level argv-scanning helpers in src/cli/index.ts.
 *
 * Regression coverage for two bugs found in `graph-it wiki --output <dir>`:
 *  1. findCommandStart() previously used a broken heuristic that returned -1
 *     whenever a string-valued global flag (e.g. --workspace <path>) preceded
 *     the command, silently falling back to node:util's parseArgs positionals
 *     — which swallow any subcommand flag it doesn't recognize (--output,
 *     --depth, --scope, --top, ...) into `values` and strip it from
 *     positionals, so the subcommand never saw it.
 *  2. commandWantsHelp()'s caller previously checked the global `values.help`
 *     flag before dispatching to a command, so `graph-it <cmd> --help` always
 *     printed the generic top-level help instead of the per-command help.
 */
import { describe, expect, it } from "vitest";
import { commandWantsHelp, findCommandStart } from "../../src/cli/index";

describe("findCommandStart", () => {
  it("finds the command when it is the first token", () => {
    expect(findCommandStart(["wiki", "--output", "my-wiki"], "wiki")).toBe(0);
  });

  it("skips a preceding string-valued global flag and its value (--workspace <path>)", () => {
    const argv = ["--workspace", "/tmp/project", "wiki", "--output", "my-wiki"];
    expect(findCommandStart(argv, "wiki")).toBe(2);
  });

  it("skips a preceding short string-valued global flag and its value (-w <path>)", () => {
    const argv = ["-w", "/tmp/project", "wiki", "--output", "my-wiki"];
    expect(findCommandStart(argv, "wiki")).toBe(2);
  });

  it("skips another preceding string-valued global flag and its value (--format <fmt>)", () => {
    const argv = ["--format", "json", "wiki", "--output", "my-wiki"];
    expect(findCommandStart(argv, "wiki")).toBe(2);
  });

  it("returns -1 when the command is not present", () => {
    expect(findCommandStart(["--workspace", "/tmp"], "wiki")).toBe(-1);
  });

  it("does not mistake a global flag's value for the command", () => {
    // The workspace path happens to be named "wiki" here — must not match at index 1.
    const argv = ["--workspace", "wiki", "wiki", "--output", "my-wiki"];
    expect(findCommandStart(argv, "wiki")).toBe(2);
  });
});

describe("commandWantsHelp", () => {
  it("returns true when --help is in the command's own args", () => {
    expect(commandWantsHelp("wiki", ["--help"], ["wiki", "--help"])).toBe(true);
  });

  it("returns true when -h is in the command's own args", () => {
    expect(commandWantsHelp("wiki", ["-h"], ["wiki", "-h"])).toBe(true);
  });

  it("returns true when --help appears after the command in raw argv", () => {
    expect(commandWantsHelp("wiki", [], ["wiki", "--help"])).toBe(true);
  });

  it("returns false when no help flag is present", () => {
    expect(commandWantsHelp("wiki", ["--output", "my-wiki"], ["wiki", "--output", "my-wiki"])).toBe(false);
  });

  it("returns false when --help appears before the command (belongs to a different context)", () => {
    expect(commandWantsHelp("wiki", [], ["--help", "wiki"])).toBe(false);
  });
});
