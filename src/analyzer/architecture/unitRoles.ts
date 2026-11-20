/**
 * Unit roles: what a unit of `graph-it architecture --level units` is (a deployable function, a
 * frontend, a service, a shared library...), inferred from its manifest and files with the
 * evidence behind it, or declared in graphit.architecture.json. A role is an interpretation
 * (#300): it is always shown with its evidence and its confidence.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { UNIT_ROLES, type UnitRole, type UnitRoleEvidence, type UnitRoleInfo } from "../../shared/architecture-model";
import { normalizePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { hasProjectMarker } from "../utils/workspaceBoundary";

/** `roles` of graphit.architecture.json: unit key or package name pattern → role. */
export type DeclaredRoles = Partial<Record<string, UnitRole>>;

/** Manifests and configs larger than this are ignored: they are read whole. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const FUNCTION_DEPENDENCIES = new Set(["@types/aws-lambda", "aws-lambda", "@azure/functions", "firebase-functions"]);
const FUNCTION_FILES = ["serverless.yml", "serverless.yaml", "host.json"];
const SAM_TEMPLATES = ["template.yaml", "template.yml"];
const FRONTEND_DEPENDENCIES = new Set(["react", "vue", "@angular/core", "svelte", "solid-js"]);
const SERVICE_DEPENDENCIES = new Set(["express", "fastify", "@nestjs/core", "koa", "hono"]);
const HTML_FILES = ["index.html", "public/index.html", "src/index.html"];
const BUNDLER_CONFIG = /^(?:(?:vite|webpack|next|nuxt|rspack|rsbuild|module-federation)\.config\.[cm]?[jt]s|angular\.json)$/;
const FEDERATION = /ModuleFederationPlugin|@module-federation\/|single-spa/;
const ENTRY_FILES = ["index.ts", "index.js", "src/index.ts", "src/index.js", "handler.ts", "handler.js", "src/handler.ts", "src/handler.js"];
/** `export const handler`, `exports.handler =`, `export { run as handler }`. */
const HANDLER_EXPORTS = [
  /\bexport\s+(?:const|let|var|(?:async\s+)?function)\s+handler\b/,
  /\bexports\.handler\s*=/,
  /\bexport\s*\{[^}]{0,1000}\bhandler\s*[,}]/,
];
const JAR_MAIN_PLUGINS = new Set(["maven-jar-plugin", "maven-shade-plugin", "maven-assembly-plugin"]);
/** Test-only modules: gson `shrinker-test`, `graal-native-image-test`, an `integration-tests` folder. */
const TEST_NAME = /(?:^|[-_.])(?:tests?|it|e2e|integration-tests?|testing)$/i;
const INHERITED = " (workspace root manifest)";
const NO_EVIDENCE = "no evidence: no manifest field, framework, entry point or product importer found";

/** What a file is for, from its workspace-relative path: shipped code is `other`. */
export type FileKind = "fixture" | "test" | "tooling" | "other";

const FIXTURE_ANYWHERE = new Set(["fixtures", "__fixtures__", "fixture", "testdata", "test-data"]);
const FIXTURE_AT_PROJECT_ROOT = new Set(["examples", "example", "samples", "sample", "demo", "demos"]);
const TEST_ANYWHERE = new Set(["test", "tests", "__tests__", "__mocks__", "spec", "specs", "e2e"]);
/** `.github` holds CI workflows and the actions they run: tooling, not shipped code. */
const TOOLING_ANYWHERE = new Set([".github"]);
const TOOLING_AT_PROJECT_ROOT = new Set(["scripts", "script", "tools", "bench", "benchmarks"]);
const TEST_FILES = [/\.(?:test|spec)\.[cm]?[jt]sx?$/, /_test\.go$/, /^test_.+\.py$/, /_test\.py$/, /(?:Tests?|IT)\.java$/, /Test\.kt$/, /Tests\.cs$/];
/** Only these configs are tooling: app, nuxt, vite, tailwind... configs ship with or build the product. */
const TOOL_CONFIGS = new Set(["eslint", "prettier", "stylelint", "vitest", "jest", "playwright", "cypress", "evalite", "karma", "commitlint", "typedoc", "knip"]);
const CONFIG_EXTENSIONS = new Set(["js", "ts", "mjs", "cjs", "mts", "cts"]);

