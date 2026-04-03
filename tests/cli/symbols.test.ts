import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { parseSymbolRef } from "@/cli/symbols";
import { CliError, ExitCode } from "@/cli/errors";

// Use path.resolve so ROOT is a fully-qualified absolute path on all platforms
// (on Windows path.resolve adds the current drive letter, e.g. "D:\workspace\project")
const ROOT = path.resolve("/workspace/project");

describe("parseSymbolRef", () => {
  it("parses file-only reference", () => {
    const result = parseSymbolRef("src/index.ts", ROOT);
    expect(result.filePath).toBe(path.join(ROOT, "src/index.ts"));
    expect(result.symbolName).toBeUndefined();
  });

  it("parses file#Symbol reference", () => {
    const result = parseSymbolRef("src/index.ts#main", ROOT);
    expect(result.filePath).toBe(path.join(ROOT, "src/index.ts"));
    expect(result.symbolName).toBe("main");
  });

  it("parses file#ClassName.method reference", () => {
    const result = parseSymbolRef("src/Foo.ts#Foo.bar", ROOT);
    expect(result.filePath).toBe(path.join(ROOT, "src/Foo.ts"));
    expect(result.symbolName).toBe("Foo.bar");
  });

  it("accepts absolute paths within workspace", () => {
    const absPath = path.join(ROOT, "src/utils.ts");
    const result = parseSymbolRef(`${absPath}#helper`, ROOT);
    expect(result.filePath).toBe(absPath);
    expect(result.symbolName).toBe("helper");
  });

  it("throws on empty reference", () => {
    expect(() => parseSymbolRef("", ROOT)).toThrow(CliError);
  });

  it("throws on empty symbol after #", () => {
    expect(() => parseSymbolRef("src/file.ts#", ROOT)).toThrow(CliError);
  });

  it("throws on empty file path", () => {
    expect(() => parseSymbolRef("#Symbol", ROOT)).toThrow(CliError);
  });

  it("throws SECURITY_VIOLATION for path outside workspace", () => {
    expect(() => {
      parseSymbolRef("/etc/passwd#Symbol", ROOT);
    }).toThrow(CliError);
    try {
      parseSymbolRef("/etc/passwd#Symbol", ROOT);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.SECURITY_VIOLATION);
    }
  });

  it("throws SECURITY_VIOLATION for path traversal", () => {
    try {
      parseSymbolRef("../../etc/passwd#x", ROOT);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.SECURITY_VIOLATION);
    }
  });
});
