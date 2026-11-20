import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchitectureGraph, type AnalyzeFile } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { assignUnits, buildArchitectureUnits, ROOT_UNIT } from "@/analyzer/architecture/architectureUnits";
import { fileKind, inferUnitRole, MAX_MANIFEST_BYTES, unitRole } from "@/analyzer/architecture/unitRoles";
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
      // Imported by e2e tests only: test files are no product importer (#776).
    ]);
    expect(roles.web.role).toBe("frontend");
    expect(roles.api.evidence).toEqual([
      { role: "service", detail: "`fastify` in dependencies" },
      { role: "service", detail: "`Dockerfile` with EXPOSE" },
    ]);
    // react without a page or a bundler config is no frontend.
    expect(roles.lib).toMatchObject({ role: "library", evidence: [{ role: "library", detail: "imported by `@acme/api`, `@acme/fn`, `@acme/mfe`, `@acme/web`" }] });
    expect(roles.e2e).toMatchObject({ role: "test", evidence: [
      { role: "test", detail: "only tests, fixtures or tooling (1 test, 0 fixture, 0 tooling file)" },
      { role: "test", detail: 'name "e2e" matches a test module name' },
    ] });
    expect(roles.misc).toEqual({ role: "unknown", confidence: "inferred", evidence: [{ role: "unknown", detail: "no evidence: no manifest field, framework, entry point or product importer found" }] });
    expect(units.roleCounts).toEqual({ function: 1, "micro-frontend": 1, frontend: 1, service: 1, library: 1, test: 1, unknown: 1 });
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
      evidence: [
        { role: "service", detail: 'declared by roles["@acme/mi*"] in graphit.architecture.json' },
        { role: "unknown", detail: "no evidence: no manifest field, framework, entry point or product importer found" },
      ],
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
    expect(role("esm").evidence).toEqual([
      { role: "function", detail: "exported `handler` in `lib/entry.mjs`" },
      { role: "library", detail: "`main` in `package.json`" },
    ]);
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
      // The `main` field names a library entry; the escaping file itself is never read for a handler.
      expect(inferUnitRole(root, { folder: "up", files: ["up/x.ts"], importers: [] }).evidence).toEqual([{ role: "library", detail: "`main` in `package.json`" }]);
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

  it("counts a unit of scripts, tests and tool configs only as tooling, and a unit with runtime code as unknown", () => {
    const tooling = inferUnitRole(root, { folder: "", files: ["tools/gen.ts", "scripts/b.ts", "src/a.test.ts", "eslint.config.mjs"], importers: [] });
    expect(tooling).toMatchObject({ role: "tooling", evidence: [{ role: "tooling", detail: "only tests, fixtures or tooling (1 test, 0 fixture, 3 tooling files)" }] });
    // vite.config.ts builds the product: kind other, so the unit is no tooling (#776).
    expect(inferUnitRole(root, { folder: "", files: ["tools/gen.ts", "vite.config.ts"], importers: [] }).role).toBe("unknown");
    expect(inferUnitRole(root, { folder: "app", files: ["app/scripts/a.ts", "app/src/main.ts"], importers: [] }).role).toBe("unknown");
    expect(inferUnitRole(root, { folder: "empty", files: [], importers: [] }).role).toBe("unknown");
  });

  it("drops the importers of a unit of test and fixture files: tests import each other (#468)", () => {
    const tests = inferUnitRole(root, { folder: "tests", files: ["tests/fixtures/a.ts", "tests/unit/deep/b.test.ts"], importers: ["scripts"] });
    expect(tests).toEqual({
      role: "test",
      confidence: "inferred",
      evidence: [
        { role: "test", detail: "only tests, fixtures or tooling (1 test, 1 fixture, 0 tooling files)" },
        { role: "test", detail: 'name "tests" matches a test module name' },
      ],
    });
    const ci = inferUnitRole(root, { folder: ".github", files: [".github/actions/gate/index.ts"], importers: ["scripts", "tests"] });
    expect(ci.role).toBe("tooling");
    // samples/ at the project root (the workspace root here) is fixture data, tests inside it too.
    const fixtures = inferUnitRole(root, { folder: "", files: ["samples/a.ts", "samples/fixtures/b.ts", "samples/c.test.ts"], importers: ["app"] });
    expect(fixtures).toMatchObject({ role: "fixture", evidence: [{ role: "fixture", detail: "only tests, fixtures or tooling (0 test, 3 fixture, 0 tooling files)" }] });
    // Passed kinds win over the folder: a tie between test and fixture goes to test.
    const tie = inferUnitRole(root, { folder: "data", files: ["data/a.ts", "data/b.ts"], kinds: ["test", "fixture"], importers: [] });
    expect(tie.role).toBe("test");
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

describe("file kinds (#776)", () => {
  it("reads fixture before test before tooling, with project-root-only segments below the project root", () => {
    expect(fileKind("tests/fixtures/x/a.ts", "")).toBe("fixture");
    expect(fileKind("pkg/__fixtures__/a.ts", "pkg")).toBe("fixture");
    expect(fileKind("examples/a/B.java", "")).toBe("fixture");
    expect(fileKind("examples/scripts/a.test.ts", "")).toBe("fixture");
    expect(fileKind("src/test/java/a/B.java", "")).toBe("test");
    expect(fileKind("scripts/x.ts", "")).toBe("tooling");
    expect(fileKind("pkg/scripts/x.ts", "pkg")).toBe("tooling");
    expect(fileKind(".github/a/b.js", "")).toBe("tooling");
    expect(fileKind("pkg/.github/b.js", "pkg")).toBe("tooling");
  });

  it("keeps product code named like tooling or examples when the segment is not first below the project root", () => {
    expect(fileKind("src/mcp/tools/architecture.ts", "")).toBe("other");
    expect(fileKind("server/mcp/tools/list.ts", "")).toBe("other");
    expect(fileKind("layers/nuxi/agent/tools/run.ts", "layers/nuxi")).toBe("other");
    expect(fileKind("server/api/examples/code-explorer/[...path].get.ts", "")).toBe("other");
    // The same folder first below its project root is tooling: the project root decides.
    expect(fileKind("layers/nuxi/tools/run.ts", "layers/nuxi")).toBe("tooling");
    expect(fileKind("layers/nuxi/tools/run.ts", "")).toBe("other");
  });

  it("lists tool configs only: runtime and build configs ship with the product", () => {
    for (const file of ["app/app.config.ts", "nuxt.config.ts", "vite.config.ts", "webpack.config.js", "tailwind.config.ts", "eslint.config.json", "config.ts"]) {
      expect(fileKind(file, ""), file).toBe("other");
    }
    for (const file of ["eslint.config.mjs", "vitest.config.ts", "playwright.config.ts", "evalite.config.ts", "vitest.e2e.config.mts", "pkg/jest.config.cjs"]) {
      expect(fileKind(file, ""), file).toBe("tooling");
    }
  });

  it("recognises test files of every language, and Windows separators", () => {
    for (const file of ["a.test.ts", "b.spec.tsx", "c.test.mjs", "x_test.go", "test_x.py", "x_test.py", "FooTest.java", "FooTests.java", "FooIT.java", "FooTest.kt", "FooTests.cs"]) {
      expect(fileKind(`src/${file}`, ""), file).toBe("test");
    }
    for (const file of ["latest.ts", "contest.py", "Testing.java", "test.go"]) expect(fileKind(`src/${file}`, ""), file).toBe("other");
    expect(fileKind(String.raw`pkg\scripts\x.ts`, "pkg")).toBe("tooling");
    expect(fileKind(String.raw`src\test\a.ts`, "")).toBe("test");
  });
});

describe("unit roles from manifests (#776)", () => {
  const files = (folder: string, count = 1) => Array.from({ length: count }, (_, index) => `${folder}/src/main/java/A${index}.java`);
  const pom = (plugins: string, extra = "") =>
    `<project><!-- <packaging>pom</packaging> --><parent><artifactId>parent</artifactId><packaging>pom</packaging></parent><artifactId>m</artifactId>${extra}<build><plugins>${plugins}</plugins></build></project>`;
  const plugin = (artifactId: string, body = "") => `<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>${artifactId}</artifactId>${body}</plugin>`;
  const mainClass = "<configuration><archive><manifest><mainClass>a.Main</mainClass></manifest></archive></configuration>";
  /** gson shrinker-test/pom.xml: a shade plugin without <mainClass> before an exec plugin with one. */
  const shrinkerPom = pom(plugin("maven-shade-plugin", "<executions><execution><goals><goal>shade</goal></goals></execution></executions>")
    + plugin("exec-maven-plugin", "<configuration><mainClass>com.example.Main</mainClass></configuration>"));

  it("reads <mainClass> inside the jar, shade or assembly plugin only, and spring-boot, as an application", () => {
    write("jar/pom.xml", pom(plugin("maven-jar-plugin", mainClass)));
    write("shade/pom.xml", pom(plugin("maven-shade-plugin", mainClass)));
    write("assembly/pom.xml", pom(plugin("maven-assembly-plugin", mainClass)));
    write("exec/pom.xml", pom(plugin("exec-maven-plugin", mainClass)));
    write("boot/pom.xml", pom(plugin("spring-boot-maven-plugin")));
    const role = (folder: string) => inferUnitRole(root, { folder, files: files(folder), importers: [] });
    expect(role("jar").evidence).toEqual([
      { role: "application", detail: "`<mainClass>` in `maven-jar-plugin` of `pom.xml`" },
      { role: "library", detail: "`pom.xml` packaging `jar` (default)" },
    ]);
    expect(role("shade").role).toBe("application");
    expect(role("assembly").role).toBe("application");
    expect(role("boot").evidence[0]).toEqual({ role: "application", detail: "`spring-boot-maven-plugin` in `pom.xml`" });
    // exec-maven-plugin runs a tool at build time: the module stays a library (jar by default).
    expect(role("exec").evidence).toEqual([{ role: "library", detail: "`pom.xml` packaging `jar` (default)" }]);
  });

  it("bounds the <mainClass> reader to one <plugin> element (gson shrinker-test pom shape)", () => {
    write("shrinker/pom.xml", shrinkerPom);
    expect(inferUnitRole(root, { folder: "shrinker", files: files("shrinker"), importers: [] }).evidence)
      .toEqual([{ role: "library", detail: "`pom.xml` packaging `jar` (default)" }]);
  });

  it("makes gson shrinker-test a test module: the name drops the jar default, nothing reads exec's <mainClass>", () => {
    write("shrinker-test/pom.xml", shrinkerPom);
    const unit = { folder: "shrinker-test", name: "shrinker-test", files: [...files("shrinker-test", 17), "shrinker-test/src/test/java/a/ShrinkingIT.java"], importers: ["gson"] };
    const info = inferUnitRole(root, unit);
    expect(info).toEqual({ role: "test", confidence: "inferred", evidence: [{ role: "test", detail: 'name "shrinker-test" matches a test module name' }] });
    expect(info.evidence.map((entry) => entry.role)).not.toContain("application");
    expect(info.evidence.map((entry) => entry.role)).not.toContain("library");
  });

  it("matches the test-module name on the name or the folder basename, never inside a word", () => {
    const role = (name: string) => inferUnitRole(root, { folder: `x/${name}`, name: "pkg", files: [`x/${name}/a.ts`], importers: [] }).role;
    for (const name of ["shrinker-test", "test", "tests", "foo_it", "app.e2e", "integration-tests", "integration-test", "testing", "Bar-Tests"]) expect(role(name), name).toBe("test");
    for (const name of ["testimony", "latest", "contest", "testing-library", "e2e-utils"]) expect(role(name), name).toBe("unknown");
    expect(inferUnitRole(root, { folder: "lib", name: "graal-native-image-test", files: ["lib/a.ts"], importers: [] }).role).toBe("test");
  });

  it("reads packaging: war is a service, pom is no library, an explicit jar is a library", () => {
    write("war/pom.xml", pom("", "<packaging>war</packaging>"));
    write("parent/pom.xml", pom("", "<packaging>pom</packaging>"));
    write("lib/pom.xml", pom("", "<packaging>jar</packaging>"));
    const role = (folder: string) => inferUnitRole(root, { folder, files: files(folder), importers: [] });
    expect(role("war").evidence).toEqual([{ role: "service", detail: "`pom.xml` packaging `war`" }]);
    expect(role("parent").role).toBe("unknown");
    expect(role("lib").evidence).toEqual([{ role: "library", detail: "`pom.xml` packaging `jar`" }]);
  });

  it("reads application and library fields of package.json, pyproject.toml, Cargo.toml and main.go", () => {
    write("cli/package.json", pkg("cli", {}, { bin: { tool: "bin/tool.js" }, exports: "./index.js" }));
    write("ext/package.json", pkg("ext", {}, { engines: { vscode: "^1.90.0" }, main: "./dist/extension.js" }));
    write("lib/package.json", pkg("lib", {}, { module: "./esm/index.js" }));
    write("py/pyproject.toml", '[project]\nname = "py"\n\n[project.scripts]\npy = "py.cli:main"\n');
    write("rs/Cargo.toml", '[package]\nname = "rs"\n\n[[bin]]\nname = "rs"\n');
    write("rs/src/lib.rs", "pub fn a() {}\n");
    write("rsmain/Cargo.toml", '[package]\nname = "rsmain"\n');
    write("rsmain/src/main.rs", "fn main() {}\n");
    write("go/go.mod", "module example.com/go\n");
    write("go/main.go", "// Command go.\npackage main\n\nfunc main() {}\n");
    write("golib/go.mod", "module example.com/golib\n");
    write("golib/main.go", "package golib\n");
    const evidence = (folder: string) => inferUnitRole(root, { folder, files: [`${folder}/a.ts`], importers: [] }).evidence;
    expect(evidence("cli")).toEqual([{ role: "application", detail: "`bin` in `package.json`" }, { role: "library", detail: "`exports` in `package.json`" }]);
    // An editor extension's main is its entry, not a library entry.
    expect(evidence("ext")).toEqual([{ role: "application", detail: "`engines.vscode` and `main` in `package.json` (editor extension)" }]);
    expect(evidence("lib")).toEqual([{ role: "library", detail: "`module` in `package.json`" }]);
    expect(evidence("py")).toEqual([{ role: "application", detail: "`[project.scripts]` in `pyproject.toml`" }]);
    expect(evidence("rs")).toEqual([{ role: "application", detail: "`[[bin]]` in `Cargo.toml`" }, { role: "library", detail: "`src/lib.rs`" }]);
    expect(evidence("rsmain")).toEqual([{ role: "application", detail: "`src/main.rs`" }]);
    expect(evidence("go")).toEqual([{ role: "application", detail: "`main.go` declaring `package main`" }]);
    expect(inferUnitRole(root, { folder: "golib", files: ["golib/a.go"], importers: [] }).role).toBe("unknown");
  });

  it("lets a folder without a manifest inherit the root manifest, unless test-like evidence drops it", () => {
    write("package.json", pkg("app", {}, { bin: "cli.js" }));
    const inherited = inferUnitRole(root, { folder: "src", files: ["src/a.ts"], importers: [] });
    expect(inherited).toEqual({ role: "application", confidence: "inferred", evidence: [{ role: "application", detail: "`bin` in `package.json` (workspace root manifest)" }] });
    expect(inferUnitRole(root, { folder: "scripts", files: ["scripts/a.ts"], kinds: ["tooling"], importers: [] }).evidence)
      .toEqual([{ role: "tooling", detail: "only tests, fixtures or tooling (0 test, 0 fixture, 1 tooling file)" }]);
    expect(inferUnitRole(root, { folder: "e2e-suite", name: "e2e-suite", files: ["e2e-suite/a.ts"], importers: [] }).role).toBe("application");
    expect(inferUnitRole(root, { folder: "it", files: ["it/a.ts"], importers: [] }).evidence).toEqual([{ role: "test", detail: 'name "it" matches a test module name' }]);
    // A folder with its own manifest reads only its own; a unit across folders reads none.
    write("pkg/package.json", pkg("pkg"));
    expect(inferUnitRole(root, { folder: "pkg", files: ["pkg/a.ts"], importers: [] }).role).toBe("unknown");
    expect(inferUnitRole(root, { folder: "", files: ["src/a.ts", "lib/b.ts"], importers: [], manifest: false }).role).toBe("unknown");
    // (root): the root manifest is its own, so the evidence carries no inherited suffix.
    expect(inferUnitRole(root, { folder: "", files: ["a.ts"], importers: [] }).evidence).toEqual([{ role: "application", detail: "`bin` in `package.json`" }]);
  });

  it("gives the nuxt.com (root) its own frontend evidence, never tooling, and the split folders the inherited one", async () => {
    write("package.json", pkg("nuxt.com", {}, { devDependencies: { vue: "3", nuxt: "4" } }));
    write("nuxt.config.ts", "export default defineNuxtConfig({});\n");
    const { roles } = await rolesOf({
      "eslint.config.mjs": [], "evalite.config.ts": [], "playwright.config.ts": [], "vitest.config.ts": [], "nuxt.config.ts": [],
      "server/api/search.ts": ["shared/utils.ts"],
      "server/mcp/tools/list.ts": [],
      "shared/utils.ts": [],
      "scripts/build.ts": ["shared/utils.ts"],
      "test/a.test.ts": ["server/api/search.ts"],
    });
    expect(roles[ROOT_UNIT]).toEqual({ role: "frontend", confidence: "inferred", evidence: [
      { role: "frontend", detail: "`vue` in devDependencies" },
      { role: "frontend", detail: "`nuxt.config.ts`" },
    ] });
    expect(roles.server.evidence).toEqual([
      { role: "frontend", detail: "`vue` in devDependencies (workspace root manifest)" },
      { role: "frontend", detail: "`nuxt.config.ts` (workspace root manifest)" },
    ]);
    // shared is imported by server (product) and scripts (tooling): only server counts; frontend comes first.
    expect(roles.shared.evidence.at(-1)).toEqual({ role: "library", detail: "imported by `server`" });
    expect(roles.shared.role).toBe("frontend");
    expect(roles.scripts.role).toBe("tooling");
    expect(roles.test.role).toBe("test");
  });
});
