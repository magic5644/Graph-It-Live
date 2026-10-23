import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// #343 / #424: every architecture count the view shows comes from src/analyzer/architecture/**.
// The webview may count what it draws (expanded files, E2E measures), never the architecture data.
const webviewDir = path.resolve(__dirname, "../../../../src/webview/components/architecture");

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  {
    name: "a reduce summing an architecture count",
    pattern: /\.reduce\([^;]*\b(?:transitiveFiles|directFiles|reachedFiles|fileCount|fileEdgeCount|internalEdgeCount|totalGroups|hiddenGroups|hiddenGroupEdges)\b/,
  },
  { name: "a distinct count of layers, units or groups", pattern: /new Set\([^;]*\.(?:layer|unit|units|groupId|communityId)\b[^;]*\)\.size/ },
  { name: "a fallback for groupsByUnit", pattern: /groupsByUnit\?\./ },
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const violations = (text: string) => FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);

describe("architecture webview aggregation guard", () => {
  it("recognises the counts the webview used to derive", () => {
    expect(violations("const layers = new Set(level.units.map((unit) => unit.layer)).size;")).toEqual(["a distinct count of layers, units or groups"]);
    expect(violations("const outside = result?.groups.reduce((total, group) => total + group.transitiveFiles, 0) ?? 0;"))
      .toEqual(["a reduce summing an architecture count"]);
    expect(violations("const counts = level.groupsByUnit?.[unit] ?? { totalGroups: groups.length };")).toEqual(["a fallback for groupsByUnit"]);
    expect(violations("colors: new Set(units.map((node) => String(node.data(\"color\")))).size,")).toEqual([]);
  });

  it("finds no architecture aggregation in src/webview/components/architecture", () => {
    const files = sourceFiles(webviewDir);
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) =>
      fs.readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
        violations(line).map((name) => `${path.relative(webviewDir, file)}:${index + 1}: ${name}`)));
    expect(found).toEqual([]);
  });
});
