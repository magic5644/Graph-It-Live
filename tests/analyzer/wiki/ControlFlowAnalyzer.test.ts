import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeControlFlow } from "../../../src/analyzer/wiki/ControlFlowAnalyzer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfa-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(filename: string, content: string): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeControlFlow", () => {
  it("returns empty array for a non-existent file", () => {
    const result = analyzeControlFlow(path.join(tmpDir, "does-not-exist.ts"));
    expect(result).toEqual([]);
  });

  it("returns empty array for a file with no exported functions", () => {
    const filePath = writeTmp("no-exports.ts", `
function internal() {
  if (true) { return 1; }
}
const x = 42;
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toEqual([]);
  });

  it("returns empty array for exported function with low complexity (< 2)", () => {
    const filePath = writeTmp("simple.ts", `
export function simple() {
  return 42;
}
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toEqual([]);
  });

  it("returns a control-flow diagram for exported function with if/else (complexity ≥ 2)", () => {
    const filePath = writeTmp("with-if.ts", `
export function doCheck(x: number): string {
  if (x > 0) {
    return "positive";
  } else {
    return "non-positive";
  }
}
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("control-flow");
    expect(result[0].title).toContain("doCheck");
    expect(result[0].mermaid).toContain("flowchart TD");
    expect(result[0].mermaid).toContain("doCheck");
  });

  it("returns diagram containing switch node for function with switch statement", () => {
    const filePath = writeTmp("with-switch.ts", `
export function handleStatus(status: string): number {
  switch (status) {
    case "ok": return 200;
    case "not-found": return 404;
    case "error": return 500;
    default: return 0;
  }
}
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].mermaid).toContain("switch");
  });

  it("shows ALL exported complex functions (no MAX_FUNCTIONS_PER_FILE limit)", () => {
    // Write 5 exported functions all with complexity >= 2
    const filePath = writeTmp("many-fns.ts", `
export function fn1(x: number) { if (x) { return 1; } else { return 2; } }
export function fn2(x: number) { if (x) { return 1; } else { return 2; } }
export function fn3(x: number) { if (x) { return 1; } else { return 2; } }
export function fn4(x: number) { if (x) { return 1; } else { return 2; } }
export function fn5(x: number) { if (x) { return 1; } else { return 2; } }
`);
    const result = analyzeControlFlow(filePath);
    expect(result.length).toBe(5);
  });

  it("does not set truncated for function count when all functions are shown", () => {
    const filePath = writeTmp("many-complex.ts", `
export function fn1(x: number) { if (x > 0) { return 1; } else { return 2; } }
export function fn2(x: number) { if (x > 0) { return 1; } else { return 2; } }
export function fn3(x: number) { if (x > 0) { return 1; } else { return 2; } }
export function fn4(x: number) { if (x > 0) { return 1; } else { return 2; } }
`);
    const result = analyzeControlFlow(filePath);
    // All 4 functions should be shown — no truncation note for function count
    expect(result.length).toBe(4);
    // None should have a "Showing X of Y" truncation note
    for (const diagram of result) {
      expect(diagram.truncationNote ?? "").not.toMatch(/Showing \d+ of \d+/);
    }
  });

  it("handles exported arrow function with if/else", () => {
    const filePath = writeTmp("arrow.ts", `
export const compute = (n: number): string => {
  if (n > 100) {
    return "big";
  } else {
    return "small";
  }
};
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain("compute");
  });

  it("handles exported class method with if/else", () => {
    const filePath = writeTmp("class.ts", `
export class MyService {
  process(value: number): string {
    if (value > 0) {
      return "positive";
    } else {
      return "negative";
    }
  }
}
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain("MyService.process");
  });

  it("handles try/catch/finally in exported function", () => {
    // try + catch + finally = complexity 2 (>= MIN_COMPLEXITY)
    const filePath = writeTmp("try-catch.ts", `
export function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (err) {
    return null;
  } finally {
    console.log("done");
  }
}
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].mermaid).toContain("try");
    expect(result[0].mermaid).toContain("catch");
  });

  it("diagram is not truncated for a function with moderate complexity", () => {
    const filePath = writeTmp("moderate.ts", `
export function moderate(x: number): number {
  if (x > 0) {
    return x * 2;
  } else {
    return x;
  }
}
`);
    const result = analyzeControlFlow(filePath);
    expect(result).toHaveLength(1);
    // truncated flag should be false for a small function
    expect(result[0].truncated).toBe(false);
  });

  it("sorts functions by complexity descending — most complex first", () => {
    // fn_low has if+else = complexity 2; fn_high has if+else+switch(4 cases) = complexity 6+
    const filePath = writeTmp("sort-order.ts", `
export function fn_low(x: number) {
  if (x > 0) {
    return 1;
  } else {
    return 0;
  }
}
export function fn_high(x: number, y: string) {
  if (x > 0) {
    return 1;
  } else {
    switch (y) {
      case "a": return 2;
      case "b": return 3;
      case "c": return 4;
      default: return 0;
    }
  }
}
`);
    const result = analyzeControlFlow(filePath);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // The first result should be fn_high (higher complexity)
    expect(result[0].title).toContain("fn_high");
  });
});
