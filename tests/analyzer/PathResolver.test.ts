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

  // #419: the configuration is cached until clearCaches(), for both the explicit and the nearest tsconfig.
  it.each([false, true])("reads an alias added or removed after clearCaches (explicit tsconfig: %s)", async (explicit) => {
    const config = write("tsconfig.json");
    const resolver = new PathResolver(explicit ? config : undefined, true, root);
    expect(await resolve("~/lib/x", resolver)).toBeNull();

    write("tsconfig.json", '{ "compilerOptions": { "paths": { "~/*": ["src/*"] } } }');
    expect(await resolve("~/lib/x", resolver)).toBeNull();
    resolver.clearCaches();
    expect(await resolve("~/lib/x", resolver)).toBe(target);

    write("tsconfig.json");
    resolver.clearCaches();
    expect(await resolve("~/lib/x", resolver)).toBeNull();
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

/** #388: workspace packages imported by name land on their sources through the node_modules link. */
describe("PathResolver - linked workspace packages", () => {
  let root: string;
  let main: string;
  const write = (relative: string, content = "") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const link = (target: string, name: string, base = root) => {
    const linkPath = path.join(base, "node_modules", name);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, "junction");
  };
  const resolve = (specifier: string, resolver = new PathResolver(undefined, true, root)) => resolver.resolve(main, specifier);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-linked-")));
    write("package.json", JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "libs/*"] }));
    main = write("apps/web/src/main.ts");
    write("libs/core-lib/package.json", JSON.stringify({ name: "@acme/core", main: "dist/index.js" }));
    write("libs/core-lib/src/index.ts", "export const core = 1;");
    write("libs/core-lib/src/format/date.ts", "export const date = 1;");
    write("libs/plain/package.json", JSON.stringify({ name: "plain-utils" }));
    write("libs/plain/index.ts", "export const plain = 1;");
    link(path.join(root, "libs/core-lib"), "@acme/core");
    link(path.join(root, "libs/plain"), "plain-utils");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("resolves a scoped package whose folder has another name to its source entry", async () => {
    expect(await resolve("@acme/core")).toBe(normalizePath(path.join(root, "libs/core-lib/src/index.ts")));
  });

  it("resolves an unscoped package and a subpath", async () => {
    expect(await resolve("plain-utils")).toBe(normalizePath(path.join(root, "libs/plain/index.ts")));
    expect(await resolve("@acme/core/format/date")).toBe(normalizePath(path.join(root, "libs/core-lib/src/format/date.ts")));
  });

  it("finds the link in a package's own node_modules", async () => {
    write("libs/nested/package.json", JSON.stringify({ name: "nested" }));
    write("libs/nested/src/index.ts");
    link(path.join(root, "libs/nested"), "nested", path.join(root, "apps/web"));
    expect(await resolve("nested")).toBe(normalizePath(path.join(root, "libs/nested/src/index.ts")));
  });

  it("keeps installed packages, links leaving the root and node builtins external", async () => {
    write("node_modules/lodash/package.json", JSON.stringify({ name: "lodash" }));
    write("node_modules/lodash/index.js");
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-outside-")));
    try {
      fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "outside" }));
      fs.writeFileSync(path.join(outside, "index.ts"), "");
      link(outside, "outside");
      expect(await resolve("lodash")).toBeNull();
      expect(await resolve("outside")).toBeNull();
      expect(await resolve("node:fs")).toBeNull();
      expect(await resolve("lodash", new PathResolver(undefined, false, root))).toBe("lodash");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores a link whose package.json names another package, a subpath leaving its package, and a file link", async () => {
    link(path.join(root, "libs/plain"), "renamed");
    expect(await resolve("renamed")).toBeNull();
    expect(await resolve("@acme/core/../../plain/index")).toBeNull();
    // File symlinks need admin rights on Windows; junctions (directories) do not.
    if (process.platform !== "win32") {
      write("libs/file.ts");
      fs.symlinkSync(path.join(root, "libs/file.ts"), path.join(root, "node_modules/filelink"), "file");
      expect(await resolve("filelink")).toBeNull();
    }
  });

  it("keeps the workspace root as given when its real path differs (macOS /var, Windows 8.3 names)", async () => {
    // os.tmpdir() is not canonical on macOS (/var -> /private/var) nor on Windows CI (RUNNER~1).
    const given = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-alias-"));
    try {
      fs.mkdirSync(path.join(given, "libs/x"), { recursive: true });
      fs.writeFileSync(path.join(given, "libs/x/package.json"), JSON.stringify({ name: "x" }));
      fs.writeFileSync(path.join(given, "libs/x/index.ts"), "");
      fs.mkdirSync(path.join(given, "app"), { recursive: true });
      fs.mkdirSync(path.join(given, "node_modules"));
      fs.symlinkSync(path.join(given, "libs/x"), path.join(given, "node_modules/x"), "junction");
      const resolved = await new PathResolver(undefined, true, given).resolve(path.join(given, "app/main.ts"), "x");
      expect(resolved).toBe(normalizePath(path.join(given, "libs/x/index.ts")));
    } finally {
      fs.rmSync(given, { recursive: true, force: true });
    }
  });

  it("caches the link lookup for the resolver's lifetime", async () => {
    const resolver = new PathResolver(undefined, true, root);
    const entry = normalizePath(path.join(root, "libs/plain/index.ts"));
    expect(await resolve("plain-utils", resolver)).toBe(entry);
    // Gone from disk, still known: the second lookup reads no link.
    const linkPath = path.join(root, "node_modules/plain-utils");
    // A junction is removed as a directory on Windows.
    if (process.platform === "win32") fs.rmdirSync(linkPath);
    else fs.unlinkSync(linkPath);
    expect(await resolve("plain-utils", resolver)).toBe(entry);
    expect(await resolve("plain-utils")).toBeNull();
  });
});

