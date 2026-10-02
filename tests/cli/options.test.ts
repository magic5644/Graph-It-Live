import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "../../src/cli/errors";
import { readIntegerOption } from "../../src/cli/options";

describe("readIntegerOption", () => {
  it("returns undefined when the flag is absent", () => {
    expect(readIntegerOption(["src/a.ts"], "--maxDepth", { min: 1 })).toBeUndefined();
  });

  it.each([
    [["--maxDepth", "3"], 3],
    [["src/a.ts", "--maxDepth", "1"], 1],
    [["--maxDepth", "100"], 100],
    [["--maxDepth", " 7 "], 7],
  ])("reads %j", (args, expected) => {
    expect(readIntegerOption(args, "--maxDepth", { min: 1, max: 100 })).toBe(expected);
  });

  it.each([
    [["--maxDepth", "nope"], `--maxDepth must be an integer between 1 and 100, got "nope"`],
    [["--maxDepth", "2.5"], `--maxDepth must be an integer between 1 and 100, got "2.5"`],
    [["--maxDepth", "-1"], `--maxDepth must be an integer between 1 and 100, got "-1"`],
    [["--maxDepth", "0"], `--maxDepth must be an integer between 1 and 100, got "0"`],
    [["--maxDepth", "101"], `--maxDepth must be an integer between 1 and 100, got "101"`],
    [["--maxDepth", ""], `--maxDepth must be an integer between 1 and 100, got ""`],
    [["--maxDepth"], "--maxDepth must be an integer between 1 and 100, got no value"],
    [["--maxDepth", "--format"], "--maxDepth must be an integer between 1 and 100, got no value"],
    [["--maxDepth", "3abc"], `--maxDepth must be an integer between 1 and 100, got "3abc"`],
  ])("rejects %j", (args, message) => {
    expect(() => readIntegerOption(args, "--maxDepth", { min: 1, max: 100 })).toThrow(message);
  });

  it("states only the lower bound when there is no maximum", () => {
    expect(() => readIntegerOption(["--maxFiles", "0"], "--maxFiles", { min: 1 })).toThrow(
      `--maxFiles must be an integer >= 1, got "0"`,
    );
  });

  it("throws a CliError with a non-zero exit code", () => {
    try {
      readIntegerOption(["--top", "x"], "--top", { min: 1, max: 50 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(ExitCode.GENERAL_ERROR);
    }
  });
});