/** `vitest.config.ts`, `vitest.e2e.config.mts`: a listed tool, optional dotted parts, `config`, a script extension. */
function isToolConfig(fileName: string): boolean {
  const parts = fileName.split(".");
  return parts.length >= 3 && TOOL_CONFIGS.has(parts[0]) && parts.at(-2) === "config" && CONFIG_EXTENSIONS.has(parts.at(-1)!);
}

/**
 * The kind of a workspace-relative file; the first match wins: fixture, test, tooling, else other.
 * `projectRoot` is the deepest folder above the file holding a manifest ("" for the workspace root):
 * a project-root-only segment (examples, scripts, tools...) counts only as the first folder below it,
 * so `src/mcp/tools/` stays product code.
 */
export function fileKind(relativePath: string, projectRoot: string): FileKind {
  const folders = normalizePath(relativePath).split("/");
  const fileName = folders.pop()!;
  const depth = projectRoot === "" ? 0 : normalizePath(projectRoot).split("/").length;
  const first = folders[depth];
  const atProjectRoot = (names: ReadonlySet<string>) => first !== undefined && names.has(first);
  if (folders.some((folder) => FIXTURE_ANYWHERE.has(folder)) || atProjectRoot(FIXTURE_AT_PROJECT_ROOT)) return "fixture";
  if (folders.some((folder) => TEST_ANYWHERE.has(folder)) || TEST_FILES.some((pattern) => pattern.test(fileName))) return "test";
  if (folders.some((folder) => TOOLING_ANYWHERE.has(folder)) || atProjectRoot(TOOLING_AT_PROJECT_ROOT) || isToolConfig(fileName)) return "tooling";
  return "other";
}

/** `*` matches any characters, everything else itself (no regular expression from the config). */
export function matchesWildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * A file of the unit folder, or undefined when it is missing, not a regular file, too large or
 * outside the workspace (a symbolic link, or a manifest `main` going up with ..).
 */
