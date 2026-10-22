import type { PathResolver } from "@/analyzer/utils/PathResolver";
import { normalizePath } from "@/shared/path";
import type { Node as TreeNode } from "web-tree-sitter";

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

async function collectNamedImports(
  root: TreeNode,
  filePath: string,
  resolver: PathResolver,
): Promise<Map<string, string | null>> {
  const statements = root.namedChildren.filter(node => node.type === "import_statement");
  const bindings = await Promise.all(statements.map(async (statement): Promise<Array<[string, string | null]>> => {
    const specifiers = statement.descendantsOfType("import_specifier");
    if (specifiers.length === 0) return [];
    const moduleName = statement.childForFieldName("source")?.namedChildren[0]?.text;
    const typeOnly = statement.children.some(node => node.type === "type");
    const targetPath = !typeOnly && moduleName ? await resolver.resolve(filePath, moduleName) : null;
    const imports: Array<[string, string | null]> = [];
    for (const specifier of specifiers) {
      const imported = specifier.childForFieldName("name");
      if (!imported) continue;
      const local = specifier.childForFieldName("alias") ?? imported;
      const isType = typeOnly || specifier.children.some(node => node.type === "type");
      imports.push([local.text, targetPath && !isType
        ? `@@import:${JSON.stringify([normalizePath(targetPath), imported.text])}` : null]);
    }
    return imports;
  }));
  return new Map(bindings.flat());
}

function collectShadows(root: TreeNode, imports: Map<string, string | null>) {
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

/** Resolve named imports before the AST is freed; unknown bindings never fall back to global names. */
export async function resolveNamedImportCalls(
  root: TreeNode,
  calls: TreeNode[],
  filePath: string,
  resolver: PathResolver,
): Promise<Map<number, string | null>> {
  const imports = await collectNamedImports(root, filePath, resolver);
  const targets = new Map<number, string | null>();
  if (imports.size === 0) return targets;
  const shadows = collectShadows(root, imports);
  for (const call of calls) {
    if (!imports.has(call.text) || call.type !== "identifier") continue;
    const shadow = shadows.get(call.text)
      ?.filter(({ scope }) => scope.startIndex <= call.startIndex && scope.endIndex >= call.endIndex)
      .sort((a, b) => b.scope.startIndex - a.scope.startIndex || a.scope.endIndex - b.scope.endIndex)[0];
    targets.set(call.id, shadow
      ? `${filePath}:${call.text}:${shadow.binding.startPosition.row}`
      : imports.get(call.text)!);
  }
  return targets;
}
