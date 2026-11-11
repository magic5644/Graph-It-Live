/**
 * Declared entry points (#690, #696): what a language manifest declares is loaded by a runtime, a package manager or
 * another project, never by a workspace import, so the dead-code scan counts it as used. Pure functions over text
 * the caller read once per scan; a path is kept only when it names a workspace source file inside the root.
 */
import path from "node:path";
import { getRelativePath, normalizePath } from "../../shared/path";
import { isPathWithinRoot } from "../../shared/pathSecurity";

export const MANIFEST_FILE_NAMES: ReadonlySet<string> = new Set(["package.json", "pyproject.toml", "setup.cfg", "setup.py", "Cargo.toml"]);

/** Every export of the file is used. */
export const WHOLE_FILE = "*";

/**
 * file (absolute, normalized) → exported name, or `WHOLE_FILE`, → why it is used (`declared:<manifest>#<field>`).
 * A Rust crate-API file (`#lib`) is declared whole: Rust exports are `pub` items, and the scan drops `pub(crate)`,
 * `pub(super)` and `pub(in …)` ones (`restrictedRustItem` in SpiderSymbolService).
 */
export type DeclaredEntryPoints = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Where a TypeScript package builds to, from the `compilerOptions` of its tsconfig.json (absolute, normalized). */
export interface BuildLayout {
  outDir?: string;
  rootDir?: string;
}

export interface Manifest {
  /** Absolute, normalized */
  file: string;
  text: string;
  /** package.json only: its folder's tsconfig layout */
  layout?: BuildLayout;
}

export interface EntryPointSources {
  rootDir: string;
  /** Workspace source files, absolute and normalized */
  files: ReadonlySet<string>;
  manifests: readonly Manifest[];
  /** `__init__.py` → the names of its `__all__` */
  pythonAll: ReadonlyMap<string, readonly string[]>;
  /** Rust file → the modules it declares `pub mod name;` */
  rustPubMods: ReadonlyMap<string, readonly string[]>;
  /** Rust file → the functions a runtime attribute (`#[no_mangle]`, `#[proc_macro]`, ...) marks, with the attribute */
  rustAttributed: ReadonlyMap<string, ReadonlyArray<{ name: string; attribute: string }>>;
}

interface Entry {
  file: string;
  name: string;
  source: string;
}

interface Collected {
  entries: Entry[];
  warnings: string[];
}

/** The declared entry points of a workspace, and a warning per manifest that could not be read. */
export function collectDeclaredEntryPoints(sources: EntryPointSources): { entryPoints: DeclaredEntryPoints; warnings: string[] } {
  const collected: Collected = { entries: [], warnings: [] };
  for (const manifest of sources.manifests) {
    // A BOM (common in files written on Windows) is not JSON or TOML.
    const text = manifest.text.replace(/^\uFEFF/, "");
    MANIFEST_READERS[path.posix.basename(manifest.file)]?.({ ...manifest, text }, getRelativePath(manifest.file, sources.rootDir), sources, collected);
  }
  for (const file of sources.files) {
    if (path.posix.basename(file) === "__main__.py") collected.entries.push({ file, name: WHOLE_FILE, source: "declared:__main__.py" });
  }
  for (const [file, names] of sources.pythonAll) {
    const source = `declared:${getRelativePath(file, sources.rootDir)}#__all__`;
    for (const name of names) collected.entries.push({ file, name, source });
  }
  for (const [file, functions] of sources.rustAttributed) {
    for (const { name, attribute } of functions) collected.entries.push({ file, name, source: `attribute:#[${attribute}]` });
  }

  const entryPoints = new Map<string, Map<string, string>>();
  for (const { file, name, source } of collected.entries) {
    const names = entryPoints.get(file) ?? new Map<string, string>();
    if (!names.has(name)) names.set(name, source);
    entryPoints.set(file, names);
  }
  return { entryPoints, warnings: collected.warnings };
}

type ManifestReader = (manifest: Manifest, rel: string, sources: EntryPointSources, out: Collected) => void;

const MANIFEST_READERS: Readonly<Record<string, ManifestReader>> = {
  "package.json": (...args) => packageJsonEntries(...args),
  "pyproject.toml": (...args) => pyprojectEntries(...args),
  "setup.cfg": (...args) => setupCfgEntries(...args),
  "setup.py": (...args) => setupPyEntries(...args),
  "Cargo.toml": (...args) => cargoEntries(...args),
};

/** Why `name` of `file` is used, or undefined when no manifest declares it. */
export function declaredReason(entryPoints: DeclaredEntryPoints, file: string, name: string): string | undefined {
  const names = entryPoints.get(file);
  return names?.get(WHOLE_FILE) ?? names?.get(name);
}

