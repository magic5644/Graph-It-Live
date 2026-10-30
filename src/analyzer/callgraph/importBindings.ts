import type { PathResolver } from "@/analyzer/utils/PathResolver";
import { isInIgnoredDirectory } from "@/analyzer/utils/PathPredicates";
import { declaresExport, exportsOnlyAsDefault, mayReExport, parseReExports, type ReExport, type ReExportTarget } from "@/analyzer/utils/reExports";
import { mapWithConcurrency } from "@/shared/concurrency";
import { normalizePath } from "@/shared/path";
import fs from "node:fs/promises";
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

/** The name a re-export declaration reaches `name` under in its source module, if any. */
function reExportedAs(names: ReExport["names"], name: string): string | undefined {
  // `export *` never re-exports `default`.
  if (names === "all") return name === "default" ? undefined : name;
  return names.find((entry) => entry.exported === name)?.imported;
}

/** `findDeclaration` result for a module that exports `name` only as the local name of its default export. */
const DEFAULT_ONLY = "default-only";

/** `@@import:` stub reaching `name` in `modulePath` (or the barrel's real declaration); null when nothing is exported under it. */
function importStub(declared: ReExportTarget | typeof DEFAULT_ONLY | null, modulePath: string, name: string): string | null {
  if (declared === DEFAULT_ONLY) return null;
  return `@@import:${JSON.stringify([declared?.filePath ?? normalizePath(modulePath), declared?.name ?? name])}`;
}

/**
 * Follows `name` through barrels (`export { x } from`, `export * from`) to the module that
 * declares it, so a call through a barrel links to the real symbol. Null when the chain
 * cannot be resolved: the caller keeps the barrel as target. `DEFAULT_ONLY` when the module itself
 * exports `name` only as its default export's local name.
 */
async function findDeclaration(
  filePath: string,
  name: string,
  resolver: PathResolver,
  visited: Set<string>,
  reads: Map<string, Promise<string | null>>,
): Promise<ReExportTarget | typeof DEFAULT_ONLY | null> {
  const normalized = normalizePath(filePath);
  const key = `${normalized}:${name}`;
  if (visited.has(key) || isInIgnoredDirectory(normalized)) return null;
  visited.add(key);
  // One read per module per import statement set: several specifiers often share a module.
  if (!reads.has(key)) reads.set(key, fs.readFile(filePath, "utf-8").catch(() => null));
  const content = await reads.get(key)!; // NOSONAR S9382 sequential: first declaring barrel wins
  if (content === null) return null;
  const onlyDefault = () => exportsOnlyAsDefault(filePath, content, name);
  if (!mayReExport(content) || declaresExport(filePath, content, name)) return onlyDefault() ? DEFAULT_ONLY : { filePath: normalized, name };
  return (await followReExports(filePath, content, name, resolver, visited, reads)) ?? (onlyDefault() ? DEFAULT_ONLY : null); // NOSONAR S9382 single await
}

async function followReExports(
  filePath: string,
  content: string,
  name: string,
  resolver: PathResolver,
  visited: Set<string>,
  reads: Map<string, Promise<string | null>>,
): Promise<ReExportTarget | null> {
  for (const { specifier, names } of parseReExports(filePath, content)) {
    const wanted = reExportedAs(names, name);
    if (!wanted) continue;
    // eslint-disable-next-line no-await-in-loop -- first declaring re-export in source order wins and shares the visited set; stopping there avoids reading the other barrels
    const found = await resolver.resolve(filePath, specifier).catch(() => null) // NOSONAR S9382 sequential: source order, shared visited set
      .then(next => next ? findDeclaration(next, wanted, resolver, visited, reads) : null);
    if (found && found !== DEFAULT_ONLY) return found;
  }
  return null;
}

async function collectNamedImports(
  root: TreeNode,
  filePath: string,
  resolver: PathResolver,
): Promise<Map<string, string | null>> {
  const statements = root.namedChildren.filter(node => node.type === "import_statement");
  const reads = new Map<string, Promise<string | null>>();
  const bindings = await Promise.all(statements.map(async (statement): Promise<Array<[string, string | null]>> => {
    const specifiers = statement.descendantsOfType("import_specifier");
    if (specifiers.length === 0) return [];
    const moduleName = statement.childForFieldName("source")?.namedChildren[0]?.text;
    const typeOnly = statement.children.some(node => node.type === "type");
    const targetPath = !typeOnly && moduleName ? await resolver.resolve(filePath, moduleName) : null;
    // Specifiers are independent (own visited set, shared promise cache): resolve them concurrently, in order.
    const imports = await Promise.all(specifiers.map(async (specifier): Promise<[string, string | null] | null> => {
      const imported = specifier.childForFieldName("name");
      if (!imported) return null;
      const local = specifier.childForFieldName("alias") ?? imported;
      const isType = typeOnly || specifier.children.some(node => node.type === "type");
      if (!targetPath || isType) return [local.text, null];
      const declared = await findDeclaration(targetPath, imported.text, resolver, new Set(), reads);
      return [local.text, importStub(declared, targetPath, imported.text)];
    }));
    return imports.filter(entry => entry !== null);
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
  reads: Map<string, Promise<string | null>>,
): Promise<string | null | undefined> {
  const object = namespaceObject(call);
  const modulePath = object && !findShadow(shadows, object) ? namespaces.get(object.text) : undefined;
  if (!modulePath) return undefined;
  const declared = await findDeclaration(modulePath, call.text, resolver, new Set(), reads);
  return importStub(declared, modulePath, call.text);
}

/** Resolve named and namespace imports before the AST is freed; unknown bindings never fall back to global names. */
export async function resolveNamedImportCalls(
  root: TreeNode,
  calls: TreeNode[],
  filePath: string,
  resolver: PathResolver,
): Promise<Map<number, string | null>> {
  const [imports, namespaces] = await Promise.all([
    collectNamedImports(root, filePath, resolver),
    collectNamespaceImports(root, filePath, resolver),
  ]);
  const targets = new Map<number, string | null>();
  if (imports.size === 0 && namespaces.size === 0) return targets;
  const shadows = collectShadows(root, { has: (name) => imports.has(name) || namespaces.has(name) });
  const reads = new Map<string, Promise<string | null>>();
  // Calls are independent (own visited set, shared promise cache); a file can hold many, so bound the reads in flight.
  const stubs = await mapWithConcurrency(calls, NAMESPACE_CALL_CONCURRENCY, async (call): Promise<string | null | undefined> => {
    if (call.type === "identifier" && imports.has(call.text)) {
      const shadow = findShadow(shadows, call);
      return shadow
        ? `${filePath}:${call.text}:${shadow.binding.startPosition.row}`
        : imports.get(call.text)!;
    }
    return resolveNamespaceCall(call, namespaces, shadows, resolver, reads);
  });
  calls.forEach((call, index) => {
    if (stubs[index] !== undefined) targets.set(call.id, stubs[index]);
  });
  return targets;
}
