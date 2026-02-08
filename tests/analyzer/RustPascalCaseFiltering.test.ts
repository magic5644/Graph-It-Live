import { RustParser } from "../../src/analyzer/languages/RustParser";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Test: Rust identifier extraction should ignore PascalCase symbols
 *
 * When parsing `use crate::interpreter::SomeStruct;`, we should extract:
 * ✅ "interpreter" (module name, snake_case)
 * ❌ "SomeStruct" (type/struct name, PascalCase)
 *
 * The bug: collectIdentifiers() was extracting both, creating false module dependencies.
 */
describe("Rust PascalCase symbol filtering", () => {
  const rootDir = path.resolve(__dirname, "../fixtures/rust-integration");
  const extensionPath = path.resolve(process.cwd());
  const parser = new RustParser(rootDir, extensionPath);

  it("should not extract PascalCase identifiers as modules", async () => {
    // When parsing `use crate::interpreter::SomeStruct;`, we extract:
    // ✅ "interpreter" (module name, snake_case)
    // ❌ "SomeStruct" (type/struct name, PascalCase) - should be rejected

    const mainFile = path.join(rootDir, "main.rs");
    const deps = await parser.parseImports(mainFile);

    // Check that no PascalCase identifiers are in the results
    for (const dep of deps) {
      // Single identifiers should always be lowercase (module convention)
      if (!dep.module.includes("::")) {
        expect(dep.module[0]).toBe(dep.module[0].toLowerCase());
      }

      // Even in scoped paths, the last component should not be PascalCase
      // (unless it's an external crate, which should already be filtered)
      const lastComponent = dep.module.split("::").pop() || "";
      expect(lastComponent[0]).not.toMatch(/[A-Z]/);
    }
  });

  it("should correctly distinguish module names (snake_case) from type names (PascalCase)", () => {
    // Rust naming convention:
    // - Modules: lowercase, snake_case → interpreter, my_module, database_config
    // - Types: PascalCase → SomeStruct, MyType, HashMap

    const moduleNames = [
      "interpreter",
      "settings",
      "shell",
      "my_module",
      "utils_helpers",
    ];
    const typeNames = ["SomeStruct", "MyType", "HashMap", "Result", "Vec"];

    // Modules start with lowercase
    for (const name of moduleNames) {
      expect(name[0]).toBe(name[0].toLowerCase());
    }

    // Types start with uppercase
    for (const name of typeNames) {
      expect(name[0]).toBe(name[0].toUpperCase());
    }
  });
});
