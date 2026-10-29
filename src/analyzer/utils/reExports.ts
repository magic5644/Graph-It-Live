import { ts } from 'ts-morph';

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
 * Top-level `export ... from` declarations of a module.
 * `export * as ns from` is skipped: it exports a namespace object, not the names themselves.
 * ponytail: `import { x } from; export { x }` is not followed; add it if barrels use that form.
 */
export function parseReExports(filePath: string, content: string): ReExport[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  const reExports: ReExport[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.exportClause;
    if (!clause) {
      reExports.push({ specifier, names: 'all' });
    } else if (ts.isNamedExports(clause)) {
      reExports.push({
        specifier,
        names: clause.elements.map((element) => ({
          imported: (element.propertyName ?? element.name).text,
          exported: element.name.text,
        })),
      });
    }
  }
  return reExports;
}

const REEXPORT_FROM = /\bexport\s*(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\b/;

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
  const escaped = name.replaceAll('$', String.raw`\$`);
  const defaultDeclaration = new RegExp(String.raw`\bexport\s+default\s+(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+)${escaped}(?![\w$])`);
  return defaultDeclaration.test(content) && !declaresExport(filePath, content, name);
}