/** #430: a config edit re-indexes only when what resolution reads from it changes. */
describe("PathResolver - readResolverInputs", () => {
  const roots: string[] = [];
  const workspace = (files: Record<string, string>) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-inputs-")));
    roots.push(root);
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    }
    return { root, inputs: (relative: string) => new PathResolver(undefined, true, root).readResolverInputs(path.join(root, relative)) };
  };

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("ignores tsconfig options that do not move an alias, inherited ones included", async () => {
    const base = '{ "compilerOptions": { "baseUrl": "src", "paths": { "@app/*": ["app/*"] } } }';
    const a = workspace({ "tsconfig.base.json": base, "tsconfig.json": '{ "extends": "./tsconfig.base.json" }' });
    const b = workspace({
      "tsconfig.base.json": base.replace('"compilerOptions": {', '"compilerOptions": { "strict": true, '),
      "tsconfig.json": '{ "extends": "./tsconfig.base.json", "include": ["src"] }',
    });
    expect(await a.inputs("tsconfig.json")).toBe('[["@app","src/app"]]');
    expect(await b.inputs("tsconfig.json")).toBe(await a.inputs("tsconfig.json"));
  });

  it("changes when paths, baseUrl or an inherited alias change", async () => {
    const { inputs } = workspace({
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": "src", "paths": { "@app/*": ["app/*"] } } }',
      "tsconfig.lib.json": '{ "compilerOptions": { "baseUrl": "lib", "paths": { "@app/*": ["app/*"] } } }',
      "tsconfig.child.json": '{ "extends": "./tsconfig.lib.json" }',
    });
    const paths = await inputs("tsconfig.json");
    expect(await inputs("tsconfig.lib.json")).not.toBe(paths);
    expect(await inputs("tsconfig.child.json")).toBe(await inputs("tsconfig.lib.json"));
  });

  it("keeps the package.json fields resolution reads and ignores the others", async () => {
    const manifest = { name: "fx", main: "dist/index.js", imports: { "#app/*": { import: "./src/*" } }, dependencies: { lib: "file:../lib", react: "^19" } };
    const a = workspace({ "package.json": JSON.stringify(manifest) });
    const b = workspace({ "package.json": JSON.stringify({ ...manifest, version: "2.0.0", scripts: { test: "vitest" }, dependencies: { lib: "file:../lib", react: "^20" } }) });
    const c = workspace({ "package.json": JSON.stringify({ ...manifest, imports: { "#app/*": "./lib/*" } }) });
    const d = workspace({ "package.json": JSON.stringify({ ...manifest, dependencies: { lib: "file:../other" } }) });
    const inputs = await a.inputs("package.json");
    expect(JSON.parse(inputs!)).toEqual({ imports: [["#app/*", "./src/*"]], entry: ["fx", null, "dist/index.js", null], fileDependencies: [["lib", "file:../lib"]] });
    expect(await b.inputs("package.json")).toBe(inputs);
    expect(await c.inputs("package.json")).not.toBe(inputs);
    expect(await d.inputs("package.json")).not.toBe(inputs);
  });

  it("returns null for a missing config and empty inputs for invalid JSON", async () => {
    const { inputs } = workspace({ "package.json": "{ not json", "tsconfig.json": "{ not json" });
    expect(await inputs("missing/tsconfig.json")).toBeNull();
    expect(JSON.parse((await inputs("package.json"))!)).toEqual({ imports: [], entry: [null, null, null, null], fileDependencies: [] });
    expect(await inputs("tsconfig.json")).toBe("[]");
  });
});
