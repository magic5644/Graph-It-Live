import { DEFAULT_ONLY, findDeclaration, type DeclarationReads } from "@/analyzer/utils/declarations";
import type { PathResolver } from "@/analyzer/utils/PathResolver";
import type { ReExportTarget } from "@/analyzer/utils/reExports";
import { mapWithConcurrency } from "@/shared/concurrency";
import { normalizePath } from "@/shared/path";
import type { Node as TreeNode } from "web-tree-sitter";

const NAMESPACE_CALL_CONCURRENCY = 8;

const FUNCTION_SCOPES = new Set([
  "function_declaration", "function_expression", "arrow_function",
  "generator_function_declaration", "generator_function", "method_definition",
]);
const BLOCK_SCOPES = new Set([
  "statement_block", "for_statement", "for_in_statement", "catch_clause", "switch_body",
]);

function bindingNames(node: TreeNode | null): TreeNode[] {
  if (!node) return [];
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "shorthand_property_identifier_pattern":
      return [node];
    case "pair_pattern":
      return bindingNames(node.childForFieldName("value"));
    case "assignment_pattern":
    case "object_assignment_pattern":
      return bindingNames(node.childForFieldName("left"));
    case "required_parameter":
    case "optional_parameter":
      return bindingNames(node.childForFieldName("pattern"));
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
    case "formal_parameters":
      return node.namedChildren.flatMap(bindingNames);
    default:
      return [];
  }
}

function enclosingScope(node: TreeNode, functionOnly: boolean): TreeNode {
  let scope = node.parent ?? node;
  while (scope.parent && !FUNCTION_SCOPES.has(scope.type) &&
    (functionOnly || !BLOCK_SCOPES.has(scope.type))) {
    scope = scope.parent;
  }
  return scope;
}

/** `@@import:` stub reaching `name` in `modulePath` (or the barrel's real declaration); null when nothing is exported under it. */
function importStub(declared: ReExportTarget | typeof DEFAULT_ONLY | null, modulePath: string, name: string): string | null {
  if (declared === DEFAULT_ONLY) return null;
  return `@@import:${JSON.stringify([declared?.filePath ?? normalizePath(modulePath), declared?.name ?? name])}`;
}

/** Local name and imported name of each binding of an import statement: `import Panel, { Card as C } from`. */
function importedNames(statement: TreeNode): Array<{ local: TreeNode; imported: string; isType: boolean }> {
  const clause = statement.namedChildren.find(node => node.type === "import_clause");
  const defaultBinding = clause?.namedChildren.find(node => node.type === "identifier");
  const names = defaultBinding ? [{ local: defaultBinding, imported: "default", isType: false }] : [];
  for (const specifier of statement.descendantsOfType("import_specifier")) {
    const imported = specifier.childForFieldName("name");
    if (!imported) continue;
    const isType = specifier.children.some(node => node.type === "type");
    names.push({ local: specifier.childForFieldName("alias") ?? imported, imported: imported.text, isType });
  }
  return names;
}

/**
 * Named and default import bindings: local name -> `@@import:` stub, or null when it links nowhere. Only bindings
 * that a capture names (`used`) are resolved: the others stay null, so a module nothing calls is never resolved.
 */
async function collectNamedImports(
  root: TreeNode,
  filePath: string,
  resolver: PathResolver,
  reads: DeclarationReads,
  used: Set<string>,
): Promise<Map<string, string | null>> {
  const statements = root.namedChildren.filter(node => node.type === "import_statement");
  const bindings = await Promise.all(statements.map(async (statement): Promise<Array<[string, string | null]>> => {
    const names = importedNames(statement);
    const moduleName = statement.childForFieldName("source")?.namedChildren[0]?.text;
    const typeOnly = statement.children.some(node => node.type === "type");
    const needed = !typeOnly && moduleName && names.some(({ local, isType }) => !isType && used.has(local.text));
    const targetPath = needed ? await resolver.resolve(filePath, moduleName) : null;
    // Bindings are independent (own visited set, shared read cache): resolve them concurrently, in order.
    return Promise.all(names.map(async ({ local, imported, isType }): Promise<[string, string | null]> => {
      if (!targetPath || isType || !used.has(local.text)) return [local.text, null];
      const declared = await findDeclaration(targetPath, imported, resolver, reads);
      return [local.text, importStub(declared, targetPath, imported)];
    }));
  }));
  return new Map(bindings.flat());
}

/** `import * as ns from './mod'` bindings: local name -> resolved module path. Type-only imports bind nothing at runtime. */
async function collectNamespaceImports(
  root: TreeNode,
  filePath: string,
  resolver: PathResolver,
): Promise<Map<string, string>> {
  const entries = await Promise.all(root.namedChildren
    .filter(node => node.type === "import_statement" && !node.children.some(child => child.type === "type"))
    .map(async (statement): Promise<[string, string] | null> => {
      const local = statement.descendantsOfType("namespace_import")[0]?.namedChildren[0];
      const moduleName = statement.childForFieldName("source")?.namedChildren[0]?.text;
      const targetPath = local && moduleName ? await resolver.resolve(filePath, moduleName) : null;
      return local && targetPath ? [local.text, targetPath] : null;
    }));
  return new Map(entries.filter(entry => entry !== null));
}

