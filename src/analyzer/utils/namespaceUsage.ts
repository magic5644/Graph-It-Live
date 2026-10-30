import { ts } from 'ts-morph';

/** One local binding created by an import declaration; `imported` is `'*'` for `import * as local`. */
export interface ImportBinding {
  specifier: string;
  imported: string;
  local: string;
}

export interface NamespaceUse {
  /** Members reached as `local.member`, `local['member']` or `local.Type`. */
  members: Set<string>;
  /** The namespace is used as a whole (passed, destructured, re-exported, indexed dynamically). */
  escapes: boolean;
}

/** Named, default and namespace imports of a module, one entry per local name. */
export function importBindings(filePath: string, content: string): ImportBinding[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  const bindings: ImportBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) bindings.push({ specifier, imported: 'default', local: clause.name.text });
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.push({ specifier, imported: '*', local: named.name.text });
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push({ specifier, imported: (element.propertyName ?? element.name).text, local: element.name.text });
      }
    }
  }
  return bindings;
}

/**
 * How `local` (an imported namespace object) is used in a module.
 * Any use that is not a plain member access counts as an escape, so callers err toward "used".
 * ponytail: shadowing is ignored; a shadowing `local.x` can only mark a member used, never hide one.
 */
export function namespaceUse(filePath: string, content: string, local: string): NamespaceUse {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const use: NamespaceUse = { members: new Set(), escapes: false };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === local) record(node, use);
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) visit(statement);
  }
  return use;
}

function record(identifier: ts.Identifier, use: NamespaceUse): void {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.expression === identifier) use.members.add(parent.name.text);
    return; // `x.local` names a property, not the namespace
  }
  if (ts.isQualifiedName(parent)) {
    if (parent.left === identifier) use.members.add(parent.right.text);
    return;
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === identifier) {
    if (ts.isStringLiteralLike(parent.argumentExpression)) use.members.add(parent.argumentExpression.text);
    else use.escapes = true;
    return;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === identifier) return;
  use.escapes = true;
}
