import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeOutOfRootImports,
  findMonorepoRoot,
  reportOutOfRootImports,
  findWorkspaceRoot,
  toDisplayPath,
  toReportableSpecifier,
} from "@/analyzer/utils/workspaceBoundary";

/** Regression tests for #264: a sub-package root must say what it leaves out. */
describe("workspaceBoundary", () => {
  let tmp: string;
  let pkg: string;

  const write = (relative: string, content = "{}") => {
    const file = path.join(tmp, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-boundary-")));
    pkg = path.join(tmp, "apps", "worker");
    write("apps/worker/package.json");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe("findWorkspaceRoot", () => {
    it("climbs from a nested directory to the nearest package root", () => {
      fs.mkdirSync(path.join(pkg, "src", "deep"), { recursive: true });
      expect(findWorkspaceRoot(path.join(pkg, "src", "deep"))).toBe(pkg);
    });
  });

  describe("findMonorepoRoot", () => {
    it("detects package.json workspaces above the package", () => {
      write("package.json", '{ "workspaces": ["apps/*"] }');
      expect(findMonorepoRoot(pkg)).toBe(tmp);
    });

    it.each(["pnpm-workspace.yaml", "lerna.json", ".git"])("detects %s above the package", (marker) => {
      write(marker, "");
      expect(findMonorepoRoot(pkg)).toBe(tmp);
    });

    it("detects a .git directory, not only a .git file", () => {
      fs.mkdirSync(path.join(tmp, ".git"));
      expect(findMonorepoRoot(pkg)).toBe(tmp);
    });

    it("ignores the workspace root itself and returns the closest ancestor", () => {
      write("apps/worker/pnpm-workspace.yaml", "");
      write("apps/lerna.json");
      write("lerna.json");
      expect(findMonorepoRoot(pkg)).toBe(path.join(tmp, "apps"));
    });

    it("skips a package.json without workspaces and an unreadable one", () => {
      write("apps/package.json", '{ "name": "apps" }');
      write("package.json", "{ not json");
      // tmp sits under the OS temp dir, which is no monorepo root.
      expect(findMonorepoRoot(pkg)).toBeNull();
    });
  });

  describe("toReportableSpecifier", () => {
    it.each(["@core/x", "../../core/src/x", "./y", "lodash"])("keeps the non-absolute %s", (specifier) => {
      expect(toReportableSpecifier(specifier)).toBe(specifier);
    });

    it.each([
      ["/home/user/repo/core/x.ts", "[external:x.ts]"],
      ["C:\\Users\\dev\\repo\\core\\x.ts", "[external:x.ts]"],
      ["C:/repo/core/x", "[external:x]"],
      ["\\\\server\\share\\core\\x.ts", "[external:x.ts]"],
    ])("reduces the absolute %s to its last segment", (specifier, expected) => {
      expect(toReportableSpecifier(specifier)).toBe(expected);
    });
  });

  describe("toDisplayPath", () => {
    it("returns the POSIX relative path, or . for the same directory", () => {
      expect(toDisplayPath("/repo/apps/worker", "/repo", path.posix)).toBe("../..");
      expect(toDisplayPath("/repo", "/repo", path.posix)).toBe(".");
    });

    it("uses forward slashes for Windows paths and is case-insensitive on the drive", () => {
      expect(toDisplayPath("C:\\repo\\apps\\worker", "c:\\repo", path.win32)).toBe("../..");
      expect(toDisplayPath("C:\\repo", "C:\\repo\\packages\\core", path.win32)).toBe("packages/core");
    });

    it("returns null across Windows drives, where no relative path exists", () => {
      expect(toDisplayPath("C:\\repo\\apps", "D:\\repo", path.win32)).toBeNull();
    });

    it("defaults to the host path module", () => {
      expect(toDisplayPath(pkg, tmp)).toBe("../..");
    });
  });

  describe("describeOutOfRootImports", () => {
    it("returns null when nothing was skipped", () => {
      expect(describeOutOfRootImports({ count: 0, examples: [] }, "../..")).toBeNull();
    });

    it("uses the singular and names the detected monorepo root", () => {
      expect(describeOutOfRootImports({ count: 1, examples: ["@core/x"] }, "../..")).toBe(
        "1 import resolves outside the workspace root and was skipped (e.g. @core/x); " +
          "dependents, impact and dead-code results cover this root only. Monorepo root detected (../..).",
      );
    });

    it("uses the plural and omits what it does not know", () => {
      expect(describeOutOfRootImports({ count: 3, examples: [] }, null)).toBe(
        "3 imports resolve outside the workspace root and were skipped; " +
          "dependents, impact and dead-code results cover this root only.",
      );
    });
  });

  describe("reportOutOfRootImports", () => {
    it("says the count is unknown, not 0, when it was not tracked (no reverse index)", () => {
      const report = reportOutOfRootImports(null, pkg);

      expect(report).not.toHaveProperty("outOfRootImports");
      expect(report.warning).toContain("not counted while the reverse index is off");
    });

    it("reports only the zero count when nothing was skipped", () => {
      expect(reportOutOfRootImports({ count: 0, examples: [] }, pkg)).toEqual({ outOfRootImports: 0 });
    });

    it("adds examples, the relative monorepo root and a warning naming every surface's remedy", () => {
      write("package.json", '{ "workspaces": ["apps/*"] }');

      const report = reportOutOfRootImports({ count: 1, examples: ["@core/x"] }, pkg);

      expect(report).toMatchObject({ outOfRootImports: 1, outOfRootImportExamples: ["@core/x"], monorepoRoot: "../.." });
      expect(report.warning).toContain("Monorepo root detected (../..).");
      expect(report.warning).toContain("CLI --workspace, MCP graphitlive_set_workspace, VS Code");
      expect(JSON.stringify(report)).not.toContain(tmp);
    });

    it("omits monorepoRoot when no monorepo root lies above", () => {
      const report = reportOutOfRootImports({ count: 1, examples: ["@core/x"] }, pkg);

      expect(report).not.toHaveProperty("monorepoRoot");
      expect(report.warning).not.toContain("Monorepo root detected");
    });
  });
});
