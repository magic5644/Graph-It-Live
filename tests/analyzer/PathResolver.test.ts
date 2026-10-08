import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "@/analyzer/Parser";
import { normalizePath } from "@/analyzer/types";
import { PathResolver } from "@/analyzer/utils/PathResolver";

/** Regression tests for #262: tsconfig aliases, JSONC configs and `extends` variants. */
describe("PathResolver - tsconfig path aliases", () => {
  let root: string;
  let main: string;
  let target: string;
  const write = (relative: string, content = "{}") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const resolve = (specifier: string, resolver = new PathResolver(undefined, true, root)) =>
    resolver.resolve(main, specifier);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-resolver-")));
    write("package.json", '{ "name": "fx", "version": "0.0.0" }');
    main = write("src/main.ts", "");
    target = normalizePath(write("src/lib/x.ts", "export const x = 1;"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each(["@/*", "~/*", "src/*", "#app/*"])("resolves the %s alias", async (alias) => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { [alias]: ["src/*"] } } }));
    expect(await resolve(`${alias.slice(0, -2)}/lib/x`)).toBe(target);
  });

  it("still treats unmapped bare packages as node_modules", async () => {
    write("tsconfig.json", '{ "compilerOptions": { "paths": { "~/*": ["src/*"] } } }');
    expect(await resolve("lodash")).toBeNull();
    expect(await resolve("lodash", new PathResolver(undefined, false, root))).toBe("lodash");
  });

  it("keeps alias targets inside the workspace", async () => {
    const outside = `${root}-outside`;
    write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "~/*": [`../${path.basename(outside)}/*`] } } }));
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.ts"), "export {};");
    try {
      expect(await resolve("~/secret")).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores malformed configs and malformed paths entries without throwing", async () => {
    write("tsconfig.json", '{ "compilerOptions": { "paths": { "~/*": "src/*", "@/*": [42] } } }');
    expect(await resolve("~/lib/x")).toBeNull();
    write("src/tsconfig.json", "{ invalid");
    expect(await resolve("~/lib/x")).toBeNull();
  });

  it.each<[string, Record<string, string>]>([
    [
      "JSONC configs with comments, trailing commas and a BOM",
      {
        "tsconfig.json": '\uFEFF{\n  // tsc --init\n  "extends": "./base",\n}',
        "base.json": '\uFEFF{ /* base */ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, }, }',
      },
    ],
    [
      "an array extends where later entries override earlier ones",
      {
        "tsconfig.json": '{ "extends": ["./first.json", "./second.json"] }',
        "first.json": '{ "compilerOptions": { "paths": { "@/*": ["wrong/*"] } } }',
        "second.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
      },
    ],
    [
      "a package extends resolved from node_modules",
      {
        "tsconfig.json": '{ "extends": "@acme/tsconfig/base.json" }',
        "node_modules/@acme/tsconfig/package.json": '{ "name": "@acme/tsconfig", "version": "1.0.0" }',
        "node_modules/@acme/tsconfig/base.json": '{ "compilerOptions": { "baseUrl": "../../../", "paths": { "@/*": ["src/*"] } } }',
      },
    ],
    [
      "missing extends targets and cycles",
      {
        "tsconfig.json": '{ "extends": ["./missing", "@missing/pkg", "./loop.json"], "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
        "loop.json": '{ "extends": "./tsconfig.json" }',
      },
    ],
  ])("resolves @/* through %s", async (_name, files) => {
    for (const [relative, content] of Object.entries(files)) write(relative, content);
    expect(await resolve("@/lib/x")).toBe(target);
  });

  it("loads an explicit tsconfig path with its extends chain", async () => {
    const config = write("config/tsconfig.app.json", '{ "extends": "./base.json" }');
    write("config/base.json", '{ "compilerOptions": { "baseUrl": "..", "paths": { "~/*": ["src/*"] } } }');
    expect(await resolve("~/lib/x", new PathResolver(config, true, root))).toBe(target);
  });
});

describe("Parser - resolver configuration", () => {
  let parent: string;
  let root: string;
  beforeEach(() => {
    parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-parser-")));
    root = path.join(parent, "workspace");
    fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }');
    fs.writeFileSync(path.join(root, "src", "lib", "x.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(parent, "sibling.ts"), "export {};");
  });
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  it("resolves non-@ aliases from the workspace tsconfig", async () => {
    const parser = new Parser(root);
    expect(await parser.resolvePath(path.join(root, "src", "main.ts"), "~/lib/x")).toBe(
      normalizePath(path.join(root, "src", "lib", "x.ts")),
    );
  });

  it("confines resolution to rootDir, not its parent", async () => {
    const parser = new Parser(root);
    expect(await parser.resolvePath(path.join(root, "main.ts"), "../sibling")).toBeNull();
  });
});

describe("PathResolver - non-TypeScript sources with a workspace tsconfig", () => {
  let root: string;
  const write = (relative: string, content = "") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return normalizePath(file);
  };
  const resolver = () => new PathResolver(undefined, true, root);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-resolver-lang-")));
    write("tsconfig.json", '{ "compilerOptions": { "paths": { "~/*": ["src/*"] } } }');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("resolves Python relative and absolute module imports", async () => {
    const main = write("pkg/app/main.py");
    const helpers = write("pkg/app/helpers.py");
    const shared = write("pkg/shared/__init__.py");
    const database = write("pkg/utils/database.py");
    expect(await resolver().resolve(main, ".helpers")).toBe(helpers);
    expect(await resolver().resolve(main, "..shared")).toBe(shared);
    expect(await resolver().resolve(main, ".missing")).toBeNull();
    expect(await resolver().resolve(main, "pkg.utils.database")).toBe(database);
    expect(await resolver().resolve(main, "pkg.shared")).toBe(shared);
    expect(await resolver().resolve(main, "pkg.unknown")).toBeNull();
  });

  it("resolves Rust module files and mod.rs directories", async () => {
    const main = write("crate/src/main.rs");
    const helper = write("crate/src/helper.rs");
    const parser = write("crate/src/utils/parser/mod.rs");
    expect(await resolver().resolve(main, "helper")).toBe(helper);
    expect(await resolver().resolve(main, "utils::parser")).toBe(parser);
    expect(await resolver().resolve(main, "serde")).toBeNull();
    expect(await resolver().resolve(main, "not-rust-like")).toBeNull();
  });
});
