/**
 * How sure the dead-code scan is that an unused export is really dead (#690, #695), from data the
 * scan already has: the importers of the file, whether only tests use the export, and the modules
 * the workspace loads by computed path. Pure functions; no parse.
 */
import path from "node:path";
import type { SymbolInfo } from "../types";
import { normalizePath } from "../../shared/path";
import { maskNonCode } from "../utils/maskNonCode";

export type DeadCodeConfidence = "high" | "medium" | "low";

/**
 * - `no-importer`: no workspace file imports the file (directly or through a barrel): an entry point by convention, a
 *   script or a config file as often as dead code. `low`.
 * - `test-only-use`: only test files use the export. `medium`.
 * - `dynamic-import-in-workspace`: the workspace loads modules by computed path that may reach the file. `medium`.
 * - `convention:decorated`: a decorator may register the definition by reference (`@app.route`, `@click.command`,
 *   `@pytest.fixture`), which no import shows. `medium`.
 * - `named-in-own-file`: the name is written again in its own file (comments aside): code of the file may use it,
 *   so deleting it may break the file; dropping the `export` keyword may be the fix. `medium`.
 * - `name-written-elsewhere`: Rust only, another Rust file writes the export's name; the Rust analysis does not
 *   follow type uses, `Type::new()` or nested grouped `use`, so it may be used. `medium`.
 * - `convention:test-file`: the file is a test file or lives in a test folder, where fixtures hold unused code by
 *   design and a runner loads files by name. `medium`.
 * - `importers-use-other-exports`: the file has importers and none uses the export. `high`.
 */
export type DeadCodeReason =
  | "no-importer"
  | "test-only-use"
  | "dynamic-import-in-workspace"
  | "convention:decorated"
  | "named-in-own-file"
  | "name-written-elsewhere"
  | "convention:test-file"
  | "importers-use-other-exports";

export const DEAD_CODE_CONFIDENCES = ["high", "medium", "low"] as const satisfies readonly DeadCodeConfidence[];

/** Importers listed as evidence; `importers` keeps the full count. */
export const EVIDENCE_PATHS = 3;

export interface DeadCodeEvidence {
  /** Workspace files that import the file (directly or through a barrel), test files included */
  importers: number;
  /** The first of them, workspace-relative */
  firstImporters: string[];
  /** Computed loads that may reach the file: `relative/file:line` */
  dynamicLoads?: string[];
}

/** An unused export with how sure the scan is, and why. */
export interface UnusedSymbol extends SymbolInfo {
  confidence: DeadCodeConfidence;
  reasons: DeadCodeReason[];
  evidence: DeadCodeEvidence;
}

const RANK: Readonly<Record<DeadCodeConfidence, number>> = { low: 0, medium: 1, high: 2 };

export function meetsConfidence(confidence: DeadCodeConfidence, min: DeadCodeConfidence): boolean {
  return RANK[confidence] >= RANK[min];
}

export function countByConfidence(items: readonly { confidence: DeadCodeConfidence }[]): Record<DeadCodeConfidence, number> {
  const counts: Record<DeadCodeConfidence, number> = { high: 0, medium: 0, low: 0 };
  for (const item of items) counts[item.confidence]++;
  return counts;
}

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "e2e"]);
const TEST_FILE = /(?:\.(?:test|spec)\.[^/.]+|^test_[^/]*\.py|_test\.py|^conftest\.py)$/;

/** Test files and the files of test folders (a workspace-relative path with `/`). */
export function isTestFile(relativePath: string): boolean {
  const segments = normalizePath(relativePath).split("/");
  const name = segments.pop() ?? "";
  return TEST_FILE.test(name) || segments.some((segment) => TEST_DIRS.has(segment));
}

export interface ConfidenceInput {
  /** Workspace-relative importers of the file, the barrels that only re-export the symbol excluded */
  importers: readonly string[];
  /** Tests use the export and nothing else does */
  testOnlyUse: boolean;
  /** Computed loads that may reach the file */
  dynamicLoads: readonly string[];
  /** The file is a test file (isTestFile) */
  testFile: boolean;
  /** A decorator may register the definition by reference */
  decorated?: boolean;
  /** Rust: another Rust file writes the export's name */
  nameWrittenElsewhere?: boolean;
  /** The name is written again in its own file */
  namedInOwnFile?: boolean;
}

