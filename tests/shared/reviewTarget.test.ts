import { describe, expect, it } from "vitest";
import { parseReviewCallGraphDepth, resolveReviewCallGraphPath, validateReviewCallGraphTarget } from "../../src/shared/reviewTarget";

describe("review call graph targets", () => {
  it("accepts relative POSIX and Windows-style targets and defaults the depth", () => {
    expect(validateReviewCallGraphTarget({ file: "src/api.ts", symbol: "greet", depth: 3 })).toEqual({ file: "src/api.ts", symbol: "greet", depth: 3 });
    expect(validateReviewCallGraphTarget({ file: "src\\api.ts" })).toEqual({ file: "src\\api.ts", symbol: undefined, depth: 3 });
    expect(resolveReviewCallGraphPath("/workspace", "src/api.ts")).toBe("/workspace/src/api.ts");
    expect(parseReviewCallGraphDepth("3")).toBe(3);
    expect(parseReviewCallGraphDepth()).toBe(3);
    expect(parseReviewCallGraphDepth(null)).toBe(3);
    expect([parseReviewCallGraphDepth("1"), parseReviewCallGraphDepth("5")]).toEqual([1, 5]);
  });

  it("rejects missing and malformed targets, numeric coercion, root paths, and traversal", () => {
    for (const target of [undefined, null, "src/api.ts", {}, { file: "" }, { file: "/tmp/api.ts" }, { file: "src/api.ts", symbol: "" }, { file: "src/api.ts", symbol: 1 }]) {
      expect(() => validateReviewCallGraphTarget(target)).toThrow();
    }
    expect(() => validateReviewCallGraphTarget({ file: "src/api.ts", depth: "3" })).toThrow("depth");
    expect(() => validateReviewCallGraphTarget({ file: "src/api.ts", depth: Number.NaN })).toThrow("depth");
    expect(() => validateReviewCallGraphTarget({ file: "src/api.ts", depth: Infinity })).toThrow("depth");
    expect(() => validateReviewCallGraphTarget({ file: "src/api.ts", depth: 0 })).toThrow("depth");
    expect(() => validateReviewCallGraphTarget({ file: "src/api.ts", depth: 6 })).toThrow("depth");
    expect(() => validateReviewCallGraphTarget({ file: "src/api.ts", depth: 1.5 })).toThrow("depth");
    expect(() => resolveReviewCallGraphPath("/workspace", ".")).toThrow("outside the workspace");
    expect(() => resolveReviewCallGraphPath("/workspace", "../outside.ts")).toThrow("outside the workspace");
    expect(() => parseReviewCallGraphDepth("0")).toThrow("depth");
    expect(() => parseReviewCallGraphDepth("6")).toThrow("depth");
    expect(() => parseReviewCallGraphDepth("")).toThrow("depth");
    expect(() => parseReviewCallGraphDepth("3.0")).toThrow("depth");
    expect(() => parseReviewCallGraphDepth("Infinity")).toThrow("depth");
  });
});