// ---------------------------------------------------------------------------------------------------------------
// package.json

const PACKAGE_PATH_FIELDS = ["main", "module", "types", "typings"] as const;

function packageJsonEntries(manifest: Manifest, rel: string, sources: EntryPointSources, out: Collected): void {
  const pkg = parseJsonObject(manifest.text);
  if (!pkg) {
    out.warnings.push(`${rel}: not a JSON object, its entry points are ignored`);
    return;
  }
  const declared: Array<{ field: string; target: unknown }> = [];
  for (const field of PACKAGE_PATH_FIELDS) {
    if (field in pkg) declared.push({ field, target: pkg[field] });
  }
  declared.push(...mapField("browser", pkg.browser, out, rel), ...mapField("bin", pkg.bin, out, rel));
  if (pkg.exports !== undefined) exportTargets(pkg.exports, undefined, declared, out, rel);
  // npm loads index.js when a published package declares no entry.
  const publishable = typeof pkg.name === "string" && pkg.private !== true;
  if (publishable && pkg.main === undefined && pkg.module === undefined && pkg.exports === undefined) {
    declared.push({ field: "main(default: index.js)", target: "index.js" });
  }
  const baseDir = path.posix.dirname(manifest.file);
  for (const { field, target } of declared) {
    if (typeof target !== "string") {
      out.warnings.push(`${rel}: ${field} is not a path, ignored`);
      continue;
    }
    for (const file of sourceCandidates(baseDir, target, manifest.layout ?? {}, sources)) {
      out.entries.push({ file, name: WHOLE_FILE, source: `declared:${rel}#${field}` });
    }
  }
}

/** `browser` / `bin`: a path, or a map whose values are paths (`false` in `browser` blocks a module). */
function mapField(field: string, value: unknown, out: Collected, rel: string): Array<{ field: string; target: unknown }> {
  if (value === undefined || typeof value === "string") return value === undefined ? [] : [{ field, target: value }];
  if (!isObject(value)) {
    out.warnings.push(`${rel}: ${field} is neither a path nor a map, ignored`);
    return [];
  }
  return Object.entries(value).filter(([, target]) => target !== false).map(([key, target]) => ({ field: `${field}[${JSON.stringify(key)}]`, target }));
}

/** Every target of `exports`: subpaths, nested conditions and fallback arrays; `null` excludes a subpath. */
function exportTargets(value: unknown, subpath: string | undefined, declared: Array<{ field: string; target: unknown }>, out: Collected, rel: string): void {
  const field = subpath === undefined ? "exports" : `exports[${JSON.stringify(subpath)}]`;
  if (value === null) return;
  if (typeof value === "string") {
    declared.push({ field, target: value });
  } else if (Array.isArray(value)) {
    for (const item of value) exportTargets(item, subpath, declared, out, rel);
  } else if (isObject(value)) {
    for (const [key, target] of Object.entries(value)) {
      // Keys starting with "." are subpaths; the others are conditions of the current subpath.
      exportTargets(target, key.startsWith(".") ? key : (subpath ?? "."), declared, out, rel);
    }
  } else {
    out.warnings.push(`${rel}: ${field} is not a path, a list or a map, ignored`);
  }
}