function collectShadows(root: TreeNode, imports: { has(name: string): boolean }) {
  const shadows = new Map<string, Array<{ binding: TreeNode; scope: TreeNode }>>();
  const add = (pattern: TreeNode | null, scope: TreeNode) => {
    for (const binding of bindingNames(pattern)) {
      if (!imports.has(binding.text)) continue;
      const entries = shadows.get(binding.text) ?? [];
      entries.push({ binding, scope });
      shadows.set(binding.text, entries);
    }
  };
  const visit = (node: TreeNode) => {
    if (FUNCTION_SCOPES.has(node.type)) {
      add(node.childForFieldName("parameters") ?? node.childForFieldName("parameter"), node);
      const scope = node.type.endsWith("declaration") ? enclosingScope(node, false) : node;
      add(node.childForFieldName("name"), scope);
    } else if (node.type === "variable_declarator") {
      add(node.childForFieldName("name"), enclosingScope(node, node.parent?.type === "variable_declaration"));
    } else if (node.type === "catch_clause") {
      add(node.childForFieldName("parameter"), node);
    } else if (node.type === "for_in_statement" && node.childForFieldName("kind")) {
      add(node.childForFieldName("left"), node.childForFieldName("kind")?.text === "var" ? enclosingScope(node, true) : node);
    } else if (node.type === "class_declaration") {
      add(node.childForFieldName("name"), enclosingScope(node, false));
    }
    node.namedChildren.forEach(visit);
  };
  visit(root);
  return shadows;
}

type Shadows = ReturnType<typeof collectShadows>;

/** Innermost local declaration of `node.text` whose scope contains `node`, if any. */
function findShadow(shadows: Shadows, node: TreeNode) {
  return shadows.get(node.text)
    ?.filter(({ scope }) => scope.startIndex <= node.startIndex && scope.endIndex >= node.endIndex)
    .sort((a, b) => b.scope.startIndex - a.scope.startIndex || a.scope.endIndex - b.scope.endIndex)[0];
}

/** The namespace identifier of a static `ns.member()` call whose member is `call`, if any. */
function namespaceObject(call: TreeNode): TreeNode | null {
  const member = call.parent;
  if (member?.type !== "member_expression" || member.childForFieldName("property")?.id !== call.id) return null;
  const object = member.childForFieldName("object");
  return object?.type === "identifier" ? object : null;
}

/** `@@import:` stub for a static `ns.member()` call on an unshadowed namespace import, else null. */
async function resolveNamespaceCall(
  call: TreeNode,
  namespaces: Map<string, string>,
  shadows: Shadows,
  resolver: PathResolver,
  reads: DeclarationReads,
): Promise<string | null | undefined> {
  const object = namespaceObject(call);
  const modulePath = object && !findShadow(shadows, object) ? namespaces.get(object.text) : undefined;
  if (!modulePath) return undefined;
  const declared = await findDeclaration(modulePath, call.text, resolver, reads);
  return importStub(declared, modulePath, call.text);
}

/** `@@import:` stub for the default export of the module a `lazy(() => import('./literal'))` loads, null when it does not resolve. */
async function resolveLazyImport(specifier: TreeNode, filePath: string, resolver: PathResolver, reads: DeclarationReads): Promise<string | null> {
  const modulePath = await resolver.resolve(filePath, specifier.text).catch(() => null);
  return modulePath ? importStub(await findDeclaration(modulePath, "default", resolver, reads), modulePath, "default") : null;
}

/**
 * Resolve named, default and namespace imports, and `lazy()` module specifiers (`string_fragment` nodes), before
 * the AST is freed; unknown bindings never fall back to global names. A reference (`references`: `<Card />`,
 * `register(save)`) that no import binds resolves through its scope: the innermost declaration of its name, so a
 * parameter or a local variable links nowhere, and a name declared nowhere stays unresolved.
 */
export async function resolveNamedImportCalls(
  root: TreeNode,
  calls: TreeNode[],
  filePath: string,
  resolver: PathResolver,
  { references = new Set(), declared = new Set() }: { references?: ReadonlySet<number>; declared?: ReadonlySet<string> } = {},
  /** Shared by the files of one indexing pass, whose contents do not change during it; per call by default. */
  reads: DeclarationReads = new Map(),
): Promise<Map<number, string | null>> {
  const used = new Set(calls.filter(call => call.type === "identifier").map(call => call.text));
  const [imports, namespaces] = await Promise.all([
    collectNamedImports(root, filePath, resolver, reads, used),
    collectNamespaceImports(root, filePath, resolver),
  ]);
  const targets = new Map<number, string | null>();
  const isReference = (call: TreeNode) => call.type === "identifier" && references.has(call.id);
  // Only a passed name this file declares needs its scope: an import is bound, any other name links nowhere.
  const referenceNames = new Set(calls.filter(call => isReference(call) && declared.has(call.text)).map(call => call.text));
  if (imports.size === 0 && namespaces.size === 0 && referenceNames.size === 0 && !calls.some(call => call.type === "string_fragment")) return targets;
  const shadows = collectShadows(root, { has: (name) => imports.has(name) || namespaces.has(name) || referenceNames.has(name) });
  // Calls are independent (own visited set, shared read cache); a file can hold many, so bound the reads in flight.
  const stubs = await mapWithConcurrency(calls, NAMESPACE_CALL_CONCURRENCY, async (call): Promise<string | null | undefined> => {
    if (call.type === "string_fragment") return resolveLazyImport(call, filePath, resolver, reads);
    if (isReference(call) && !imports.has(call.text) && !referenceNames.has(call.text)) return null;
    if (call.type === "identifier" && (imports.has(call.text) || references.has(call.id))) {
      const shadow = findShadow(shadows, call);
      if (shadow) return `${filePath}:${call.text}:${shadow.binding.startPosition.row}`;
      return imports.has(call.text) ? imports.get(call.text)! : null;
    }
    return resolveNamespaceCall(call, namespaces, shadows, resolver, reads);
  });
  calls.forEach((call, index) => {
    if (stubs[index] !== undefined) targets.set(call.id, stubs[index]);
  });
  return targets;
}
