import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFingerprint } from "@/analyzer/cache/configFingerprint";

const info = vi.hoisted(() => vi.fn());
vi.mock("@/shared/logger", () => ({ getLogger: () => ({ info }) }));

describe("configFingerprint", () => {
  let root: string;
  let source: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-config-")));
    fs.mkdirSync(path.join(root, "src"));
    source = path.join(root, "src", "entry.ts");
    fs.writeFileSync(source, "export const value = 1;");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    info.mockClear();
  });

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

  it("tracks parents of JSONC configs and array extends", () => {
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{\n  // tsc --init\n  "extends": ["./first.json", "./second.json"],\n}');
    fs.writeFileSync(path.join(root, "first.json"), "{}");
    fs.writeFileSync(path.join(root, "second.json"), '{ /* JSONC parent */ "compilerOptions": {}, }');
    const before = configFingerprint(root, [source]);
    fs.writeFileSync(path.join(root, "first.json"), '{"compilerOptions":{"baseUrl":"."}}');
    const firstEdited = configFingerprint(root, [source]);
    expect(firstEdited).not.toBe(before);
    fs.writeFileSync(path.join(root, "second.json"), '{ /* JSONC parent */ "compilerOptions": { "baseUrl": "src" }, }');
    expect(configFingerprint(root, [source])).not.toBe(firstEdited);
  });

  it("tracks configs extended from workspace node_modules", () => {
    const base = path.join(root, "node_modules", "@acme", "tsconfig", "base.json");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(base), "package.json"), '{"name":"@acme/tsconfig"}');
    fs.writeFileSync(base, "{}");
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"extends":"@acme/tsconfig/base.json"}');
    const before = configFingerprint(root, [source]);
    fs.writeFileSync(base, '{"compilerOptions":{"baseUrl":"."}}');
    expect(configFingerprint(root, [source])).not.toBe(before);
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

  describe("configs inherited from outside the workspace", () => {
    let workspace: string;
    let workspaceSource: string;
    const base = () => path.join(root, "tsconfig.base.json");
    beforeEach(() => {
      workspace = path.join(root, "packages", "p1");
      fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
      workspaceSource = path.join(workspace, "src", "a.ts");
      fs.writeFileSync(workspaceSource, "export const a = 1;");
      fs.writeFileSync(path.join(workspace, "tsconfig.json"), '{"extends":"../../tsconfig.base.json"}');
    });

    it("fingerprints an external base and tracks its edits", () => {
      fs.writeFileSync(base(), '{"compilerOptions":{"strict":true}}');
      const before = configFingerprint(workspace, [workspaceSource]);
      expect(before).toBeTypeOf("string");
      expect(configFingerprint(workspace, [workspaceSource])).toBe(before);
      fs.writeFileSync(base(), '{"compilerOptions":{"strict":false}}');
      expect(configFingerprint(workspace, [workspaceSource])).not.toBe(before);
      expect(info).not.toHaveBeenCalled();
    });

    it("keeps a stable fingerprint while the external base is missing", () => {
      const missing = configFingerprint(workspace, [workspaceSource]);
      expect(missing).toBeTypeOf("string");
      expect(configFingerprint(workspace, [workspaceSource])).toBe(missing);
    });

    it("follows JSONC and array extends chains outside the workspace", () => {
      fs.writeFileSync(path.join(workspace, "tsconfig.json"), '{\n  // monorepo\n  "extends": ["../../tsconfig.base.json", "../../strict"],\n}');
      fs.writeFileSync(base(), '{ /* JSONC */ "extends": "./root.json", }');
      fs.writeFileSync(path.join(root, "root.json"), "{}");
      fs.writeFileSync(path.join(root, "strict.json"), "{}");
      const before = configFingerprint(workspace, [workspaceSource]);
      fs.writeFileSync(path.join(root, "root.json"), '{"compilerOptions":{"baseUrl":"."}}');
      const rootEdited = configFingerprint(workspace, [workspaceSource]);
      expect(rootEdited).not.toBe(before);
      fs.writeFileSync(path.join(root, "strict.json"), '{"compilerOptions":{"strict":true}}');
      expect(configFingerprint(workspace, [workspaceSource])).not.toBe(rootEdited);
    });

    it("tracks external configs extended through package specifiers", () => {
      const pkgBase = path.join(root, "node_modules", "@acme", "tsconfig", "tsconfig.json");
      fs.mkdirSync(path.dirname(pkgBase), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(pkgBase), "package.json"), '{"name":"@acme/tsconfig"}');
      fs.writeFileSync(pkgBase, "{}");
      fs.writeFileSync(path.join(workspace, "tsconfig.json"), '{"extends":"@acme/tsconfig"}');
      const before = configFingerprint(workspace, [workspaceSource]);
      expect(before).toBeTypeOf("string");
      fs.writeFileSync(pkgBase, '{"compilerOptions":{"baseUrl":"."}}');
      expect(configFingerprint(workspace, [workspaceSource])).not.toBe(before);
    });

    it("terminates on cycles through external configs", () => {
      fs.writeFileSync(base(), '{"extends":"./packages/p1/tsconfig.json"}');
      expect(configFingerprint(workspace, [workspaceSource])).toBeTypeOf("string");
    });
  });

  it("disables persistence for external sources and logs why", () => {
    expect(configFingerprint(root, [path.join(root, "..", "outside.ts")])).toBeUndefined();
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toMatch(/^Index cache disabled: source file outside the workspace: .*outside\.ts$/);
  });

  it("disables persistence when a config cannot be read as a file, and logs why", () => {
    fs.mkdirSync(path.join(root, "tsconfig.json"));
    expect(configFingerprint(root, [source])).toBeUndefined();
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toMatch(/^Index cache disabled: cannot read resolver config .*tsconfig\.json: /);
  });
});
