import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPathWithinRoot,
  isPathWithinRootCanonical,
  toWorkspaceRelativePath,
  validateWorkspacePath,
} from "../../src/shared/pathSecurity";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

describe("pathSecurity", () => {
  it("accepts root descendants and rejects sibling prefixes", () => {
    expect(isPathWithinRoot("/project/src/file.ts", "/project")).toBe(true);
    expect(isPathWithinRoot("/project-other/file.ts", "/project")).toBe(false);
  });

  it("rejects an existing symbolic link that escapes the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-outside-"));
    temporaryPaths.push(root, outside);
    const outsideFile = path.join(outside, "secret.ts");
    const linkedFile = path.join(root, "linked.ts");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, linkedFile);

    expect(isPathWithinRootCanonical(linkedFile, root)).toBe(false);
    expect(() => validateWorkspacePath(linkedFile, root)).toThrow("symbolic link");
  });

  it("validates a future path through its nearest existing parent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-root-"));
    temporaryPaths.push(root);

    expect(() =>
      validateWorkspacePath(path.join(root, "future", "file.ts"), root),
    ).not.toThrow();
  });

  it("returns relative paths internally and redacts external paths", () => {
    expect(toWorkspaceRelativePath("/project/src/file.ts", "/project")).toBe(
      "src/file.ts",
    );
    expect(toWorkspaceRelativePath("/private/secret.ts", "/project")).toBe(
      "[external:secret.ts]",
    );
  });
});