export function classifyUnused(input: ConfidenceInput): Pick<UnusedSymbol, "confidence" | "reasons" | "evidence"> {
  const evidence: DeadCodeEvidence = {
    importers: input.importers.length,
    firstImporters: input.importers.slice(0, EVIDENCE_PATHS),
    ...(input.dynamicLoads.length > 0 ? { dynamicLoads: input.dynamicLoads.slice(0, EVIDENCE_PATHS) } : {}),
  };
  const reasons: DeadCodeReason[] = [];
  if (input.testOnlyUse) reasons.push("test-only-use");
  if (input.dynamicLoads.length > 0) reasons.push("dynamic-import-in-workspace");
  if (input.decorated) reasons.push("convention:decorated");
  if (input.namedInOwnFile) reasons.push("named-in-own-file");
  if (input.nameWrittenElsewhere) reasons.push("name-written-elsewhere");
  if (input.testFile) reasons.push("convention:test-file");
  if (input.importers.length === 0) return { confidence: "low", reasons: ["no-importer", ...reasons], evidence };
  if (reasons.length > 0) return { confidence: "medium", reasons, evidence };
  return { confidence: "high", reasons: ["importers-use-other-exports"], evidence };
}

// ---------------------------------------------------------------------------
// Computed module loads
// ---------------------------------------------------------------------------

/**
 * A module loaded by computed path. `scope` is the absolute normalized directory whose files it may reach: the
 * static prefix of the specifier when it has a relative one, the workspace for a bare or aliased prefix, else
 * (fully computed) the caller's own directory.
 * `pathFragment` is set instead for a Python dotted prefix (`pkg.plugins.` + name reaches `pkg/plugins/`).
 * shortcut: a fully computed specifier (`require(name)`) is bounded to the caller's directory tree, where
 * loaders find their plugins; a loader reaching elsewhere by a path built at run time is missed. Upgrade if the
 * precision audit (#698) finds one.
 */
export interface DynamicLoad {
  /** `relative/file:line` of the call */
  at: string;
  scope?: string;
  pathFragment?: string;
}

