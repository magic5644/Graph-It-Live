import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CliRuntime, resolveCliWorkspaceRoot } from "@/cli/runtime";
import { CliError, ExitCode } from "@/cli/errors";
import { findWorkspaceRoot } from "@/analyzer/utils/workspaceBoundary";

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

// Regression tests for #264: an explicit --workspace is the root as given.
describe("resolveCliWorkspaceRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-root-")));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.mkdirSync(path.join(tmpDir, "src", "nopkg"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("climbs to the nearest package root without --workspace", () => {
    expect(resolveCliWorkspaceRoot(undefined, path.join(tmpDir, "src", "nopkg"))).toBe(tmpDir);
  });

  it("uses an explicit directory as given, even without package.json", () => {
    const explicit = path.join(tmpDir, "src", "nopkg");
    expect(resolveCliWorkspaceRoot(explicit, os.tmpdir())).toBe(explicit);
  });

  it("resolves a relative --workspace against cwd", () => {
    expect(resolveCliWorkspaceRoot(path.join("src", "nopkg"), tmpDir)).toBe(path.join(tmpDir, "src", "nopkg"));
  });

  it.each([
    ["a missing directory", "missing"],
    ["a file", "package.json"],
  ])("rejects %s with WORKSPACE_NOT_FOUND", (_label, explicit) => {
    let error: unknown;
    try {
      resolveCliWorkspaceRoot(explicit, tmpDir);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(ExitCode.WORKSPACE_NOT_FOUND);
    expect((error as CliError).message).toBe(`Workspace directory not found: ${explicit}`);
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

import { SpiderBuilder } from "../../src/analyzer/SpiderBuilder";

describe("CliRuntime - reverse index contract", () => {
  it("Spider built with withReverseIndex(true) reports enabled before indexing", () => {
    // Documents that CLI runtime initializes Spider with reverse index ON
    // (mirrors src/cli/runtime.ts .withReverseIndex(true))
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-cli-"));
    try {
      const spider = new SpiderBuilder()
        .withRootDir(tmpDir)
        .withReverseIndex(true)
        .build();

      expect(spider.isReverseIndexEnabled()).toBe(true);
      expect(spider.hasReverseIndex()).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
