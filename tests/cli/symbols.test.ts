import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closestPathsHint } from "@/analyzer/utils/SymbolLookup";
import { parseSymbolRef, parseTargetRef } from "@/cli/symbols";
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

  it("names only the given path when it resolves outside the workspace", () => {
    expect(() => parseSymbolRef("../outside.ts#run", ROOT)).toThrow('File path "../outside.ts" resolves outside workspace: pass a file of the workspace.');
  });

  it("echoes no control character of the argument", () => {
    expect(() => parseSymbolRef("../out\u0001side.ts#run", ROOT)).toThrow('File path "../out�side.ts" resolves outside workspace');
  });

  it("throws SECURITY_VIOLATION for path traversal", () => {
    try {
      parseSymbolRef("../../etc/passwd#x", ROOT);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.SECURITY_VIOLATION);
    }
  });

  it("throws SECURITY_VIOLATION for a sibling directory sharing the root prefix", () => {
    expect(() => parseSymbolRef(`${ROOT}-evil${path.sep}a.ts`, ROOT)).toThrow(
      expect.objectContaining({ exitCode: ExitCode.SECURITY_VIOLATION }),
    );
  });

  describe("with symbolic links", () => {
    let tmp: string;
    let workspace: string;

    beforeEach(() => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "symbols-symlink-")));
      workspace = path.join(tmp, "workspace");
      fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "outside"));
      fs.writeFileSync(path.join(tmp, "outside", "secret.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;");
      // "junction" lets the directory link work on Windows without admin rights
      fs.symlinkSync(path.join(tmp, "outside"), path.join(workspace, "link"), "junction");
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("throws SECURITY_VIOLATION for a symlink pointing outside the workspace", () => {
      expect(() => parseSymbolRef("link/secret.ts#x", workspace)).toThrow(
        expect.objectContaining({ exitCode: ExitCode.SECURITY_VIOLATION }),
      );
    });

    it("accepts a real file inside the workspace", () => {
      const result = parseSymbolRef("src/a.ts#a", workspace);
      expect(result.filePath).toBe(path.join(workspace, "src", "a.ts"));
    });
  });

  it.runIf(process.platform === "win32")("accepts a drive letter typed in another case on Windows", () => {
    const lowerDrive = ROOT[0].toLowerCase() + ROOT.slice(1);
    const upperDrive = ROOT[0].toUpperCase() + ROOT.slice(1);
    const result = parseSymbolRef(String.raw`${lowerDrive}\src\a.ts#main`, upperDrive);
    expect(result.symbolName).toBe("main");
    expect(result.filePath.toLowerCase()).toBe(path.join(ROOT, "src", "a.ts").toLowerCase());
  });
});

describe("parseTargetRef (#767)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "target-ref-")));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "service.ts"), "");
    fs.writeFileSync(path.join(root, "src", "server.ts"), "");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns an existing file with its symbol, backslashes included", () => {
    expect(parseTargetRef("src/service.ts#run", root)).toEqual({ filePath: path.join(root, "src", "service.ts"), symbolName: "run" });
    if (path.sep === "\\") expect(parseTargetRef(String.raw`src\service.ts`, root).filePath).toBe(path.join(root, "src", "service.ts"));
  });

  it("refuses a missing file with the closest workspace-relative names (exit 1)", () => {
    expect(() => parseTargetRef("src/servce.ts#run", root)).toThrow(expect.objectContaining({
      exitCode: ExitCode.GENERAL_ERROR,
      message: "File not found: src/servce.ts. Did you mean: src/service.ts, src/server.ts?",
    }));
    expect(() => parseTargetRef("src/zzzzzzzz.ts", root)).toThrow(/^File not found: src\/zzzzzzzz\.ts\.$/);
    expect(() => parseTargetRef("nope/a.ts", root)).toThrow(/^File not found: nope\/a\.ts\.$/);
  });

  it("refuses a folder, and a path outside the workspace (exit 5)", () => {
    expect(() => parseTargetRef("src", root)).toThrow("src is a folder: pass a file.");
    expect(() => parseTargetRef("../x.ts", root)).toThrow(expect.objectContaining({ exitCode: ExitCode.SECURITY_VIOLATION }));
  });

  it("names nothing when no sibling is close, or the folder is missing", () => {
    expect(closestPathsHint(path.join(root, "src", "qqqqqqqqq.ts"), root)).toBe("");
    expect(closestPathsHint(path.join(root, "missing", "a.ts"), root)).toBe("");
    expect(closestPathsHint(path.join(root, "src", "servic.ts"), root)).toMatch(/^ Did you mean: src\/service\.ts, /);
  });

  it("finds the file name in another folder when the folder is mistyped, never in node_modules or dot folders", () => {
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "service.ts"), "");
    fs.writeFileSync(path.join(root, ".cache", "service.ts"), "");
    expect(closestPathsHint(path.join(root, "lib", "Servce.ts"), root)).toBe(" Did you mean: src/service.ts, src/server.ts?");
  });
});
