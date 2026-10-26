import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchitectureGraph, type AnalyzeFile } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { assignUnits, buildArchitectureUnits, ROOT_UNIT } from "@/analyzer/architecture/architectureUnits";
import { inferUnitRole, MAX_MANIFEST_BYTES, unitRole } from "@/analyzer/architecture/unitRoles";
import { UNIT_ROLES, type UnitRoleInfo } from "@/shared/architecture-model";
import { normalizePath } from "@/shared/path";

let root: string;

function write(relative: string, content = ""): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const pkg = (name: string, dependencies: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, dependencies, ...extra });

/** Files with their imports (workspace-relative); the files are written empty unless they exist. */
function analyzer(files: Record<string, string[]>): AnalyzeFile {
  for (const relative of Object.keys(files)) if (!fs.existsSync(path.join(root, relative))) write(relative);
  return async (filePath) =>
    (files[normalizePath(path.relative(root, filePath))] ?? []).map((relative) =>
      ({ path: path.join(root, relative), type: "import" as const, line: 1, module: relative }));
}

async function rolesOf(files: Record<string, string[]>, declared?: Record<string, (typeof UNIT_ROLES)[number]>) {
  const graph = await buildArchitectureGraph(root, analyzer(files));
  const units = buildArchitectureUnits(graph, root, undefined, declared);
  const roles = Object.fromEntries(units.units.map(({ key, role, confidence, evidence }): [string, UnitRoleInfo] => [key, { role, confidence, evidence }]));
  return { units, roles };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-roles-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("unit roles on a workspace holding one unit per role", () => {
  beforeEach(() => {
    write("package.json", JSON.stringify({ name: "acme", workspaces: ["*"] }));
    write("fn/package.json", pkg("@acme/fn", { "aws-lambda": "1" }));
    write("fn/serverless.yml", "service: fn\n");
    write("fn/index.ts", "export const handler = async () => ({});\n");
    write("mfe/package.json", pkg("@acme/mfe", { react: "18" }, { devDependencies: { "@module-federation/enhanced": "1" } }));
    write("mfe/webpack.config.js", "const { ModuleFederationPlugin } = require('webpack').container;\n");
    write("web/package.json", pkg("@acme/web", { vue: "3" }));
    write("web/index.html", "<div id=app></div>");
    write("api/package.json", pkg("@acme/api", { fastify: "4" }));
    write("api/Dockerfile", "FROM node:22\nEXPOSE 3000\nCMD node main.js\n");
    write("lib/package.json", pkg("@acme/lib", { react: "18" }));
    write("e2e/package.json", pkg("@acme/e2e"));
    write("misc/package.json", pkg("@acme/misc", { lodash: "4" }));
  });

  it("infers each role from its evidence", async () => {
    const { units, roles } = await rolesOf({
      "fn/index.ts": ["lib/index.ts"],
      "mfe/src/app.tsx": ["lib/index.ts"],
      "web/src/main.ts": ["lib/index.ts"],
      "api/src/main.ts": ["lib/index.ts"],
      "lib/index.ts": [],
      "e2e/tests/home.spec.ts": ["web/src/main.ts"],
      "misc/src/a.ts": [],
    });
    expect(roles.fn).toEqual({
      role: "function",
      confidence: "inferred",
      evidence: [
        { role: "function", detail: "`aws-lambda` in dependencies" },
        { role: "function", detail: "`serverless.yml`" },
        { role: "function", detail: "exported `handler` in `index.ts`" },
      ],
    });
    expect(roles.mfe.role).toBe("micro-frontend");
    expect(roles.web.evidence).toEqual([
      { role: "frontend", detail: "`vue` in dependencies" },
      { role: "frontend", detail: "`index.html`" },
      // Imported by e2e: kept as evidence, the frontend wins.
      { role: "library", detail: "imported by `@acme/e2e`" },
    ]);
    expect(roles.web.role).toBe("frontend");
    expect(roles.api.evidence).toEqual([
      { role: "service", detail: "`fastify` in dependencies" },
      { role: "service", detail: "`Dockerfile` with EXPOSE" },
    ]);
    // react without a page or a bundler config is no frontend.
    expect(roles.lib).toMatchObject({ role: "library", evidence: [{ role: "library", detail: "imported by `@acme/api`, `@acme/fn`, `@acme/mfe`, `@acme/web`" }] });
    expect(roles.e2e).toMatchObject({ role: "tooling", evidence: [{ role: "tooling", detail: "only scripts, tests or config (1 file)" }] });
    expect(roles.misc).toEqual({ role: "unknown", confidence: "inferred", evidence: [] });
    expect(units.roleCounts).toEqual({ function: 1, "micro-frontend": 1, frontend: 1, service: 1, library: 1, tooling: 1, unknown: 1 });
  });

  it("applies the priority function > micro-frontend > frontend > service > library > tooling", async () => {
    write("fn/webpack.config.js", "new ModuleFederationPlugin({})");
    write("fn/index.html", "");
    write("fn/package.json", pkg("@acme/fn", { "@azure/functions": "4", react: "18", express: "4" }));
    const { roles } = await rolesOf({ "fn/index.ts": [], "web/src/main.ts": ["fn/index.ts"] });
    expect(roles.fn.role).toBe("function");
    expect(roles.fn.evidence.map((entry) => entry.role)).toEqual([
      "function", "function", "function", "micro-frontend", "frontend", "frontend", "frontend", "service", "library",
    ]);
  });

  it("names a declared role declared, keeping the inferred evidence", async () => {
    const { roles, units } = await rolesOf({ "misc/src/a.ts": [], "lib/index.ts": [] }, { "@acme/mi*": "service", "misc": "library" });
    expect(roles.misc).toEqual({
      role: "service",
      confidence: "declared",
      evidence: [{ role: "service", detail: 'declared by roles["@acme/mi*"] in graphit.architecture.json' }],
    });
    expect(roles.lib.confidence).toBe("inferred");
    // A declared role is part of the revision: the view rebuilds when it changes.
    const { units: plain } = await rolesOf({ "misc/src/a.ts": [], "lib/index.ts": [] });
    expect(units.context.revision).not.toBe(plain.context.revision);
  });
});

describe("unit roles edge cases", () => {
  it("is unknown without evidence, and library only when another unit imports it", async () => {
    write("a/package.json", pkg("a"));
    write("b/package.json", pkg("b"));
    const { roles } = await rolesOf({ "a/x.ts": ["a/y.ts"], "a/y.ts": [], "b/z.ts": [] });
    expect(roles.a.role).toBe("unknown");
    expect(roles.b.role).toBe("unknown");
    const linked = await rolesOf({ "a/x.ts": ["b/z.ts"], "b/z.ts": [] });
    expect(linked.roles.b.role).toBe("library");
  });

  it("reads SAM templates, Azure host.json, single-spa and handler re-exports", () => {
    write("sam/template.yaml", "Transform: AWS::Serverless-2016-10-31\n");
    write("cfn/template.yaml", "Resources: {}\n");
    write("cfn/Dockerfile", "FROM node:22\n# EXPOSE 80 is not an instruction\n");
    write("az/host.json", "{}");
    write("spa/package.json", pkg("spa", { "single-spa": "6" }));
    write("cjs/src/handler.js", "exports.handler = async () => 1;\n");
    write("esm/package.json", pkg("esm", {}, { main: "lib/entry.mjs" }));
    write("esm/lib/entry.mjs", "const run = () => 1;\nexport { run as handler };\n");
    const role = (folder: string) => inferUnitRole(root, { folder, files: [`${folder}/x.ts`], importers: [] });
    expect(role("sam").evidence).toEqual([{ role: "function", detail: "`template.yaml` (AWS SAM)" }]);
    expect(role("cfn").role).toBe("unknown");
    expect(role("az").role).toBe("function");
    expect(role("spa").evidence).toEqual([{ role: "micro-frontend", detail: "`single-spa` in dependencies" }]);
    expect(role("cjs").evidence).toEqual([{ role: "function", detail: "exported `handler` in `src/handler.js`" }]);
    expect(role("esm").evidence).toEqual([{ role: "function", detail: "exported `handler` in `lib/entry.mjs`" }]);
  });

  it("reads the root package.json for the (root) unit", async () => {
    write("package.json", pkg("app", { express: "4" }));
    write("pkg/package.json", pkg("pkg"));
    const { roles } = await rolesOf({ "main.ts": [], "pkg/x.ts": [] });
    expect(roles[ROOT_UNIT].role).toBe("service");
  });

  it("ignores malformed and oversized manifests without failing", () => {
    write("bad/package.json", "{ not json");
    write("array/package.json", "[1]");
    write("deps/package.json", JSON.stringify({ dependencies: null, devDependencies: ["express"] }));
    write("big/package.json", pkg("big", { express: "4" }, { pad: "x".repeat(MAX_MANIFEST_BYTES) }));
    write("big/Dockerfile", `EXPOSE 80\n#${"x".repeat(MAX_MANIFEST_BYTES)}`);
    for (const folder of ["bad", "array", "deps", "big", "missing"]) {
      expect(inferUnitRole(root, { folder, files: [`${folder}/x.ts`], importers: [] }).role, folder).toBe("unknown");
    }
  });

  it("never reads outside the workspace: an escaping main or a symbolic link", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-roles-out-")));
    try {
      fs.writeFileSync(path.join(outside, "entry.js"), "export const handler = 1;\n");
      fs.writeFileSync(path.join(outside, "package.json"), pkg("out", { express: "4" }));
      write("up/package.json", pkg("up", {}, { main: path.relative(path.join(root, "up"), path.join(outside, "entry.js")) }));
      fs.symlinkSync(outside, path.join(root, "linked"), "junction");
      expect(inferUnitRole(root, { folder: "up", files: ["up/x.ts"], importers: [] }).role).toBe("unknown");
      expect(inferUnitRole(root, { folder: "linked", files: ["linked/x.ts"], importers: [] }).role).toBe("unknown");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("finds the unit folder of files given with Windows separators", () => {
    write("apps/web/package.json", pkg("@acme/web", { react: "18" }));
    write("apps/web/vite.config.ts", "export default {};\n");
    const { unitOf, names } = assignUnits(root, [String.raw`apps\web\src\main.tsx`]);
    const key = unitOf.get("apps/web/src/main.tsx")!;
    expect(unitRole(root, { key, name: names.get(key)!, folder: key, files: ["apps/web/src/main.tsx"], importers: [] }).evidence).toEqual([
      { role: "frontend", detail: "`react` in dependencies" },
      { role: "frontend", detail: "`vite.config.ts`" },
    ]);
  });

  it("counts a unit of scripts, tests and configs only as tooling, and a unit with runtime code as unknown", () => {
    const tooling = inferUnitRole(root, { folder: "tools", files: ["tools/gen.ts", "src/a.test.ts", "vite.config.ts"], importers: [] });
    expect(tooling.role).toBe("tooling");
    expect(inferUnitRole(root, { folder: "app", files: ["app/scripts/a.ts", "app/src/main.ts"], importers: [] }).role).toBe("unknown");
    expect(inferUnitRole(root, { folder: "empty", files: [], importers: [] }).role).toBe("unknown");
  });

  it("keeps an imported unit of tooling files only as tooling, its importers still in the evidence (#468)", () => {
    const tests = inferUnitRole(root, { folder: "tests", files: ["tests/fixtures/a.ts", "tests/unit/deep/b.test.ts"], importers: ["scripts"] });
    expect(tests).toEqual({
      role: "tooling",
      confidence: "inferred",
      evidence: [
        { role: "library", detail: "imported by `scripts`" },
        { role: "tooling", detail: "only scripts, tests or config (2 files)" },
      ],
    });
    const ci = inferUnitRole(root, { folder: ".github", files: [".github/actions/gate/index.ts"], importers: ["scripts", "tests"] });
    expect(ci.role).toBe("tooling");
  });

  it("keeps an imported unit with runtime code a library", () => {
    const files = ["lib/src/main.ts", "lib/tests/main.test.ts"];
    expect(inferUnitRole(root, { folder: "lib", files, importers: ["app"] }).role).toBe("library");
  });

  it("ranks manifest evidence over tooling, and a declared role over both", () => {
    write("tests/package.json", pkg("tests", { express: "4" }));
    expect(inferUnitRole(root, { folder: "tests", files: ["tests/a.test.ts"], importers: ["scripts"] }).role).toBe("service");
    const declared = unitRole(root, { key: "tests", name: "tests", folder: "tests", files: ["tests/a.test.ts"], importers: ["scripts"] }, { tests: "library" });
    expect(declared).toMatchObject({ role: "library", confidence: "declared" });
  });
});