const OUTPUT_TO_SOURCE: ReadonlyArray<[string, readonly string[]]> = [
  [".d.ts", [".ts", ".tsx", ".d.ts"]],
  [".d.mts", [".mts", ".d.mts"]],
  [".d.cts", [".cts", ".d.cts"]],
  [".js", [".ts", ".tsx", ".js", ".jsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
];
const RESOLVED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

/** Folders bundlers write to by convention; tsconfig `outDir` counts too. */
const BUILD_FOLDERS: ReadonlySet<string> = new Set(["dist", "out", "build"]);

/**
 * The workspace source files a manifest path names: the path itself when it exists; otherwise, for a build output only
 * (under tsconfig `outDir` or a `dist/`, `out/`, `build/` folder), its source under tsconfig `rootDir`, `.js` read as
 * `.ts` / `.tsx` and so on. A `*` pattern matches any workspace file. Every candidate found is returned; none when the
 * path is absolute, leaves the root or names nothing (a stale path is never guessed).
 */
function sourceCandidates(baseDir: string, declared: string, layout: BuildLayout, sources: Pick<EntryPointSources, "rootDir" | "files">): string[] {
  // String joins on normalized paths: `c:/ws` stays a drive path on every platform.
  if (path.posix.isAbsolute(declared) || path.win32.isAbsolute(declared)) return [];
  const resolved = normalizePath(path.posix.join(baseDir, declared.replaceAll("\\", "/")));
  if (!isPathWithinRoot(resolved, sources.rootDir)) return [];
  const found = matchingAny([resolved], sources.files);
  if (found.length > 0 || !isBuildOutput(resolved, baseDir, layout)) return found;
  const mirrored = matchingAny(mirroredInRootDir(resolved, baseDir, layout), sources.files);
  if (mirrored.length > 0 || declared.includes("*")) return mirrored;
  return uniqueByStem(resolved, layout, sources.files);
}

function matchingAny(bases: string[], files: ReadonlySet<string>): string[] {
  return [...new Set(bases.flatMap(withSourceExtensions).flatMap((candidate) => matching(candidate, files)))];
}

function isBuildOutput(resolved: string, baseDir: string, layout: BuildLayout): boolean {
  if (layout.outDir && isWithin(resolved, layout.outDir)) return true;
  return BUILD_FOLDERS.has(path.posix.relative(baseDir, resolved).split("/")[0]);
}

/** `out/a/b.js` under tsconfig `outDir` is `<rootDir>/a/b.js`; `dist/a/b.js` (a bundle folder) is `<rootDir>/a/b.js`. */
function mirroredInRootDir(resolved: string, baseDir: string, layout: BuildLayout): string[] {
  const { outDir, rootDir } = layout;
  if (outDir && isWithin(resolved, outDir)) return [normalizePath(path.posix.join(rootDir ?? baseDir, resolved.slice(outDir.length)))];
  if (!rootDir) return [];
  const [, ...rest] = path.posix.relative(baseDir, resolved).split("/");
  return rest.length > 0 ? [normalizePath(path.posix.join(rootDir, ...rest))] : [];
}

/**
 * shortcut: a bundle named after its entry (`dist/extension.js` built from `src/extension/extension.ts`) is matched by
 * file stem under tsconfig `rootDir`, only for a build output and when one file has that stem; read the bundler config
 * if this misses.
 */
function uniqueByStem(resolved: string, layout: BuildLayout, files: ReadonlySet<string>): string[] {
  const { rootDir } = layout;
  if (!rootDir) return [];
  const stem = stemOf(resolved);
  const matches = [...files].filter((file) => isWithin(file, rootDir) && stemOf(file) === stem);
  return matches.length === 1 ? matches : [];
}

function stemOf(file: string): string {
  const base = path.posix.basename(file);
  const dot = base.indexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function withSourceExtensions(base: string): string[] {
  const output = OUTPUT_TO_SOURCE.find(([ext]) => base.endsWith(ext));
  if (output) return output[1].map((ext) => base.slice(0, -output[0].length) + ext);
  if (path.posix.extname(base) !== "") return [base];
  return [base, ...RESOLVED_EXTENSIONS.flatMap((ext) => [base + ext, `${base}/index${ext}`])];
}

function matching(candidate: string, files: ReadonlySet<string>): string[] {
  if (!candidate.includes("*")) return files.has(candidate) ? [candidate] : [];
  const pattern = new RegExp(`^${candidate.split("*").map(escapeRegExp).join(".*")}$`);
  return [...files].filter((file) => pattern.test(file));
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function isWithin(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

// ---------------------------------------------------------------------------------------------------------------
// Python

const PYPROJECT_SCRIPT_TABLES: ReadonlySet<string> = new Set(["project.scripts", "project.gui-scripts", "tool.poetry.scripts"]);

function pyprojectEntries(manifest: Manifest, rel: string, sources: EntryPointSources, out: Collected): void {
  const tables = readToml(manifest.text);
  if (!tables) {
    out.warnings.push(`${rel}: not valid TOML, its entry points are ignored`);
    return;
  }
  for (const table of tables) {
    const scripts = PYPROJECT_SCRIPT_TABLES.has(table.name) || table.name.startsWith("project.entry-points.");
    if (!scripts) continue;
    for (const [key, value] of table.values) pythonEntry(manifest.file, value, `declared:${rel}#${table.name}.${key}`, sources, out);
  }
}

/** setup.cfg `[options.entry_points]`: `group =` then indented `name = module:attr` lines. */
function setupCfgEntries(manifest: Manifest, rel: string, sources: EntryPointSources, out: Collected): void {
  let inEntryPoints = false;
  let group = "";
  for (const line of manifest.text.split(/\r?\n/)) {
    const section = /^\[([^\]]+)\]/.exec(line);
    if (section) {
      inEntryPoints = section[1].trim() === "options.entry_points";
      continue;
    }
    if (!inEntryPoints || line.trim() === "" || /^\s*[#;]/.test(line)) continue;
    // An unindented line opens a group (`console_scripts =`, maybe with a first entry after it).
    let entry = line.trim();
    if (/^\S/.test(line)) {
      const eq = line.indexOf("=");
      group = (eq < 0 ? line : line.slice(0, eq)).trim();
      entry = eq < 0 ? "" : line.slice(eq + 1).trim();
    }
    if (entry !== "") pythonEntryLine(manifest.file, entry, `declared:${rel}#options.entry_points.${group}`, sources, out);
  }
}

/** setup.py: the `name = module:attr` strings of the `entry_points=` argument (its brackets, strings aside). */
function setupPyEntries(manifest: Manifest, rel: string, sources: EntryPointSources, out: Collected): void {
  const start = manifest.text.indexOf("entry_points");
  if (start < 0) return;
  for (const match of bracketedValue(manifest.text, start).matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) {
    const text = match[1] ?? match[2];
    if (text.includes(":")) pythonEntryLine(manifest.file, text, `declared:${rel}#entry_points`, sources, out);
  }
}

/** From the first `{` or `[` after `start` to its closing bracket (the rest of the text when unbalanced). */
function bracketedValue(text: string, start: number): string {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if ((char === "}" || char === "]") && depth > 0 && --depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** `name = module:attr [extras]` */
function pythonEntryLine(manifestFile: string, line: string, source: string, sources: EntryPointSources, out: Collected): void {
  const eq = line.indexOf("=");
  if (eq > 0) pythonEntry(manifestFile, line.slice(eq + 1), source, sources, out);
}

/** `package.module:attr.sub` (or a module alone): the module file under the manifest folder or its `src/`. */
function pythonEntry(manifestFile: string, value: string, source: string, sources: EntryPointSources, out: Collected): void {
  const reference = /^\s*([A-Za-z_][\w.]*)\s*(?::\s*([A-Za-z_]\w*))?/.exec(value);
  if (!reference) return;
  const [, moduleName, attribute] = reference;
  const dir = path.posix.dirname(manifestFile);
  const modulePath = moduleName.split(".");
  for (const base of [dir, `${dir}/src`]) {
    for (const file of [`${path.posix.join(base, ...modulePath)}.py`, path.posix.join(base, ...modulePath, "__init__.py")]) {
      if (sources.files.has(file)) out.entries.push({ file, name: attribute ?? WHOLE_FILE, source });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rust

function cargoEntries(manifest: Manifest, rel: string, sources: EntryPointSources, out: Collected): void {
  const tables = readToml(manifest.text);
  if (!tables) {
    out.warnings.push(`${rel}: not valid TOML, its entry points are ignored`);
    return;
  }
  const dir = path.posix.dirname(manifest.file);
  const isPackage = tables.some((table) => table.name === "package");
  const lib = tables.find((table) => table.name === "lib");
  const libPath = lib?.values.get("path") ?? (isPackage || lib ? "src/lib.rs" : undefined);
  if (libPath) {
    const libRoot = normalizePath(path.posix.join(dir, libPath));
    for (const file of crateModules(libRoot, sources)) out.entries.push({ file, name: WHOLE_FILE, source: `declared:${rel}#lib` });
  }
  const bins = tables.filter((table) => table.name === "bin").map((table) => table.values.get("path")).filter((p): p is string => p !== undefined);
  const binFiles = bins.map((bin) => normalizePath(path.posix.join(dir, bin)));
  if (isPackage) {
    binFiles.push(`${dir}/src/main.rs`, ...[...sources.files].filter((file) => isDefaultBin(file, `${dir}/src/bin/`)));
  }
  for (const file of binFiles) {
    if (sources.files.has(file) && isPathWithinRoot(file, sources.rootDir)) out.entries.push({ file, name: "main", source: `declared:${rel}#bin` });
  }
}

function isDefaultBin(file: string, binDir: string): boolean {
  if (!file.startsWith(binDir)) return false;
  const rest = file.slice(binDir.length).split("/");
  return (rest.length === 1 && rest[0].endsWith(".rs")) || (rest.length === 2 && rest[1] === "main.rs");
}

/** The crate root and every module file it reaches through `pub mod name;` declarations. */
function crateModules(root: string, sources: EntryPointSources): string[] {
  if (!sources.files.has(root) || !isPathWithinRoot(root, sources.rootDir)) return [];
  const reached = new Set([root]);
  const queue = [root];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const base = path.posix.basename(file);
    // `lib.rs`, `main.rs` and `mod.rs` own their folder; `foo.rs` owns `foo/`.
    const childDir = ["lib.rs", "main.rs", "mod.rs"].includes(base) || file === root ? path.posix.dirname(file) : file.slice(0, -".rs".length);
    for (const name of sources.rustPubMods.get(file) ?? []) {
      const child = [`${childDir}/${name}.rs`, `${childDir}/${name}/mod.rs`].find((candidate) => sources.files.has(candidate));
      if (child && !reached.has(child)) {
        reached.add(child);
        queue.push(child);
      }
    }
  }
  return [...reached];
}

// ---------------------------------------------------------------------------------------------------------------
// Text readers

const RUST_ENTRY_ATTRIBUTE = /^\s*#\[(?:unsafe\()?(test|bench|no_mangle|export_name|proc_macro_derive|proc_macro_attribute|proc_macro)\b/;
const RUST_FN = /\bfn\s+([A-Za-z_]\w*)/;

/** Functions marked by an attribute a runtime or the compiler calls them through. */
export function rustAttributedFunctions(content: string): Array<{ name: string; attribute: string }> {
  const found: Array<{ name: string; attribute: string }> = [];
  let pending: string | undefined;
  for (const line of content.split("\n")) {
    const attribute = RUST_ENTRY_ATTRIBUTE.exec(line);
    if (attribute) {
      pending = attribute[1];
      continue;
    }
    if (!pending || /^\s*(#\[|\/\/|$)/.test(line)) continue;
    const fn = RUST_FN.exec(line);
    if (fn) found.push({ name: fn[1], attribute: pending });
    pending = undefined;
  }
  return found;
}

/** The modules a Rust file declares public: `pub mod name;` (not `pub(crate)`, not inline). */
export function rustPublicModules(content: string): string[] {
  return [...content.matchAll(/^[ \t]*pub[ \t]+mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm)].map((match) => match[1]);
}

/** The names of `__all__ = [...]` (or `+=`, tuples) in a Python module. */
export function pythonAllNames(content: string): string[] {
  const names: string[] = [];
  for (const block of content.matchAll(/^__all__[ \t]*\+?=[ \t]*[[(]([^\])]*)[\])]/gm)) {
    for (const item of block[1].matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)) names.push(item[1] ?? item[2]);
  }
  return names;
}

interface TomlTable {
  /** Dotted header with quotes removed (`project.entry-points.flask.commands` for `[project.entry-points."flask.commands"]`) */
  name: string;
  /** Its `key = "string"` pairs */
  values: Map<string, string>;
}

/**
 * shortcut: reads `[table]` / `[[array]]` headers and `key = "string"` pairs only (inline tables, arrays and
 * multi-line strings are skipped); add a TOML parser dependency if a manifest needs more. Undefined on a broken header.
 */
function readToml(text: string): TomlTable[] | undefined {
  const tables: TomlTable[] = [{ name: "", values: new Map() }];
  // Lines inside a multi-line array, inline table or string are values, never headers.
  let depth = 0;
  let inMultilineString = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if ((line.match(/"""|'''/g)?.length ?? 0) % 2 === 1) inMultilineString = !inMultilineString;
    if (inMultilineString || line.includes('"""') || line.includes("'''")) continue;
    if (depth > 0) {
      depth = Math.max(0, depth + bracketBalance(line));
      continue;
    }
    if (line.startsWith("[")) {
      const header = /^\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
      if (!header) return undefined;
      tables.push({ name: tomlKey(header[1]), values: new Map() });
      continue;
    }
    const pair = tomlStringPair(line);
    if (pair) tables.at(-1)?.values.set(pair.key, pair.value);
    else depth = Math.max(0, bracketBalance(line));
  }
  return tables;
}

/** `key = "value"` (or single quotes, a trailing comment allowed), else undefined. */
function tomlStringPair(line: string): { key: string; value: string } | undefined {
  const eq = /^("[^"]*"|'[^']*'|[\w.-]+)\s*=\s*/.exec(line);
  if (!eq) return undefined;
  const value = /^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line.slice(eq[0].length));
  return value ? { key: tomlKey(eq[1]), value: value[1] ?? value[2] } : undefined;
}

/** Opening minus closing brackets and braces, quoted strings and comments aside. */
function bracketBalance(line: string): number {
  const unquoted = line.replaceAll(/"[^"]*"|'[^']*'/g, "");
  const hash = unquoted.indexOf("#");
  const code = hash < 0 ? unquoted : unquoted.slice(0, hash);
  return (code.match(/[[{]/g)?.length ?? 0) - (code.match(/[\]}]/g)?.length ?? 0);
}

function tomlKey(key: string): string {
  const parts = key.trim().match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? [];
  return parts.map((part) => part.replaceAll(/^["']|["']$/g, "")).join(".");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
