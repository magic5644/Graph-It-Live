import path from "node:path";
import { describe, expect, it } from "vitest";
import { RustParser } from "../../src/analyzer/languages/RustParser";

/**
 * Test: Rust extern crate declarations should be ignored
 *
 * External crate declarations like `extern crate rustpython_vm;` should NOT
 * create file dependencies, because they are not local modules.
 */
describe("Rust extern crate filtering", () => {
  const rootDir = path.resolve(__dirname, "../fixtures/rust-integration");
  const extensionPath = path.resolve(process.cwd());
  const parser = new RustParser(rootDir, extensionPath);

  it("should not include extern crate declarations in dependencies", async () => {
    // `extern crate vm;` and `extern crate rustpython_vm;` declarations
    // should be filtered out - they are external crates, not local modules

    const mainFile = path.join(rootDir, "main.rs");
    const deps = await parser.parseImports(mainFile);
    const moduleNames = deps.map((d) => d.module);

    // Should NOT contain external crate names
    expect(moduleNames).not.toContain("vm");
    expect(moduleNames).not.toContain("rustpython_vm");
    expect(moduleNames).not.toContain("std");
    expect(moduleNames).not.toContain("core");

    // Verify only local modules like "utils" are included
    // (actual names depend on the fixture)
    for (const name of moduleNames) {
      // Should be lowercase (local module convention)
      expect(name).toBe(name.toLowerCase());
    }
  });
});
