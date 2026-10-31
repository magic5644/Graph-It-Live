import path from 'node:path';
import { importBindings, type ImportBinding } from './namespaceUsage';

/*
 * Python and Rust imports and re-exports, for following barrels (#521). A linear scan of the file text rather
 * than the tree-sitter analyzers: barrel lookups read many referencers synchronously from their content, and a
 * WASM parse per referencer would cost far more. String literals and comments are blanked first, so text inside
 * them (docstrings, fixtures, commented-out code) never counts as an import.
 */

/** Same shape as `ModuleReExports` in reExports.ts (structural, so the two modules do not import each other). */
export interface PyRsReExports {
  reExports: Array<{ specifier: string; names: 'all' | Array<{ imported: string; exported: string }> }>;
  /** A re-exported name that may be a submodule (`from . import impl`, `pub use inner::imp`), under `alias`. */
  namespaces: Array<{ specifier: string; alias: string }>;
  /** Python `__all__`: the names `from m import *` takes from this module (absent: every public name). */
  starNames?: string[];
}

/** Whether `from m import *` takes `name`: listed in `__all__`, or public (no leading `_`) without one. */
export function pythonStarExports(name: string, starNames: string[] | undefined): boolean {
  return starNames ? starNames.includes(name) : !name.startsWith('_');
}

/** Whether `filePath` is a Python or Rust module, whose re-exports are imports (`from .m import x`, `pub use m::x`). */
export function isPythonOrRust(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.py' || ext === '.rs';
}

/** Import bindings of a module in any supported language: Python and Rust here, JS/TS through `importBindings`. */
export function readImportBindings(filePath: string, content: string): ImportBinding[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') return pythonImportBindings(content);
  if (ext === '.rs') return rustImportBindings(content);
  return importBindings(filePath, content);
}

/** Python or Rust re-exports; callers pick JS/TS parsing for any other file. */
export function pyRsReExports(filePath: string, content: string): PyRsReExports {
  return path.extname(filePath).toLowerCase() === '.py' ? pythonReExports(content) : rustReExports(content);
}

/**
 * Whether a namespace re-export `specifier` names `modulePath` itself. Rust resolves `inner::one` to the longest
 * module prefix (`inner/mod.rs` when `one` is an item), so the last segment must be the module's own name.
 */
export function namesModule(specifier: string, modulePath: string): boolean {
  if (path.extname(modulePath).toLowerCase() !== '.rs') return true;
  const base = path.basename(modulePath, '.rs');
  const name = ['mod', 'lib', 'main'].includes(base) ? path.basename(path.dirname(modulePath)) : base;
  return specifier.split('::').pop() === name;
}

// ─── Literal blanking ───────────────────────────────────────────────────────

/** `content` with each span `literalEnd` reports (comment or string) replaced by spaces, newlines kept. */
function blankLiterals(content: string, literalEnd: (text: string, at: number) => number): string {
  const out: string[] = [];
  let last = 0;
  let i = 0;
  while (i < content.length) {
    const end = literalEnd(content, i);
    if (end === i) {
      i++;
    } else {
      out.push(content.slice(last, i), content.slice(i, end).replaceAll(/[^\n]/g, ' '));
      last = end;
      i = end;
    }
  }
  out.push(content.slice(last));
  return out.join('');
}

/** Index after the string opened by `quote` at `start`, escapes skipped; a one-line string also stops at a newline. */
function stringEnd(text: string, start: number, quote: string, multiline: boolean): number {
  let i = start + quote.length;
  while (i < text.length) {
    if (text.startsWith(quote, i)) return i + quote.length;
    if (!multiline && text[i] === '\n') return i;
    i += text[i] === '\\' ? 2 : 1;
  }
  return text.length;
}

export function lineEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline < 0 ? text.length : newline;
}

// ─── Python ─────────────────────────────────────────────────────────────────

/** End of the `#` comment or `'…'`/`"…"`/`'''…'''`/`"""…"""` string at `i`, or `i` when none starts there. */
function pythonLiteralEnd(text: string, i: number): number {
  const c = text[i];
  if (c === '#') return lineEnd(text, i);
  if (c !== '"' && c !== "'") return i;
  const triple = c.repeat(3);
  return text.startsWith(triple, i) ? stringEnd(text, i, triple, true) : stringEnd(text, i, c, false);
}

