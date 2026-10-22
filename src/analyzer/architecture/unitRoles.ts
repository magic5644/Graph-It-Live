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
import { validateWorkspacePath } from "../../shared/pathSecurity";

/** In priority order: a unit matching several roles takes the first. */
export const UNIT_ROLES = ["function", "micro-frontend", "frontend", "service", "library", "tooling", "unknown"] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];

export interface UnitRoleEvidence {
  /** The role this piece of evidence points to; the unit's role is the first by priority. */
  role: UnitRole;
  detail: string;
}

export interface UnitRoleInfo {
  role: UnitRole;
  /** `declared` in graphit.architecture.json, else `inferred` from the evidence. */
  confidence: "inferred" | "declared";
  evidence: UnitRoleEvidence[];
}

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
const TOOLING_FOLDERS = new Set(["scripts", "script", "tools", "e2e", "test", "tests", "__tests__", "__mocks__", "fixtures", "bench", "benchmarks"]);
const TOOLING_FILE = /\.(?:test|spec|config)\.[cm]?[jt]sx?$/;

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

const isToolingFile = (file: string) => {
  const parts = file.split("/");
  return parts.slice(0, -1).some((part) => TOOLING_FOLDERS.has(part)) || TOOLING_FILE.test(parts.at(-1)!);
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export interface UnitRoleInput {
  /** Workspace-relative folder of the unit ("" for the workspace root). */
  folder: string;
  /** Workspace-relative files of the unit. */
  files: readonly string[];
  /** Names of the other units importing it. */
  importers: readonly string[];
}

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

/**
 * Every piece of evidence found for every role, in role priority order. Manifests are parsed as
 * JSON, other files only searched for a key or a name: nothing is executed.
 */
function collectEvidence(workspaceRoot: string, input: UnitRoleInput): UnitRoleEvidence[] {
  const unit = openFolder(workspaceRoot, input.folder);
  // Code-unit order, as everywhere in the architecture output: the same on every OS and locale.
  const configs = [...unit.entries].filter((file) => BUNDLER_CONFIG.test(file)).sort((left, right) => (left < right ? -1 : Number(left > right)));
  const evidence = [...functionEvidence(unit), ...microFrontendEvidence(unit, configs), ...frontendEvidence(unit, configs), ...serviceEvidence(unit)];
  const importers = input.importers.map((name) => `\`${name}\``).join(", ");
  if (importers) evidence.push({ role: "library", detail: `imported by ${importers}` });
  if (input.files.length > 0 && input.files.every(isToolingFile)) {
    evidence.push({ role: "tooling", detail: `only scripts, tests or config (${plural(input.files.length, "file")})` });
  }
  return evidence;
}

/** The first role by priority among the evidence, else unknown. */
export function inferUnitRole(workspaceRoot: string, unit: UnitRoleInput): UnitRoleInfo {
  const evidence = collectEvidence(workspaceRoot, unit);
  const role = UNIT_ROLES.find((candidate) => evidence.some((entry) => entry.role === candidate)) ?? "unknown";
  return { role, confidence: "inferred", evidence };
}

/** A role declared for the unit (first pattern matching its key or name) wins; the inferred evidence stays. */
export function unitRole(workspaceRoot: string, unit: UnitRoleInput & { key: string; name: string }, declared?: DeclaredRoles): UnitRoleInfo {
  const inferred = inferUnitRole(workspaceRoot, unit);
  const match = Object.entries(declared ?? {}).find(([pattern]) => matchesWildcard(pattern, unit.key) || matchesWildcard(pattern, unit.name));
  if (match?.[1] === undefined) return inferred;
  const [pattern, role] = match;
  return { role, confidence: "declared", evidence: [{ role, detail: `declared by roles["${pattern}"] in graphit.architecture.json` }, ...inferred.evidence] };
}
