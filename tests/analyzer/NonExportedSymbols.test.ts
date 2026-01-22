import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Spider } from "../../src/analyzer/Spider";
import type { SymbolInfo } from "../../src/shared/types";

describe("SymbolAnalyzer - Non-Exported Symbols", () => {
  let tempDir: string;
  let testFilePath: string;
  let spider: Spider;

  beforeAll(async () => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-live-test-"));

    // Create test file with mix of exported and non-exported symbols
    testFilePath = path.join(tempDir, "test-symbols.ts");
    fs.writeFileSync(
      testFilePath,
      `// Non-exported internal class
class InternalHelper {
  private value: number = 42;
  
  getValue(): number {
    return this.value;
  }
}

// Non-exported function
function internalCalculate(x: number): number {
  return x * 2;
}

// Non-exported variable
const SECRET_KEY = 'internal-secret';

// Exported class that uses internal helper
export class PublicService {
  private helper = new InternalHelper();
  
  getResult(): number {
    return this.helper.getValue();
  }
}

// Exported function that uses internal function
export function publicCalculate(x: number): number {
  return internalCalculate(x) + 10;
}

// Exported variable that uses internal constant
export const config = {
  key: SECRET_KEY,
  value: 123
};
`,
    );

    // Initialize Spider
    spider = new Spider({
      rootDir: tempDir,
      maxDepth: 10,
      excludeNodeModules: true,
    });
  });

  afterAll(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it("should extract non-exported classes", async () => {
    const result = await spider.getSymbolGraph(testFilePath);

    const internalHelper = result.symbols.find(
      (s: SymbolInfo) => s.name === "InternalHelper",
    );
    expect(internalHelper).toBeDefined();
    expect(internalHelper?.isExported).toBe(false);
    expect(internalHelper?.kind).toBe("ClassDeclaration");

    // Should also extract class methods (methods are named with ClassName.methodName)
    const getValue = result.symbols.find(
      (s: SymbolInfo) => s.name === "InternalHelper.getValue",
    );
    expect(getValue).toBeDefined();
    expect(getValue?.kind).toMatch(/Method/);
  });

  it("should extract non-exported functions", async () => {
    const result = await spider.getSymbolGraph(testFilePath);

    const internalCalculate = result.symbols.find(
      (s: SymbolInfo) => s.name === "internalCalculate",
    );
    expect(internalCalculate).toBeDefined();
    expect(internalCalculate?.isExported).toBe(false);
    expect(internalCalculate?.kind).toBe("FunctionDeclaration");
  });

  it("should extract non-exported variables", async () => {
    const result = await spider.getSymbolGraph(testFilePath);

    const secretKey = result.symbols.find(
      (s: SymbolInfo) => s.name === "SECRET_KEY",
    );
    expect(secretKey).toBeDefined();
    expect(secretKey?.isExported).toBe(false);
    expect(secretKey?.kind).toBe("VariableDeclaration");
  });

  it("should extract exported symbols with isExported=true", async () => {
    const result = await spider.getSymbolGraph(testFilePath);

    const publicService = result.symbols.find(
      (s: SymbolInfo) => s.name === "PublicService",
    );
    expect(publicService).toBeDefined();
    expect(publicService?.isExported).toBe(true);
    expect(publicService?.kind).toBe("ClassDeclaration");

    const publicCalculate = result.symbols.find(
      (s: SymbolInfo) => s.name === "publicCalculate",
    );
    expect(publicCalculate).toBeDefined();
    expect(publicCalculate?.isExported).toBe(true);

    const config = result.symbols.find((s: SymbolInfo) => s.name === "config");
    expect(config).toBeDefined();
    expect(config?.isExported).toBe(true);
  });

  it("should extract both exported and non-exported symbols together", async () => {
    const result = await spider.getSymbolGraph(testFilePath);

    // Should have all top-level symbols
    const symbolNames = result.symbols.map((s: SymbolInfo) => s.name);

    // Non-exported
    expect(symbolNames).toContain("InternalHelper");
    expect(symbolNames).toContain("internalCalculate");
    expect(symbolNames).toContain("SECRET_KEY");

    // Exported
    expect(symbolNames).toContain("PublicService");
    expect(symbolNames).toContain("publicCalculate");
    expect(symbolNames).toContain("config");

    // Total count (6 top-level + class methods)
    expect(result.symbols.length).toBeGreaterThanOrEqual(6);
  });

  it("should correctly flag isExported status", async () => {
    const result = await spider.getSymbolGraph(testFilePath);

    const exportedSymbols = result.symbols.filter(
      (s: SymbolInfo) => s.isExported,
    );
    const nonExportedSymbols = result.symbols.filter(
      (s: SymbolInfo) => !s.isExported,
    );

    // Should have both categories
    expect(exportedSymbols.length).toBeGreaterThan(0);
    expect(nonExportedSymbols.length).toBeGreaterThan(0);

    // Check specific exports
    expect(
      exportedSymbols.some((s: SymbolInfo) => s.name === "PublicService"),
    ).toBe(true);
    expect(
      exportedSymbols.some((s: SymbolInfo) => s.name === "publicCalculate"),
    ).toBe(true);

    // Check specific non-exports
    expect(
      nonExportedSymbols.some((s: SymbolInfo) => s.name === "InternalHelper"),
    ).toBe(true);
    expect(
      nonExportedSymbols.some(
        (s: SymbolInfo) => s.name === "internalCalculate",
      ),
    ).toBe(true);
  });
});