/** `from m import a, b as c` / `from m import (…)` / `from m import *`, indented too (`try:` blocks). */
const PY_FROM_IMPORT = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]*(\([^)]{0,4000}\)|[^\n]*)/gm;
/** `import a.b, c as d`. */
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n]+)/gm;

/**
 * Code with strings and comments blanked. Backslash continuations are joined into one line, or, with `keepLines`,
 * only their backslash is blanked, so line numbers still match the file.
 */
export function pythonCode(content: string, keepLines = false): string {
  const code = blankLiterals(content, pythonLiteralEnd);
  return keepLines ? code.replaceAll(/\\(?=\r?\n)/g, ' ') : code.replaceAll(/\\\r?\n/g, ' ');
}

interface ImportedName {
  imported: string;
  local: string;
}

/** `__all__ = [...]`, `__all__: list[str] = (...)`, `__all__ += [...]`, matched on code (strings blanked). */
const PY_ALL = /^__all__[ \t]*(?::[^=\n]*)?\+?=[ \t]*[[(]/gm;
/** A quoted name in the original text of an `__all__` list. */
const PY_QUOTED_NAME = /(['"])(\w+)\1/g;

/**
 * Names listed in `__all__` (every assignment and `+=` merged), or undefined when the module has none.
 * shortcut: a computed `__all__` (`[*a.__all__, 'x']`, `list(...)`) keeps only its literal names.
 */
function pythonAllNames(content: string): string[] | undefined {
  // Blanking keeps offsets, so brackets found in code index the original text.
  const code = blankLiterals(content, pythonLiteralEnd);
  const lists = [...code.matchAll(PY_ALL)].map((match) => {
    const start = match.index + match[0].length;
    const close = code.slice(start).search(/[\])]/);
    const list = content.slice(start, close < 0 ? content.length : start + close);
    return [...list.matchAll(PY_QUOTED_NAME)].map(([, , name]) => name);
  });
  return lists.length > 0 ? [...new Set(lists.flat())] : undefined;
}

function pythonFromImports(code: string): Array<{ module: string; names: 'all' | ImportedName[] }> {
  return [...code.matchAll(PY_FROM_IMPORT)].map(([, module, list]) => {
    const names = list.replaceAll(/[()]/g, ' ').trim();
    if (names === '*') return { module, names: 'all' as const };
    return { module, names: names.split(',').flatMap(aliasedName) };
  });
}

/** `a` or `a as b`; an empty part (trailing comma) is none. */
function aliasedName(part: string): ImportedName[] {
  const [imported, local] = splitAlias(part);
  return imported ? [{ imported, local: local ?? imported }] : [];
}

/** `path as alias` split on whitespace tokens (no backtracking regex); `[path]` without `as`. */
function splitAlias(text: string): [string, string | undefined] {
  const tokens = text.trim().split(/\s+/);
  const as = tokens.lastIndexOf('as');
  return as > 0 ? [tokens.slice(0, as).join(''), tokens[as + 1]] : [tokens.join(''), undefined];
}

/** `from . import impl` names the submodule `.impl`; `from pkg import x` may name `pkg.x`. */
function pythonSubmodule(module: string, name: string): string {
  return module.endsWith('.') ? module + name : `${module}.${name}`;
}

/**
 * In Python every imported name is an attribute of the importing module, so each `from m import x` re-exports
 * `x`; when `x` is a submodule it is a namespace over that module (unresolved candidates are dropped later).
 */
export function pythonReExports(content: string): PyRsReExports {
  const fromImports = pythonFromImports(pythonCode(content));
  const starNames = pythonAllNames(content);
  return {
    ...(starNames ? { starNames } : {}),
    reExports: fromImports.map(({ module, names }) => ({
      specifier: module,
      names: names === 'all' ? 'all' : names.map(({ imported, local }) => ({ imported, exported: local })),
    })),
    namespaces: fromImports.flatMap(({ module, names }) =>
      names === 'all' ? [] : names.map(({ imported, local }) => ({ specifier: pythonSubmodule(module, imported), alias: local }))
    ),
  };
}

/** `from m import x [as y]` binds `x` from `m`; `from m import *` and `import m [as n]` the whole module. */
export function pythonImportBindings(content: string): ImportBinding[] {
  const code = pythonCode(content);
  const fromImports = pythonFromImports(code).flatMap(({ module, names }) =>
    names === 'all'
      ? [{ specifier: module, imported: '*', local: '*' }]
      : names.map(({ imported, local }) => ({ specifier: module, imported, local }))
  );
  const moduleImports = [...code.matchAll(PY_IMPORT)].flatMap(([, list]) =>
    list.split(',').flatMap(aliasedName).map(({ imported, local }) => ({
      specifier: imported,
      imported: '*',
      // `import a.b` binds `a`.
      local: local === imported ? imported.split('.')[0] : local,
    }))
  );
  return [...fromImports, ...moduleImports];
}

// ─── Rust ───────────────────────────────────────────────────────────────────

/** End of the comment, string, raw string or char literal at `i`, or `i` when none starts there (lifetimes are code). */
function rustLiteralEnd(text: string, i: number): number {
  if (text.startsWith('//', i)) return lineEnd(text, i);
  if (text.startsWith('/*', i)) return blockCommentEnd(text, i);
  if (text[i] === '"') return stringEnd(text, i, '"', true);
  if (text[i] === "'") return charEnd(text, i);
  return rawStringEnd(text, i);
}

/** Block comments nest in Rust. */
function blockCommentEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (text.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return text.length;
}

/** `'x'` or `'\n'`; a lifetime (`'a`) is not a literal. */
function charEnd(text: string, i: number): number {
  if (text[i + 1] === '\\') return Math.max(text.indexOf("'", i + 3) + 1, i + 1);
  return text[i + 2] === "'" ? i + 3 : i;
}

/** `r"…"`, `r#"…"#`, `br"…"` at `i` (not inside an identifier, so `r#type` stays code). */
function rawStringEnd(text: string, i: number): number {
  if ((text[i] !== 'r' && text[i] !== 'b') || (i > 0 && /\w/.test(text[i - 1]))) return i;
  const open = /^b?r(#*)"/.exec(text.slice(i, i + 260));
  if (!open) return i;
  const close = `"${open[1]}`;
  const end = text.indexOf(close, i + open[0].length);
  return end < 0 ? text.length : end + close.length;
}

/** Start of a `use` declaration; the tree runs to the next `;`, found with indexOf (no backtracking). */
const RS_USE_KEYWORD = /\buse\s/g;
/** Lowercase-led paths with `::` in code (`inner::one()`); types (`Vec::new`) start uppercase. */
const RS_PATH = /\b[a-z_][\w:]*/g;

interface RustUseItem {
  /** Module path before the name, e.g. `self::imp`. */
  specifier: string;
  /** Last segment: an item, `*` or `self`. */
  name: string;
  alias?: string;
}

interface RustUseSpan {
  start: number;
  /** Index of the closing `;`. */
  end: number;
  tree: string;
  isPub: boolean;
}

/** Every `[pub[(…)]] use tree;` of the (literal-blanked) code. */
function rustUseSpans(code: string): RustUseSpan[] {
  const spans: RustUseSpan[] = [];
  for (const match of code.matchAll(RS_USE_KEYWORD)) {
    const end = code.indexOf(';', match.index);
    if (end < 0) break;
    spans.push({ start: match.index, end, tree: code.slice(match.index + 4, end), isPub: precededByPub(code, match.index) });
  }
  return spans;
}

/** Whether `pub`, `pub(crate)`, `pub(in path)`… sits right before index `at`. */
function precededByPub(code: string, at: number): boolean {
  let before = code.slice(Math.max(0, at - 80), at).trimEnd();
  if (before.endsWith(')')) before = before.slice(0, before.lastIndexOf('(')).trimEnd();
  return /\bpub$/.test(before);
}

function rustUses(code: string): Array<RustUseItem & { isPub: boolean }> {
  return rustUseSpans(code).flatMap(({ tree, isPub }) => expandUseTree(tree, []).map((item) => ({ ...item, isPub })));
}

/** `code` with every `use` declaration blanked, so its paths are not read again as expression paths. */
function withoutUses(code: string): string {
  let out = code;
  for (const { start, end } of rustUseSpans(code)) {
    out = out.slice(0, start) + ' '.repeat(end + 1 - start) + out.slice(end + 1);
  }
  return out;
}

/** Flattens `a::{b, c::{d as e, *}}` into one item per leaf. */
export function expandUseTree(tree: string, prefix: string[]): RustUseItem[] {
  const text = tree.trim();
  const brace = text.indexOf('{');
  if (brace >= 0 && text.endsWith('}')) {
    const base = [...prefix, ...rustSegments(text.slice(0, brace))];
    return splitTopLevel(text.slice(brace + 1, -1)).flatMap((part) => expandUseTree(part, base));
  }
  const [pathText, alias] = splitAlias(text);
  const segments = [...prefix, ...rustSegments(pathText)];
  const name = segments.pop();
  if (!name || segments.length === 0) return [];
  return [{ specifier: segments.join('::'), name, ...(alias ? { alias } : {}) }];
}

/** Path segments, raw identifiers unwrapped (`r#type` is `type`). */
function rustSegments(text: string): string[] {
  return text
    .split('::')
    .map((segment) => segment.trim().replace(/^r#/, ''))
    .filter(Boolean);
}

/** Splits on the commas outside braces. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim());
}

/**
 * `pub use m::x [as y]` and `pub use m::*` re-export names; `pub use m::x` and `pub use m::{self}` may also
 * re-export the module `m::x` / `m` itself, as a namespace (an item there fails `namesModule`).
 */
export function rustReExports(content: string): PyRsReExports {
  const uses = rustUses(blankLiterals(content, rustLiteralEnd)).filter(({ isPub }) => isPub);
  return {
    reExports: uses
      .filter(({ name }) => name !== 'self')
      .map(({ specifier, name, alias }) => ({
        specifier,
        names: name === '*' ? 'all' : [{ imported: name, exported: alias ?? name }],
      })),
    namespaces: uses
      .filter(({ name }) => name !== '*')
      .map(({ specifier, name, alias }) => {
        const module = name === 'self' ? specifier : `${specifier}::${name}`;
        return { specifier: module, alias: alias ?? module.split('::').pop() ?? name };
      }),
  };
}

/** Module paths of the file's glob imports (`use super::*;` gives `super`): they bring child modules into scope. */
export function rustGlobPrefixes(content: string): string[] {
  return rustUses(blankLiterals(content, rustLiteralEnd))
    .filter(({ name }) => name === '*')
    .map(({ specifier }) => specifier);
}

const RS_RELATIVE = /^(?:crate|self|super)::/;

/**
 * Every `use` (public or not): `use m::x` binds `x` from `m`; `use m::*` and `use m::{self}` the whole module.
 * A qualified path in code (`m::x()`) binds `x` from `m` too, and from `g::m` for each glob import `g::*` that
 * may bring `m` into scope; paths that name no local module never resolve.
 */
export function rustImportBindings(content: string): ImportBinding[] {
  const code = blankLiterals(content, rustLiteralEnd);
  const uses = rustUses(code);
  const globs = uses.filter(({ name }) => name === '*').map(({ specifier }) => specifier);
  const bindings = uses.map(({ specifier, name, alias }) => {
    const whole = name === '*' || name === 'self';
    return { specifier, imported: whole ? '*' : name, local: alias ?? name };
  });
  // Paths inside `use` are already bindings above.
  const qualified = [...withoutUses(code).matchAll(RS_PATH)].flatMap(([token]) => {
    const segments = rustSegments(token);
    const name = segments.pop();
    if (!name || segments.length === 0) return [];
    const specifier = segments.join('::');
    const scopes = RS_RELATIVE.test(token) ? [specifier] : [specifier, ...globs.map((glob) => `${glob}::${specifier}`)];
    return scopes.map((scope) => ({ specifier: scope, imported: name, local: name }));
  });
  return [...bindings, ...qualified];
}
