import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePath, type Dependency, type ILanguageAnalyzer } from "@/analyzer/types";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { resolveFileImports } from "@/analyzer/utils/resolveFileImports";

const imp = (module: string, line = 1): Dependency => ({ path: "", type: "import", line, module });

/** Regression tests for #264: imports dropped by the root boundary are counted, not lost. */
describe("resolveFileImports", () => {
  const from = "/repo/apps/worker/src/a.ts";
  const insideRoot = (p: string) => normalizePath(p).startsWith("/repo/apps/worker/");

  it("keeps in-root imports, deduplicated, and counts boundary drops reported by resolveImport()", async () => {
    const targets: Record<string, { path: string | null; outsideRoot: boolean }> = {
      "./y": { path: "/repo/apps/worker/src/y.ts", outsideRoot: false },
      "./y.ts": { path: "/repo/apps/worker/src/y.ts", outsideRoot: false },
      "@core/x": { path: null, outsideRoot: true },
      "missing": { path: null, outsideRoot: false },
    };
    const analyzer: ILanguageAnalyzer = {
      parseImports: async () => [],
      resolvePath: async () => {
        throw new Error("resolveImport() must be preferred");
      },
      resolveImport: async (_from, specifier) => targets[specifier],
    };

    const result = await resolveFileImports(
      analyzer,
      from,
      [imp("./y", 1), imp("./y.ts", 2), imp("@core/x", 3), imp("@core/x", 4), imp("missing", 5)],
      insideRoot,
    );

    expect(result.dependencies).toEqual([
      { path: "/repo/apps/worker/src/y.ts", type: "import", line: 1, module: "./y" },
    ]);
    expect(result.outOfRootImports).toEqual(["@core/x"]);
  });

  it("keeps source order and first-seen line when resolutions settle out of order", async () => {
    const delays: Record<string, number> = { "./slow": 20, "./fast": 0, "./slow-alias": 5 };
    const targets: Record<string, string> = {
      "./slow": String.raw`C:\repo\apps\worker\src\slow.ts`,
      "./fast": String.raw`C:\repo\apps\worker\src\fast.ts`,
      "./slow-alias": "c:/repo/apps/worker/src/slow.ts",
    };
    const analyzer: ILanguageAnalyzer = {
      parseImports: async () => [],
      resolvePath: async () => null,
      resolveImport: (_from, specifier) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ path: targets[specifier], outsideRoot: false }), delays[specifier]),
        ),
    };

    const result = await resolveFileImports(
      analyzer,
      from,
      [imp("./slow", 1), imp("./fast", 2), imp("./slow-alias", 3)],
      insideRoot,
    );

    expect(result.dependencies.map((d) => [d.module, d.line, d.path])).toEqual([
      ["./slow", 1, normalizePath(targets["./slow"])],
      ["./fast", 2, normalizePath(targets["./fast"])],
    ]);
  });

  it("applies the boundary itself for analyzers without resolveImport()", async () => {
    const analyzer: ILanguageAnalyzer = {
      parseImports: async () => [],
      resolvePath: async (_from, specifier) =>
        specifier === "../../../core/x" ? "/repo/core/x.py" : null,
    };

    const result = await resolveFileImports(analyzer, from, [imp("../../../core/x"), imp("nowhere")], insideRoot);

    expect(result.dependencies).toEqual([]);
    expect(result.outOfRootImports).toEqual(["../../../core/x"]);
  });

  it("never reports an absolute specifier verbatim (POSIX and Windows)", async () => {
    const analyzer: ILanguageAnalyzer = {
      parseImports: async () => [],
      resolvePath: async () => null,
      resolveImport: async () => ({ path: null, outsideRoot: true }),
    };

    const result = await resolveFileImports(
      analyzer,
      from,
      [imp("/home/dev/repo/core/x.ts"), imp("C:\\Users\\dev\\repo\\core\\z.ts")],
      insideRoot,
    );

    expect(result.outOfRootImports).toEqual(["[external:x.ts]", "[external:z.ts]"]);
    expect(result.outOfRootImports.join(" ")).not.toMatch(/home|Users/);
  });
});

describe("PathResolver.resolveImport", () => {
  let mono: string;
  let worker: string;
  let from: string;

  const write = (relative: string, content = "{}") => {
    const file = path.join(mono, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  beforeEach(() => {
    mono = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-boundary-resolver-")));
    worker = path.join(mono, "apps", "worker");
    write("core/src/x.ts", "export const x = 1;");
    write("apps/worker/package.json");
    write(
      "apps/worker/tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@core/*": ["../../core/src/*"] } } }),
    );
    write("apps/worker/src/y.ts", "export const y = 2;");
    from = write("apps/worker/src/a.ts", "");
  });
  afterEach(() => fs.rmSync(mono, { recursive: true, force: true }));

  it("flags alias and relative targets outside the root, and resolve() still returns null for them", async () => {
    const resolver = new PathResolver(undefined, true, worker);

    expect(await resolver.resolveImport(from, "@core/x")).toEqual({ path: null, outsideRoot: true });
    expect(await resolver.resolveImport(from, "../../../core/src/x")).toEqual({ path: null, outsideRoot: true });
    expect(await resolver.resolve(from, "@core/x")).toBeNull();
  });

  it("does not flag in-root, unresolvable or node_modules imports", async () => {
    const resolver = new PathResolver(undefined, true, worker);

    expect(await resolver.resolveImport(from, "./y")).toEqual({
      path: normalizePath(path.join(worker, "src", "y.ts")),
      outsideRoot: false,
    });
    expect(await resolver.resolveImport(from, "./missing")).toEqual({ path: null, outsideRoot: false });
    expect(await resolver.resolveImport(from, "lodash")).toEqual({ path: null, outsideRoot: false });
  });

  it("resolves the same alias once the monorepo root is the workspace root", async () => {
    const resolver = new PathResolver(undefined, true, mono);

    expect(await resolver.resolveImport(from, "@core/x")).toEqual({
      path: normalizePath(path.join(mono, "core", "src", "x.ts")),
      outsideRoot: false,
    });
  });
});
