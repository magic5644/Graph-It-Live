import path from "node:path";
import { describe, expect, it } from "vitest";
import { RustParser } from "../../src/analyzer/languages/RustParser";

/**
 * Test Suite: Rust External Crate Imports
 *
 * Regression test for issue where Graph-It-Live confused external crate imports
 * (like `use vm::Settings;`) with local modules, creating false cycles.
 *
 * Problem: RustParser used to treat `Settings` (external crate) as if it were
 * a local module file `Settings.rs`, creating case-sensitivity issues.
 *
 * Solution: Distinguish external crates from local modules, and normalize all
 * local module references to lowercase (Rust file naming convention).
 */
describe("Rust External Crate Imports", () => {
  const rootDir = path.resolve(__dirname, "../fixtures/rust-integration");
  const parser = new RustParser(rootDir);

  it("should distinguish external crates from local modules by rejecting known crates", async () => {
    // The RustParser has a whitelist of known external crates.
    // When it encounters these, it should skip them entirely.
    // This prevents false dependencies like vm → Settings.rs

    const mainFile = path.join(rootDir, "main.rs");
    const deps = await parser.parseImports(mainFile);
    const moduleNames = deps.map((d) => d.module);

    // Should NOT contain known external crate names
    const externalCrates = [
      "std",
      "core",
      "vm",
      "rustpython_vm",
      "tokio",
      "serde",
    ];
    for (const crate_ of externalCrates) {
      expect(moduleNames).not.toContain(crate_);
    }
  });

  it("should normalize local module names to lowercase", async () => {
    // Rust convention: module file names are always lowercase (snake_case)
    // Even if code references them differently, they resolve to lowercase files

    const mainFile = path.join(rootDir, "main.rs");
    const deps = await parser.parseImports(mainFile);

    // All extracted module names should be lowercase
    for (const dep of deps) {
      expect(dep.module).toBe(dep.module.toLowerCase());
    }
  });
});
