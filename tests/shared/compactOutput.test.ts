import { describe, expect, it } from "vitest";
import { compactOutput } from "../../src/shared/compactOutput";

describe("compactOutput", () => {
  it("keeps one path per file when id, path and relativePath repeat it", () => {
    expect(compactOutput({
      id: "/repo/src/a.ts",
      path: "/repo/src/a.ts",
      relativePath: "src/a.ts",
      dependentCount: 2,
    })).toEqual({ path: "src/a.ts", dependentCount: 2 });
  });

  it("keeps the relative path under the canonical key when the absolute one was not relativized", () => {
    // Windows CI: the root is a 8.3 short name, so the workspace prefix never matches.
    expect(compactOutput({ filePath: String.raw`C:\Users\RUNNER~1\Temp\ws\src\a.ts`, relativePath: "src/a.ts" }))
      .toEqual({ filePath: "src/a.ts" });
  });

  it("drops edge file fields already carried by the endpoints", () => {
    expect(compactOutput([{
      source: "src/a.ts",
      target: "src/b.ts",
      sourceRelative: "src/a.ts",
      targetRelative: "src/b.ts",
      sourceId: "src/a.ts:run:3",
      targetId: "src/b.ts:main:9",
      sourceFile: "src/a.ts",
      targetFile: "src/b.ts",
    }])).toEqual([{
      source: "src/a.ts",
      target: "src/b.ts",
      sourceId: "src/a.ts:run:3",
      targetId: "src/b.ts:main:9",
    }]);
  });

  it("keeps keys whose values differ", () => {
    const value = {
      id: "src/a.ts:run:3",
      path: "src/a.ts",
      relativePath: "src/other.ts",
      sourceId: "src/x.ts:run:1",
      sourceFile: "src/a.ts",
    };
    expect(compactOutput(value)).toEqual(value);
  });

  it("does not treat a path-segment suffix as the same file", () => {
    expect(compactOutput({ path: "/repo/src/xa.ts", relativePath: "a.ts" }))
      .toEqual({ path: "/repo/src/xa.ts", relativePath: "a.ts" });
  });

  it("removes undefined fields at every depth", () => {
    expect(compactOutput({ a: undefined, graph: { incomingEdges: undefined, hasCycle: true } }))
      .toEqual({ graph: { hasCycle: true } });
  });

  it("leaves primitives, null and non-plain objects untouched", () => {
    const date = new Date(0);
    expect(compactOutput(null)).toBeNull();
    expect(compactOutput("src/a.ts")).toBe("src/a.ts");
    expect(compactOutput({ when: date }).when).toBe(date);
  });
});
