import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFingerprint } from "@/cli/configFingerprint";

describe("configFingerprint", () => {
  let root: string;
  let source: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-config-")));
    fs.mkdirSync(path.join(root, "src"));
    source = path.join(root, "src", "entry.ts");
    fs.writeFileSync(source, "export const value = 1;");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("ignores source contents and file enumeration order", () => {
    const before = configFingerprint(root, [source]);
    fs.writeFileSync(source, "export const value = 2;");
    expect(before).toBeTypeOf("string");
    expect(configFingerprint(root, [source, source])).toBe(before);
  });

  it("tracks additions, edits and removals of inherited configurations", () => {
    fs.writeFileSync(path.join(root, "src", "tsconfig.json"), '{"extends":"../base"}');
    const missing = configFingerprint(root, [source]);
    fs.writeFileSync(path.join(root, "base.json"), '{"compilerOptions":{"baseUrl":"."}}');
    const added = configFingerprint(root, [source]);
    expect(added).not.toBe(missing);
    fs.writeFileSync(path.join(root, "base.json"), '{"compilerOptions":{"baseUrl":"src"}}');
    expect(configFingerprint(root, [source])).not.toBe(added);
    fs.rmSync(path.join(root, "base.json"));
    expect(configFingerprint(root, [source])).toBe(missing);
  });

  it("handles cycles and extensionless parent configs", () => {
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"extends":"./base"}');
    fs.writeFileSync(path.join(root, "base"), '{"extends":"./tsconfig.json"}');
    expect(configFingerprint(root, [source])).toBeTypeOf("string");
  });

  it("invalidates malformed configuration when it is repaired", () => {
    fs.writeFileSync(path.join(root, "package.json"), "{ invalid");
    const before = configFingerprint(root, [source]);
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    expect(before).toBeTypeOf("string");
    expect(configFingerprint(root, [source])).not.toBe(before);
  });

  it("disables persistence for external sources or inherited configurations", () => {
    expect(configFingerprint(root, [path.join(root, "..", "outside.ts")])).toBeUndefined();
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"extends":"../outside.json"}');
    expect(configFingerprint(root, [source])).toBeUndefined();
  });

  it("disables persistence when a config cannot be read as a file", () => {
    fs.mkdirSync(path.join(root, "tsconfig.json"));
    expect(configFingerprint(root, [source])).toBeUndefined();
  });
});