function readUnitFile(workspaceRoot: string, folder: string, file: string): string | undefined {
  try {
    const absolute = validateWorkspacePath(path.join(workspaceRoot, folder, file), workspaceRoot);
    const stat = fs.statSync(absolute);
    return stat.isFile() && stat.size <= MAX_MANIFEST_BYTES ? fs.readFileSync(absolute, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function listFolder(workspaceRoot: string, folder: string): Set<string> {
  try {
    return new Set(fs.readdirSync(validateWorkspacePath(path.join(workspaceRoot, folder), workspaceRoot)));
  } catch {
    return new Set();
  }
}

type Manifest = Record<string, unknown>;

function parseManifest(text: string | undefined): Manifest {
  try {
    const manifest: unknown = JSON.parse(text ?? "{}");
    return typeof manifest === "object" && manifest !== null && !Array.isArray(manifest) ? (manifest as Manifest) : {};
  } catch {
    return {};
  }
}

/** Every dependency of the manifest with the field declaring it, in field then manifest order. */
function dependenciesOf(manifest: Manifest): [string, string][] {
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const value = manifest[field];
    return typeof value === "object" && value !== null ? Object.keys(value).map((name): [string, string] => [name, field]) : [];
  });
}

export interface UnitRoleInput {
  /** Workspace-relative folder of the unit ("" for the workspace root). */
  folder: string;
  /** Workspace-relative files of the unit. */
  files: readonly string[];
  /** Names of the other units importing it through a product pair (the importing file has kind `other`). */
  importers: readonly string[];
  /** Unit name, matched with the folder basename against the test-module name pattern. */
  name?: string;
  /** Kind of each file of `files`, same order; computed with `folder` as project root when absent. */
  kinds?: readonly FileKind[];
  /** False: no manifest is read (an element unit across folders never takes the root manifest's evidence). */
  manifest?: boolean;
}

/** Evidence of the workspace root manifest, read once per build: units without a manifest inherit it. */
export type RootEvidenceCache = Map<string, UnitRoleEvidence[]>;

/** The unit's entry, `handler.*` or `index.*` included: manifest `main` and `module` often point at build output. */
function exportsHandler(workspaceRoot: string, folder: string, manifest: Manifest): string | undefined {
  const entries = [manifest.main, manifest.module, ...ENTRY_FILES].filter((entry): entry is string => typeof entry === "string");
  return entries.find((entry) => {
    const text = readUnitFile(workspaceRoot, folder, entry) ?? "";
    return HANDLER_EXPORTS.some((pattern) => pattern.test(text));
  });
}

/** What one unit folder holds: its entries, its dependencies, and its files read on demand. */
interface UnitFolder {
  workspaceRoot: string;
  folder: string;
  entries: Set<string>;
  manifest: Manifest;
  dependencies: [string, string][];
  /** A file of the folder's own entries, "" when missing or unreadable. */
  read: (file: string) => string;
}

function openFolder(workspaceRoot: string, folder: string): UnitFolder {
  const entries = listFolder(workspaceRoot, folder);
  const read = (file: string) => (entries.has(file) ? readUnitFile(workspaceRoot, folder, file) ?? "" : "");
  const manifest = parseManifest(read("package.json") || undefined);
  return { workspaceRoot, folder, entries, manifest, dependencies: dependenciesOf(manifest), read };
}

const dependencyEvidence = (unit: UnitFolder, role: UnitRole, matches: (name: string) => boolean): UnitRoleEvidence[] =>
  unit.dependencies.filter(([name]) => matches(name)).map(([name, field]) => ({ role, detail: `\`${name}\` in ${field}` }));

function functionEvidence(unit: UnitFolder): UnitRoleEvidence[] {
  const files = [
    ...FUNCTION_FILES.filter((file) => unit.entries.has(file)).map((file) => `\`${file}\``),
    ...SAM_TEMPLATES.filter((file) => unit.read(file).includes("AWS::Serverless")).map((file) => `\`${file}\` (AWS SAM)`),
  ];
  const handler = exportsHandler(unit.workspaceRoot, unit.folder, unit.manifest);
  if (handler !== undefined) files.push(`exported \`handler\` in \`${handler}\``);
  return [...dependencyEvidence(unit, "function", (name) => FUNCTION_DEPENDENCIES.has(name)), ...files.map((detail) => ({ role: "function" as const, detail }))];
}

function microFrontendEvidence(unit: UnitFolder, configs: readonly string[]): UnitRoleEvidence[] {
  return [
    ...dependencyEvidence(unit, "micro-frontend", (name) => name === "single-spa" || name.startsWith("@module-federation/")),
    ...configs.filter((config) => FEDERATION.test(unit.read(config))).map((config) => ({ role: "micro-frontend" as const, detail: `Module Federation in \`${config}\`` })),
  ];
}

/** A UI framework counts only with a page or a bundler config: a library may depend on react too. */
function frontendEvidence(unit: UnitFolder, configs: readonly string[]): UnitRoleEvidence[] {
  const frameworks = dependencyEvidence(unit, "frontend", (name) => FRONTEND_DEPENDENCIES.has(name));
  const html = HTML_FILES.filter((file) => readUnitFile(unit.workspaceRoot, unit.folder, file) !== undefined);
  if (frameworks.length === 0 || html.length + configs.length === 0) return [];
  return [...frameworks, ...[...html, ...configs].map((file) => ({ role: "frontend" as const, detail: `\`${file}\`` }))];
}

function serviceEvidence(unit: UnitFolder): UnitRoleEvidence[] {
  const docker = /^[ \t]*EXPOSE[ \t]/im.test(unit.read("Dockerfile")) ? [{ role: "service" as const, detail: "`Dockerfile` with EXPOSE" }] : [];
  return [...dependencyEvidence(unit, "service", (name) => SERVICE_DEPENDENCIES.has(name)), ...docker];
}

/** The `<tag>` text of an XML part, trimmed; undefined without the tag. */
function xmlValue(text: string, tag: string): string | undefined {
  const start = text.indexOf(`<${tag}>`);
  if (start < 0) return undefined;
  const end = text.indexOf(`</${tag}>`, start);
  return end < 0 ? undefined : text.slice(start + tag.length + 2, end).trim();
}

/** Text of `text` outside every `open`…`close` block; an unclosed block runs to the end. */
export function outside(text: string, open: string, close: string): string {
  return text.split(open).map((part, index) => {
    if (index === 0) return part;
    const end = part.indexOf(close);
    return end < 0 ? "" : part.slice(end + close.length);
  }).join("");
}

/** A pom.xml without its comments and its `<parent>` block: what is left names this module (#774). */
export function mavenOwnPart(pom: string | undefined): string | undefined {
  return pom === undefined ? undefined : outside(outside(pom, "<!--", "-->"), "<parent>", "</parent>");
}

/** Each `<plugin>` element of a pom: its artifactId, and whether a `<mainClass>` sits inside that element (never a later one). */
function mavenPlugins(pom: string): { artifactId: string; mainClass: boolean }[] {
  return pom.split("<plugin>").slice(1).map((part) => {
    const end = part.indexOf("</plugin>");
    const body = end < 0 ? part : part.slice(0, end);
    return { artifactId: xmlValue(body, "artifactId") ?? "", mainClass: body.includes("<mainClass>") };
  });
}

function mavenEvidence(pomText: string): UnitRoleEvidence[] {
  const pom = mavenOwnPart(pomText)!;
  const plugins = mavenPlugins(pom);
  const evidence: UnitRoleEvidence[] = [];
  if (plugins.some((plugin) => plugin.artifactId === "spring-boot-maven-plugin")) evidence.push({ role: "application", detail: "`spring-boot-maven-plugin` in `pom.xml`" });
  // A <mainClass> of exec-maven-plugin (or any other plugin) runs a tool at build time: only the jar manifest makes an application.
  for (const plugin of plugins.filter((entry) => entry.mainClass && JAR_MAIN_PLUGINS.has(entry.artifactId))) {
    evidence.push({ role: "application", detail: `\`<mainClass>\` in \`${plugin.artifactId}\` of \`pom.xml\`` });
  }
  const packaging = xmlValue(outside(pom, "<build>", "</build>"), "packaging");
  if (packaging === "war") evidence.push({ role: "service", detail: "`pom.xml` packaging `war`" });
  if (packaging === undefined || packaging === "jar") evidence.push({ role: "library", detail: packaging === undefined ? "`pom.xml` packaging `jar` (default)" : "`pom.xml` packaging `jar`" });
  return evidence;
}

function packageJsonEvidence(manifest: Manifest): UnitRoleEvidence[] {
  const evidence: UnitRoleEvidence[] = [];
  const bin = manifest.bin;
  if ((typeof bin === "string" && bin !== "") || (typeof bin === "object" && bin !== null && Object.keys(bin).length > 0)) {
    evidence.push({ role: "application", detail: "`bin` in `package.json`" });
  }
  const engines = manifest.engines;
  const editor = typeof engines === "object" && engines !== null && "vscode" in engines;
  if (editor && typeof manifest.main === "string") evidence.push({ role: "application", detail: "`engines.vscode` and `main` in `package.json` (editor extension)" });
  const entry = editor ? undefined : (["exports", "main", "module"] as const).find((field) => manifest[field] !== undefined);
  if (entry !== undefined) evidence.push({ role: "library", detail: `\`${entry}\` in \`package.json\`` });
  return evidence;
}

/** pyproject.toml, Cargo.toml and main.go: entry points make an application, `src/lib.rs` a library. */
function otherManifestEvidence(unit: UnitFolder): UnitRoleEvidence[] {
  const evidence: UnitRoleEvidence[] = [];
  if (/^\[project\.scripts\]/m.test(unit.read("pyproject.toml"))) evidence.push({ role: "application", detail: "`[project.scripts]` in `pyproject.toml`" });
  if (unit.entries.has("Cargo.toml")) {
    if (/^\[\[bin\]\]/m.test(unit.read("Cargo.toml"))) evidence.push({ role: "application", detail: "`[[bin]]` in `Cargo.toml`" });
    if (readUnitFile(unit.workspaceRoot, unit.folder, "src/main.rs") !== undefined) evidence.push({ role: "application", detail: "`src/main.rs`" });
    if (readUnitFile(unit.workspaceRoot, unit.folder, "src/lib.rs") !== undefined) evidence.push({ role: "library", detail: "`src/lib.rs`" });
  }
  if (/^package main\b/m.test(unit.read("main.go"))) evidence.push({ role: "application", detail: "`main.go` declaring `package main`" });
  return evidence;
}

/** Every piece of evidence a folder's own manifests and configs give, product importers and file kinds aside. */
function manifestEvidence(workspaceRoot: string, folder: string): UnitRoleEvidence[] {
  const unit = openFolder(workspaceRoot, folder);
  // Code-unit order, as everywhere in the architecture output: the same on every OS and locale.
  const configs = [...unit.entries].filter((file) => BUNDLER_CONFIG.test(file)).sort((left, right) => (left < right ? -1 : Number(left > right)));
  const pom = unit.read("pom.xml");
  return [
    ...packageJsonEvidence(unit.manifest),
    ...otherManifestEvidence(unit),
    ...(pom === "" ? [] : mavenEvidence(pom)),
    ...functionEvidence(unit),
    ...microFrontendEvidence(unit, configs),
    ...frontendEvidence(unit, configs),
    ...serviceEvidence(unit),
  ];
}

/** The workspace root manifest's evidence, marked inherited, for a folder holding no manifest of its own. */
function inheritedEvidence(workspaceRoot: string, folder: string, cache: RootEvidenceCache): UnitRoleEvidence[] {
  if (folder === "" || hasProjectMarker(path.join(workspaceRoot, folder))) return [];
  let root = cache.get(workspaceRoot);
  if (root === undefined) {
    root = hasProjectMarker(workspaceRoot)
      ? manifestEvidence(workspaceRoot, "").map((entry) => ({ role: entry.role, detail: `${entry.detail}${INHERITED}` }))
      : [];
    cache.set(workspaceRoot, root);
  }
  return root;
}

/** Every file is a test, fixture or tooling file: the role of the most frequent kind (a tie goes to test, then fixture). */
function fileKindEvidence(kinds: readonly FileKind[]): UnitRoleEvidence | undefined {
  if (kinds.length === 0 || kinds.includes("other")) return undefined;
  const count = (kind: FileKind) => kinds.filter((entry) => entry === kind).length;
  const [test, fixture, tooling] = [count("test"), count("fixture"), count("tooling")];
  let role: "test" | "fixture" | "tooling" = "tooling";
  if (test >= fixture && test >= tooling) role = "test";
  else if (fixture >= tooling) role = "fixture";
  return { role, detail: `only tests, fixtures or tooling (${test} test, ${fixture} fixture, ${tooling} tooling ${kinds.length === 1 ? "file" : "files"})` };
}

function testNameEvidence(name: string | undefined, folder: string): UnitRoleEvidence | undefined {
  const match = [name ?? "", path.posix.basename(folder)].find((candidate) => TEST_NAME.test(candidate));
  return match === undefined ? undefined : { role: "test", detail: `name "${match}" matches a test module name` };
}

const rolePriority = (entry: UnitRoleEvidence) => UNIT_ROLES.indexOf(entry.role);

/**
 * Every piece of evidence kept for the unit, in role priority order. Manifests are parsed as JSON,
 * other files only searched for a key or a name: nothing is executed. Test-like evidence (every file a
 * test, fixture or tooling file, or a test-module name) drops application, library and inherited
 * evidence: a test module usually has a manifest that looks like a product, and tests import each other (#468).
 */
function collectEvidence(workspaceRoot: string, input: UnitRoleInput, cache: RootEvidenceCache): UnitRoleEvidence[] {
  const read = input.manifest !== false;
  const direct = read ? manifestEvidence(workspaceRoot, input.folder) : [];
  const inherited = read ? inheritedEvidence(workspaceRoot, input.folder, cache) : [];
  const importers = input.importers.map((name) => `\`${name}\``).join(", ");
  const imported: UnitRoleEvidence[] = importers ? [{ role: "library", detail: `imported by ${importers}` }] : [];
  const kinds = input.kinds ?? input.files.map((file) => fileKind(file, input.folder));
  const testLike = [fileKindEvidence(kinds), testNameEvidence(input.name, input.folder)].filter((entry) => entry !== undefined);
  const kept = testLike.length === 0
    ? [...direct, ...imported, ...inherited]
    : [...direct.filter((entry) => entry.role !== "application" && entry.role !== "library"), ...testLike];
  return kept.toSorted((left, right) => rolePriority(left) - rolePriority(right));
}

/** The first role by priority among the evidence; without any, unknown with the reason. */
export function inferUnitRole(workspaceRoot: string, unit: UnitRoleInput, cache: RootEvidenceCache = new Map()): UnitRoleInfo {
  const evidence = collectEvidence(workspaceRoot, unit, cache);
  if (evidence.length === 0) return { role: "unknown", confidence: "inferred", evidence: [{ role: "unknown", detail: NO_EVIDENCE }] };
  return { role: evidence[0].role, confidence: "inferred", evidence };
}

/** A role declared for the unit (first pattern matching its key or name) wins; the inferred evidence stays. */
export function unitRole(
  workspaceRoot: string,
  unit: UnitRoleInput & { key: string; name: string },
  declared?: DeclaredRoles,
  cache: RootEvidenceCache = new Map(),
): UnitRoleInfo {
  const inferred = inferUnitRole(workspaceRoot, unit, cache);
  const match = Object.entries(declared ?? {}).find(([pattern]) => matchesWildcard(pattern, unit.key) || matchesWildcard(pattern, unit.name));
  if (match?.[1] === undefined) return inferred;
  const [pattern, role] = match;
  return { role, confidence: "declared", evidence: [{ role, detail: `declared by roles["${pattern}"] in graphit.architecture.json` }, ...inferred.evidence] };
}
