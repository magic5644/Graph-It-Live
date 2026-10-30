import type { PathResolver } from "@/analyzer/utils/PathResolver";
import type { Node as TreeNode } from "web-tree-sitter";

/**
 * Call target for a bare Python name with no visible import: it can only be a same-file
 * definition or a builtin, so it never falls back to a workspace-wide name match.
 */
export const LOCAL_ONLY = "@@local-only";

const SCOPES = new Set([
  "function_definition", "lambda", "list_comprehension", "set_comprehension",
  "dictionary_comprehension", "generator_expression",
]);

type Binding = { kind: "symbol"; stub: string | null } | { kind: "module"; path: string | null };
interface Entry { node: TreeNode; scope: TreeNode; binding?: Binding }

function patternNames(node: TreeNode | null): TreeNode[] {
  if (!node) return [];
  switch (node.type) {
    case "identifier":
      return [node];
    case "default_parameter":
    case "typed_default_parameter":
      return patternNames(node.childForFieldName("name"));
    case "typed_parameter":
      return patternNames(node.namedChildren[0] ?? null);
    case "parameters":
    case "lambda_parameters":
    case "tuple_pattern":
    case "list_pattern":
    case "pattern_list":
    case "list_splat_pattern":
    case "dictionary_splat_pattern":
    case "as_pattern_target":
      return node.namedChildren.flatMap(patternNames);
    default:
      return [];
  }
}

/**
 * Scope a name bound by `node` belongs to: the nearest function-like scope, else the module.
 * Null inside a class body: class scope is invisible to nested functions and not modelled.
 */
function scopeOf(node: TreeNode): TreeNode | null {
  let scope = node.parent;
  while (scope) {
    if (SCOPES.has(scope.type) || !scope.parent) return scope;
    if (scope.type === "class_definition") return null;
    scope = scope.parent;
  }
  return null;
}

async function resolveModule(resolver: PathResolver, filePath: string, specifier: string): Promise<string | null> {
  const resolved = await resolver.resolve(filePath, specifier).catch(() => null);
  return resolved?.endsWith(".py") ? resolved : null;
}

type Found = Array<[string, TreeNode, Binding]>;

/** `import a`, `import a.b as m`: bindings as [local name, node, binding]. */
async function importBindings(names: TreeNode[], filePath: string, resolver: PathResolver): Promise<Found> {
  const entries = await Promise.all(names.map(async (name): Promise<Found[number] | null> => {
    const alias = name.childForFieldName("alias");
    const dotted = name.type === "aliased_import" ? name.childForFieldName("name") : name;
    if (!dotted) return null;
    // `import a.b` binds only `a` to a package whose attributes are not tracked.
    const tracked = alias || !dotted.text.includes(".");
    const path = tracked ? await resolveModule(resolver, filePath, dotted.text) : null;
    return [alias?.text ?? dotted.text.split(".")[0], alias ?? dotted, { kind: "module", path }];
  }));
  return entries.filter(entry => entry !== null);
}

/** `from m import a as b`: bindings as [local name, node, binding]. */
async function fromImportBindings(statement: TreeNode, specifier: string, filePath: string, resolver: PathResolver): Promise<Found> {
  const modulePromise = resolveModule(resolver, filePath, specifier);
  const entries = await Promise.all(statement.childrenForFieldName("name").map(async (name): Promise<Found[number] | null> => {
    const alias = name.childForFieldName("alias");
    const imported = name.type === "aliased_import" ? name.childForFieldName("name") : name;
    if (!imported) return null;
    // `from pkg import sub` binds a submodule when one exists, otherwise a symbol of `pkg`.
    const [modulePath, submodule] = await Promise.all([
      modulePromise,
      resolveModule(resolver, filePath, specifier.endsWith(".") ? specifier + imported.text : `${specifier}.${imported.text}`),
    ]);
    const binding: Binding = submodule
      ? { kind: "module", path: submodule }
      : { kind: "symbol", stub: modulePath ? `@@import:${JSON.stringify([modulePath, imported.text])}` : null };
    return [alias?.text ?? imported.text, alias ?? imported, binding];
  }));
  return entries.filter(entry => entry !== null);
}

/** Bindings introduced by one `import` / `from ... import` statement. */
async function statementBindings(
  statement: TreeNode,
  filePath: string,
  resolver: PathResolver,
): Promise<{ entries: Found; wildcard: boolean }> {
  if (statement.type === "import_statement") {
    return { entries: await importBindings(statement.childrenForFieldName("name"), filePath, resolver), wildcard: false };
  }
  const specifier = statement.childForFieldName("module_name")?.text;
  const wildcard = statement.namedChildren.some(child => child.type === "wildcard_import");
  return { entries: specifier ? await fromImportBindings(statement, specifier, filePath, resolver) : [], wildcard };
}

