import { ts } from 'ts-morph';
import { isPythonOrRust, pyRsReExports } from './pyRsImports';

/** A module path and the export name it is reached by. */
export interface ReExportTarget {
  filePath: string;
  name: string;
}

export interface ReExport {
  specifier: string;
  /** `'all'` for `export * from`; otherwise the `imported as exported` pairs of `export { ... } from`. */
  names: 'all' | Array<{ imported: string; exported: string }>;
}

/**
 * Top-level re-exports of a module: `export ... from`, and `import { x } from; export { x }`.
 * `export * as ns from` is skipped: it exports a namespace object, not the names themselves.
 * ponytail: `import * as ns; export { ns }` and `export default x` of an import are not followed.
 */
export function parseReExports(filePath: string, content: string): ReExport[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  const imports = importBindings(sourceFile);
  const reExports: ReExport[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const from = statement.moduleSpecifier;
    if (from && ts.isStringLiteral(from)) {
      const fromExport = reExportFrom(from.text, statement.exportClause);
      if (fromExport) reExports.push(fromExport);
    } else if (!from) {
      reExports.push(...reExportsOfImports(statement.exportClause, imports));
    }
  }
  return reExports;
}

/** `export * from` / `export { a as b } from`; `export * as ns from` is not a name re-export. */
function reExportFrom(specifier: string, clause: ts.NamedExportBindings | undefined): ReExport | null {
  if (!clause) return { specifier, names: 'all' };
  if (!ts.isNamedExports(clause)) return null;
  return {
    specifier,
    names: clause.elements.map((element) => ({ imported: (element.propertyName ?? element.name).text, exported: element.name.text })),
  };
}

/** `export { x }` where `x` is an import binding of this module. */
function reExportsOfImports(
  clause: ts.NamedExportBindings | undefined,
  imports: Map<string, { specifier: string; imported: string }>
): ReExport[] {
  if (!clause || !ts.isNamedExports(clause)) return [];
  const found: ReExport[] = [];
  for (const element of clause.elements) {
    const bound = imports.get((element.propertyName ?? element.name).text);
    if (bound) found.push({ specifier: bound.specifier, names: [{ imported: bound.imported, exported: element.name.text }] });
  }
  return found;
}

/** Local name -> module and export name, for named and default imports. */
function importBindings(sourceFile: ts.SourceFile): Map<string, { specifier: string; imported: string }> {
  const bindings = new Map<string, { specifier: string; imported: string }>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) bindings.set(clause.name.text, { specifier, imported: 'default' });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, { specifier, imported: (element.propertyName ?? element.name).text });
      }
    }
  }
  return bindings;
}

/** Top-level `export * as alias from 'specifier'` declarations: a namespace object over the whole module. */
export function parseNamespaceReExports(filePath: string, content: string): Array<{ specifier: string; alias: string }> {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  const namespaces: Array<{ specifier: string; alias: string }> = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const { exportClause: clause, moduleSpecifier } = statement;
    if (clause && ts.isNamespaceExport(clause) && moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
      namespaces.push({ specifier: moduleSpecifier.text, alias: clause.name.text });
    }
  }
  return namespaces;
}

/** `export * ...` or `export { ... }`, with or without `from` (the local form re-exports imports). */
const REEXPORT_FROM = /\bexport\s*(?:type\s+)?[*{]/;
const EXPORT_DEFAULT = /\bexport\s+default\s/;

/** What a module re-exports: names (`export ... from`, import-then-export) and `export * as ns from`. */
export interface ModuleReExports {
  reExports: ReExport[];
  namespaces: Array<{ specifier: string; alias: string }>;
  /** Python `__all__`: the names `from m import *` takes from this module (absent: every public name). */
  starNames?: string[];
}

const NO_REEXPORTS: ModuleReExports = { reExports: [], namespaces: [] };

/** Both re-export kinds of a module, in JS/TS, Python or Rust; plain JS/TS modules are never parsed. */
export function readModuleReExports(filePath: string, content: string): ModuleReExports {
  if (isPythonOrRust(filePath)) return pyRsReExports(filePath, content);
  if (!mayReExport(content)) return NO_REEXPORTS;
  return { reExports: parseReExports(filePath, content), namespaces: parseNamespaceReExports(filePath, content) };
}

/** Cheap pre-check so plain modules are never parsed. */
export function mayReExport(content: string): boolean {
  return REEXPORT_FROM.test(content);
}

/**
 * Whether the module itself exports `name`: a declaration, or a local `export { name }`.
 * ponytail: destructured `export const { a } = obj` is not recognised; add binding patterns if barrels use it.
 */
export function declaresExport(filePath: string, content: string, name: string): boolean {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  return sourceFile.statements.some((statement) => {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      return !statement.moduleSpecifier && !!clause && ts.isNamedExports(clause)
        && clause.elements.some((element) => element.name.text === name);
    }
    const modifiers = ts.getModifiers(statement as ts.HasModifiers) ?? [];
    // `export default function a` exports `default`, not `a`.
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return false;
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
    }
    return 'name' in statement && ts.isIdentifier(statement.name as ts.Node) && (statement.name as ts.Identifier).text === name;
  });
}

/**
 * Whether `name` is only the local name of the module's default export (`export default function name`),
 * so `import { name }` and `ns.name` reach nothing. A regex pre-check keeps other modules unparsed.
 */
export function exportsOnlyAsDefault(filePath: string, content: string, name: string): boolean {
  // Called for every named import: most modules have no default export, so skip compiling a regex per name.
  if (!EXPORT_DEFAULT.test(content)) return false;
  const escaped = name.replaceAll('$', String.raw`\$`);
  const defaultDeclaration = new RegExp(String.raw`\bexport\s+default\s+(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+)${escaped}(?![\w$])`);
  return defaultDeclaration.test(content) && !declaresExport(filePath, content, name);
}
