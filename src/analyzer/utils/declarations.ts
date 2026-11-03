import fs from "node:fs/promises";
import { ts } from "ts-morph";
import { normalizePath } from "@/shared/path";
import { isInIgnoredDirectory } from "./PathPredicates";
import type { PathResolver } from "./PathResolver";
import { declaresExport, exportsOnlyAsDefault, mayReExport, parseReExports, type ReExport, type ReExportTarget } from "./reExports";

/** `findDeclaration` result for a module that exports `name` only as the local name of its default export. */
export const DEFAULT_ONLY = "default-only";

/** Module contents read during one resolution, by normalized path; its keys are the files the result depends on. */
export type DeclarationReads = Map<string, Promise<string | null>>;

/** React wrappers whose first argument is the component itself: `memo(Card)`, `React.forwardRef(function Card() {})`. */
const COMPONENT_WRAPPER = /^(?:React\.)?(?:memo|forwardRef)$/;
/** Wrappers that make a component out of a declaration initializer; `lazy` loads it from another module. */
const COMPONENT_FACTORY = /^(?:React\.)?(?:memo|forwardRef|lazy)$/;

/** Whether `callee` (the source text of a call's function) is `memo`, `forwardRef` or `lazy`, bare or as `React.*`. */
export function isComponentFactory(callee: string): boolean {
  return COMPONENT_FACTORY.test(callee);
}

/** `x`, `(x)`, `x as T`, `x satisfies T` and `x!` all evaluate to `x`. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The identifier a default export evaluates to, through `memo(...)`/`forwardRef(...)` wrappers; undefined otherwise. */
function exportedIdentifier(node: ts.Expression): string | undefined {
  const value = unwrapExpression(node);
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isCallExpression(value) && COMPONENT_WRAPPER.test(value.expression.getText()) && value.arguments[0]) {
    return exportedIdentifier(value.arguments[0]);
  }
  return undefined;
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  return (ts.getModifiers(statement as ts.HasModifiers) ?? []).some((modifier) => modifier.kind === kind);
}

/** Names of the module's top-level function, class and variable declarations. */
function topLevelNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

const MAY_EXPORT_DEFAULT = /\bexport\s+default\b|\bas\s+default\b/;

/**
 * The declared name of the module's default export: `export default function Panel`, `export default Panel`,
 * `export default memo(Panel)` or `export { Panel as default }` of a top-level declaration. Undefined for an
 * anonymous default (`export default () => null`), an unknown wrapper, a re-export or a module without one.
 */
export function defaultExportName(filePath: string, content: string): string | undefined {
  if (!MAY_EXPORT_DEFAULT.test(content)) return undefined;
  return defaultExportNameOf(ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true));
}

/** `defaultExportName` of an already parsed module (parent pointers set). */
export function defaultExportNameOf(sourceFile: ts.SourceFile): string | undefined {
  const local = topLevelNames(sourceFile);
  const declared = (name: string | undefined) => (name && local.has(name) ? name : undefined);
  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      return statement.name?.text;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return declared(exportedIdentifier(statement.expression));
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const element = statement.exportClause.elements.find((entry) => entry.name.text === "default");
      if (element) return declared((element.propertyName ?? element.name).text);
    }
  }
  return undefined;
}

/** The name a re-export declaration reaches `name` under in its source module, if any. */
function reExportedAs(names: ReExport["names"], name: string): string | undefined {
  // `export *` never re-exports `default`.
  if (names === "all") return name === "default" ? undefined : name;
  return names.find((entry) => entry.exported === name)?.imported;
}

function readModule(filePath: string, reads: DeclarationReads): Promise<string | null> {
  const key = normalizePath(filePath);
  let content = reads.get(key);
  if (!content) {
    content = fs.readFile(filePath, "utf-8").catch(() => null);
    reads.set(key, content);
  }
  return content;
}

/**
 * Follows `name` through barrels (`export { x } from`, `export * from`) to the module that declares it, and a
 * `default` export to its declared name (`export default function Panel` → `Panel`), so a use through a barrel or
 * a default import links to the real symbol. A module without re-exports imported directly is returned as is. Null when
 * no module of a re-export chain declares `name`: the caller keeps the imported module as target. `DEFAULT_ONLY` when the module itself exports `name` only as its default export's local name.
 * `reads` caches module contents for one resolution pass; its keys are the files the result was read from.
 */
export async function findDeclaration(
  filePath: string,
  name: string,
  resolver: PathResolver,
  reads: DeclarationReads,
  visited: Set<string> = new Set(),
  direct = true,
): Promise<ReExportTarget | typeof DEFAULT_ONLY | null> {
  const normalized = normalizePath(filePath);
  const key = `${normalized}:${name}`;
  if (visited.has(key) || isInIgnoredDirectory(normalized)) return null;
  visited.add(key);
  const content = await readModule(filePath, reads);
  if (content === null) return null;
  if (name === "default") {
    const declared = defaultExportName(filePath, content);
    if (declared) return { filePath: normalized, name: declared };
  }
  const onlyDefault = () => exportsOnlyAsDefault(filePath, content, name);
  if (!mayReExport(content)) {
    // A module imported directly is taken at its word, unparsed; behind `export *` it must declare `name`,
    // otherwise the next `export *` module is tried.
    if (!direct && !declaresExport(filePath, content, name)) return null;
    return onlyDefault() ? DEFAULT_ONLY : { filePath: normalized, name };
  }
  if (declaresExport(filePath, content, name)) return { filePath: normalized, name };
  const found = await followReExports(filePath, content, name, resolver, reads, visited); // NOSONAR S9382 single await
  return found ?? (onlyDefault() ? DEFAULT_ONLY : null);
}

/**
 * Where `name` is re-exported from: a named re-export wins in source order; otherwise the `export *` modules that
 * declare it, of which there must be exactly one: two declaring modules make it ambiguous, and TypeScript exports
 * neither.
 */
async function followReExports(
  filePath: string,
  content: string,
  name: string,
  resolver: PathResolver,
  reads: DeclarationReads,
  visited: Set<string>,
): Promise<ReExportTarget | null> {
  const reExports = parseReExports(filePath, content);
  const follow = (specifier: string, wanted: string) => resolver.resolve(filePath, specifier).catch(() => null)
    .then(next => next ? findDeclaration(next, wanted, resolver, reads, visited, false) : null);
  for (const { specifier, names } of reExports.filter(entry => entry.names !== "all")) {
    const wanted = reExportedAs(names, name);
    if (!wanted) continue;
    // eslint-disable-next-line no-await-in-loop -- first named re-export in source order wins and shares the visited set
    const found = await follow(specifier, wanted); // NOSONAR S9382 sequential: source order, shared visited set
    if (found && found !== DEFAULT_ONLY) return found;
  }
  if (name === "default") return null; // `export *` never re-exports `default`
  let star: ReExportTarget | null = null;
  for (const { specifier } of reExports.filter(entry => entry.names === "all")) {
    // eslint-disable-next-line no-await-in-loop -- shares the visited set: a module reached twice counts once
    const found = await follow(specifier, name); // NOSONAR S9382 sequential: shared visited set
    if (!found || found === DEFAULT_ONLY) continue;
    if (star && (star.filePath !== found.filePath || star.name !== found.name)) return null;
    star = found;
  }
  return star;
}