function addEntry(bindings: Map<string, Entry[]>, name: string, node: TreeNode, scope: TreeNode | null, binding?: Binding) {
  if (!scope) return;
  const list = bindings.get(name) ?? [];
  list.push({ node, scope, binding });
  bindings.set(name, list);
}

/** Every name a Python file binds, with its scope: imports (resolved) and local definitions (shadows). */
async function collectBindings(root: TreeNode, filePath: string, resolver: PathResolver) {
  const bindings = new Map<string, Entry[]>();
  let wildcard = false;
  const add = (pattern: TreeNode | null, scope: TreeNode | null) => {
    for (const node of patternNames(pattern)) addEntry(bindings, node.text, node, scope);
  };
  const visit = (node: TreeNode) => {
    switch (node.type) {
      case "function_definition":
        add(node.childForFieldName("name"), scopeOf(node));
        add(node.childForFieldName("parameters"), node);
        break;
      case "lambda":
        add(node.childForFieldName("parameters"), node);
        break;
      case "class_definition":
        add(node.childForFieldName("name"), scopeOf(node));
        break;
      case "assignment":
      case "augmented_assignment":
      case "for_statement":
      case "for_in_clause":
        add(node.childForFieldName("left"), scopeOf(node));
        break;
      case "named_expression":
        add(node.childForFieldName("name"), scopeOf(node));
        break;
      case "as_pattern":
        add(node.childForFieldName("alias"), scopeOf(node));
        break;
    }
    node.namedChildren.forEach(visit);
  };
  visit(root);
  // Statements resolve independently; entries are added afterwards in source order.
  const statements = root.descendantsOfType(["import_statement", "import_from_statement"]);
  const results = await Promise.all(statements.map(statement => statementBindings(statement, filePath, resolver)));
  statements.forEach((statement, index) => {
    const scope = scopeOf(statement);
    const found = results[index];
    wildcard ||= found.wildcard;
    for (const [local, node, binding] of found.entries) addEntry(bindings, local, node, scope, binding);
  });
  return { bindings, wildcard };
}

/** Entries of `name` bound in the innermost scope containing `node`: one when proven, several when ambiguous. */
function visibleEntries(bindings: Map<string, Entry[]>, name: string, node: TreeNode): Entry[] {
  const inScope = (bindings.get(name) ?? [])
    .filter(({ scope }) => scope.startIndex <= node.startIndex && scope.endIndex >= node.endIndex);
  const innermost = inScope.reduce<TreeNode | null>((best, { scope }) =>
    !best || scope.startIndex > best.startIndex || (scope.startIndex === best.startIndex && scope.endIndex < best.endIndex) ? scope : best, null);
  return inScope.filter(({ scope }) => scope.id === innermost?.id);
}

/**
 * Resolve Python calls through their import bindings before the AST is freed.
 * An import that cannot be proven yields null (no edge); a bare name with no visible import yields
 * `LOCAL_ONLY`; calls this cannot reason about get no entry and keep the extractor's own rules.
 */
export async function resolvePythonImportCalls(
  root: TreeNode,
  calls: TreeNode[],
  filePath: string,
  resolver: PathResolver,
): Promise<Map<number, string | null>> {
  const { bindings, wildcard } = await collectBindings(root, filePath, resolver);
  const targets = new Map<number, string | null>();
  for (const call of calls) {
    const target = callTarget(call, bindings, wildcard, filePath);
    if (target !== undefined) targets.set(call.id, target);
  }
  return targets;
}

/** Target of one call; undefined when the call is left to the extractor's own rules. */
function callTarget(call: TreeNode, bindings: Map<string, Entry[]>, wildcard: boolean, filePath: string): string | null | undefined {
  const parent = call.parent;
  if (parent?.type === "call") {
    const found = visibleEntries(bindings, call.text, call);
    // `from m import *` may supply any name, so only then is the global fallback kept.
    if (found.length === 0) return wildcard ? undefined : LOCAL_ONLY;
    return found.length === 1 ? bareTarget(found[0], call.text, filePath) : null;
  }
  if (parent?.type !== "attribute" || parent.childForFieldName("attribute")?.id !== call.id) return undefined;
  const object = parent.childForFieldName("object");
  const found = object?.type === "identifier" ? visibleEntries(bindings, object.text, object) : [];
  if (found.length > 1) return null;
  const binding = found[0]?.binding;
  if (binding?.kind !== "module") return undefined;
  return binding.path ? `@@import:${JSON.stringify([binding.path, call.text])}` : null;
}

function bareTarget({ binding, node }: Entry, name: string, filePath: string): string | null {
  if (!binding) return `${filePath}:${name}:${node.startPosition.row}`;
  return binding.kind === "symbol" ? binding.stub : null;
}