/** `import(` / `require(` not preceded by `.` or a word character. */
const JS_LOAD = /(?<![\w$.])(?:import|require)\s*\(\s*/g;
/** `importlib.import_module(`, `import_module(`, `__import__(`. */
const PY_LOAD = /(?<![\w.])(?:importlib\s*\.\s*)?(?:import_module|__import__)\s*\(\s*/g;
const PY_FILE = /\.pyi?$/i;
const NON_FILE_URL = /^(?!file:)[a-z][a-z\d+.-]+:/i;

/** Static prefix of the specifier that starts at `from`, null when fully computed, undefined when fully static. */
function jsPrefix(content: string, from: number): string | null | undefined {
  const quote = content[from];
  if (quote === "`") {
    const end = content.indexOf("`", from + 1);
    const body = content.slice(from + 1, end === -1 ? undefined : end);
    const hole = body.indexOf("${");
    return hole === -1 ? undefined : body.slice(0, hole);
  }
  if (quote === "'" || quote === '"') {
    const end = content.indexOf(quote, from + 1);
    if (end === -1) return undefined;
    // `'./x/' + name` is computed after a static prefix; `'./x')` is a plain static load.
    return /^\s*\+/.test(content.slice(end + 1, end + 40)) ? content.slice(from + 1, end) : undefined;
  }
  return null;
}

/** Static prefix of a Python module name that starts at `from`, as for jsPrefix. */
function pyPrefix(content: string, from: number): string | null | undefined {
  const fString = /^[fF]['"]/.test(content.slice(from, from + 2));
  const start = fString ? from + 1 : from;
  const quote = content[start];
  if (quote !== "'" && quote !== '"') return null;
  const end = content.indexOf(quote, start + 1);
  if (end === -1) return undefined;
  const body = content.slice(start + 1, end);
  if (fString) {
    const hole = body.indexOf("{");
    return hole === -1 ? undefined : body.slice(0, hole);
  }
  return /^\s*\+/.test(content.slice(end + 1, end + 40)) ? body : undefined;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < index; i = content.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * Python source with `#` comments blanked (same length). A `#` inside a one-line string is kept.
 * shortcut: a `#` in a triple-quoted string spanning lines blanks the rest of its line; upgrade with a tokenizer.
 */
function maskPythonComments(content: string): string {
  return content.split("\n").map((line) => {
    let quote = "";
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (quote && ch === "\\") i++; // the escaped character cannot close the string
      else if (quote && ch === quote) quote = "";
      else if (!quote && (ch === "'" || ch === '"')) quote = ch;
      else if (!quote && ch === "#") return line.slice(0, i) + " ".repeat(line.length - i);
      i++;
    }
    return line;
  }).join("\n");
}

/**
 * The computed loads of one file. A fully static load is in the import graph already and is not returned.
 * Calls in comments (and, for JS/TS, in string or template text) are skipped.
 */
export function findDynamicLoads(filePath: string, relativePath: string, content: string, rootDir: string): DynamicLoad[] {
  const python = PY_FILE.test(filePath);
  const pattern = python ? PY_LOAD : JS_LOAD;
  const code = python ? maskPythonComments(content) : maskNonCode(content);
  const loads: DynamicLoad[] = [];
  for (const match of code.matchAll(pattern)) {
    const from = match.index + match[0].length;
    const prefix = python ? pyPrefix(content, from) : jsPrefix(content, from);
    // A URL other than file: (`data:`, `node:`, `https:`) loads nothing from the workspace.
    if (prefix === undefined || (!python && prefix !== null && NON_FILE_URL.test(prefix))) continue;
    const at = `${relativePath}:${lineAt(content, match.index)}`;
    loads.push({ at, ...loadReach(prefix, python, path.dirname(filePath), rootDir) });
  }
  return loads;
}

/** What a computed load with this static prefix (null: none) may reach. */
function loadReach(prefix: string | null, python: boolean, dir: string, rootDir: string): Omit<DynamicLoad, "at"> {
  if (python && prefix) {
    // `pkg.plugins.` + name reaches pkg/plugins/; `pkg.plug` + name anything under pkg/.
    let fragment = prefix.slice(0, prefix.lastIndexOf(".") + 1).replaceAll(".", "/");
    while (fragment.endsWith("/")) fragment = fragment.slice(0, -1);
    return fragment && !fragment.startsWith("/") ? { pathFragment: fragment } : { scope: normalizePath(rootDir) };
  }
  if (prefix?.startsWith(".")) return { scope: normalizePath(path.resolve(dir, prefix.slice(0, prefix.lastIndexOf("/") + 1) || ".")) };
  // A bare or aliased prefix (`@/plugins/${n}`, `'plugins/' + n`) may name any folder: the whole workspace.
  return { scope: normalizePath(prefix ? rootDir : dir) };
}

/** The loads that may reach `filePath` (absolute normalized). */
export function loadsReaching(filePath: string, loads: readonly DynamicLoad[]): string[] {
  return loads
    .filter((load) =>
      load.scope === undefined
        ? (load.pathFragment !== undefined && `/${filePath}`.includes(`/${load.pathFragment}/`))
        : filePath.startsWith(`${load.scope.replace(/\/$/, "")}/`))
    .map((load) => load.at);
}

/** Cheap pre-check before matching: most files load nothing by computed path. */
export function mayLoadDynamically(content: string): boolean {
  return /\b(?:import|require|import_module|__import__)\s*\(/.test(content);
}

/**
 * The text of a file in which to count names: comments (and JS/TS string text) blanked. Vue and other files stay
 * raw, as a template is not script: a name in text counts, which only keeps more exports.
 */
export function codeForNames(filePath: string, content: string): string {
  if (PY_FILE.test(filePath)) return maskPythonComments(content);
  return /\.[cm]?[jt]sx?$/i.test(filePath) ? maskNonCode(content) : content;
}

/** Whether `name` (an identifier) is written more than once in `code`: its declaration and another use. */
export function namedAgain(code: string, name: string): boolean {
  const escaped = name.replaceAll("$", String.raw`\$`);
  const uses = new RegExp(String.raw`(?<![\w$])${escaped}(?![\w$])`, "g");
  let count = 0;
  while (uses.exec(code) !== null) {
    if (++count === 2) return true;
  }
  return false;
}

/** Every `qualifier::name` pair of a Rust source (`a::b::c` gives `a::b` and `b::c`), comments included. */
export function rustQualifiedPaths(content: string): string[] {
  const pairs = new Set<string>();
  for (const match of content.matchAll(/\b([A-Za-z_]\w*)\s*::\s*(?=([A-Za-z_]\w*))/g)) pairs.add(`${match[1]}::${match[2]}`);
  return [...pairs];
}

/**
 * Whether a Rust export `name` of `filePath` is reached by a qualified path somewhere: `module::name` with the file's
 * module name, a module declared inline in the file, `super::` (from a child module) or, for a crate root, `crate::`.
 * A path the analyzer cannot tie to a file still keeps the export.
 * shortcut: another module with the same name and item hides a dead item; precision first.
 */
export function rustQualifiedUse(filePath: string, content: string, name: string, paths: ReadonlySet<string>): boolean {
  const base = path.basename(filePath, path.extname(filePath));
  const moduleName = base === "mod" ? path.basename(path.dirname(filePath)) : base;
  const crateRoot = base === "lib" || base === "main";
  const qualifiers = ["super", ...(crateRoot ? ["crate"] : []), moduleName, ...[...content.matchAll(/\bmod\s+([A-Za-z_]\w*)\s*\{/g)].map((m) => m[1])];
  return qualifiers.some((qualifier) => paths.has(`${qualifier}::${name}`));
}

/**
 * Whether a Python file reads an attribute by computed name (`getattr(mod, name)`) on anything but `self` / `cls`:
 * any module it imports may then have every export used.
 * shortcut: any receiver counts, not only an imported module; upgrade if it lowers too many items.
 */
export function readsComputedAttribute(content: string): boolean {
  for (const match of content.matchAll(/\bgetattr\s*\(\s*([A-Za-z_][\w.]*)\s*,\s*(?![\s'"])/g)) {
    if (match[1] !== "self" && match[1] !== "cls") return true;
  }
  return false;
}
