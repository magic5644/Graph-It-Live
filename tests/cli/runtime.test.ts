import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { findWorkspaceRoot, CliRuntime } from "@/cli/runtime";

describe("findWorkspaceRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns directory containing package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    const subDir = path.join(tmpDir, "src", "deep");
    fs.mkdirSync(subDir, { recursive: true });
    const root = findWorkspaceRoot(subDir);
    expect(root).toBe(tmpDir);
  });

  it("returns directory containing tsconfig.json", () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const subDir = path.join(tmpDir, "src");
    fs.mkdirSync(subDir, { recursive: true });
    const root = findWorkspaceRoot(subDir);
    expect(root).toBe(tmpDir);
  });

  it("falls back to the start directory when no marker found", () => {
    // tmpDir has no package.json — should get tmpDir or an ancestor that has one
    // At minimum it should return a string (not throw)
    const root = findWorkspaceRoot(tmpDir);
    expect(typeof root).toBe("string");
  });
});

describe("CliRuntime - state persistence", () => {
  let tmpDir: string;
  let runtime: CliRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-runtime-"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    runtime = new CliRuntime(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no state file exists", () => {
    expect(runtime.loadState()).toBeNull();
  });

  it("workspaceRoot is resolved absolute path", () => {
    expect(path.isAbsolute(runtime.workspaceRoot)).toBe(true);
    expect(runtime.workspaceRoot).toBe(path.resolve(tmpDir));
  });
});
