import { ts } from "ts-morph";
import { parseSfc, scriptKindOf } from "./sfcBlocks";

/** The props and events a Vue SFC declares by name in its own script. */
export interface VueContract {
  props: string[];
  emits: string[];
  /** Why some names may be missing: typed by an imported type, built at runtime, external `<script src>`. */
  partial: string[];
  /** The declarations read, as written: a change the names do not show (an imported type swapped) still shows here. */
  declarations: string[];
}

/** A prop or event added or removed, with its review evidence line (`prop 'label' removed`). */
export interface VueContractEntry {
  kind: "prop" | "event";
  name: string;
  detail: string;
}

/** What changed between two contracts of one component. */
export interface VueContractChange {
  removed: VueContractEntry[];
  added: VueContractEntry[];
  /** The head contract's partial reasons, when its declarations changed. */
  partial: string[];
}

type Kind = "props" | "emits";

interface Reader {
  source: ts.SourceFile;
  names: Record<Kind, Set<string>>;
  partial: Set<string>;
  declarations: string[];
}

/**
 * Props and events of a Vue SFC, read from the names written literally: `defineProps(['a'])`, `defineProps({ a: … })`,
 * `defineProps<{ a: T }>()` (also under `withDefaults`, or through an interface or type literal of the file),
 * `defineEmits(['save'])`, `defineEmits<{ save: […] }>()` or `<{ (e: 'save'): void }>()`, `defineModel('x')` (prop `x`
 * and event `update:x`), and Options API `props` / `emits`. Anything else is listed in `partial`; no type is checked.
 */
export function readVueContract(filePath: string, content: string): VueContract {
  const { scriptView, scripts } = parseSfc(filePath, content);
  const source = ts.createSourceFile("contract.ts", scriptView, ts.ScriptTarget.Latest, false, scriptKindOf(scripts));
  const reader: Reader = { source, names: { props: new Set(), emits: new Set() }, partial: new Set(), declarations: [] };
  if (scripts.some((script) => script.src !== undefined)) reader.partial.add("the script is an external <script src>");
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) readMacro(node, reader);
    else if (ts.isExportAssignment(node)) readOptions(node.expression, reader);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const sorted = (names: Set<string>) => [...names].sort((left, right) => left.localeCompare(right));
  return { props: sorted(reader.names.props), emits: sorted(reader.names.emits), partial: sorted(reader.partial), declarations: reader.declarations };
}

/** Props and events removed or added by name. */
export function compareVueContracts(base: VueContract, head: VueContract): VueContractChange {
  const entries = (from: VueContract, to: VueContract, verb: string): VueContractEntry[] => [
    ...from.props.filter((name) => !to.props.includes(name)).map((name) => ({ kind: "prop" as const, name, detail: `prop '${name}' ${verb}` })),
    ...from.emits.filter((name) => !to.emits.includes(name)).map((name) => ({ kind: "event" as const, name, detail: `event '${name}' ${verb}` })),
  ];
  const changed = base.declarations.join("\0") !== head.declarations.join("\0");
  return { removed: entries(base, head, "removed"), added: entries(head, base, "added"), partial: changed ? head.partial : [] };
}

function readMacro(call: ts.CallExpression, reader: Reader): void {
  if (!ts.isIdentifier(call.expression)) return;
  const macro = call.expression.text;
  if (macro !== "defineProps" && macro !== "defineEmits" && macro !== "defineModel") return;
  reader.declarations.push(call.getText(reader.source));
  if (macro === "defineModel") return readModel(call, reader);
  const kind: Kind = macro === "defineProps" ? "props" : "emits";
  const [typeArgument] = call.typeArguments ?? [];
  const [argument] = call.arguments;
  if (typeArgument) readType(typeArgument, kind, reader);
  else if (argument) readValue(argument, kind, reader);
}

/** `defineModel()` / `defineModel({ … })` is `modelValue`; `defineModel('x', …)` is `x`; with its `update:` event. */
function readModel(call: ts.CallExpression, reader: Reader): void {
  const [first] = call.arguments;
  let name: string | undefined = "modelValue";
  if (first && !ts.isObjectLiteralExpression(first)) name = ts.isStringLiteralLike(first) ? first.text : undefined;
  if (name === undefined) {
    reader.partial.add("defineModel names its prop at runtime");
    return;
  }
  reader.names.props.add(name);
  reader.names.emits.add(`update:${name}`);
}

/** `export default { props, emits }`, also wrapped as `defineComponent({ … })`. */
function readOptions(expression: ts.Expression, reader: Reader): void {
  const options = ts.isCallExpression(expression) ? expression.arguments[0] : expression;
  if (!options || !ts.isObjectLiteralExpression(options)) return;
  for (const property of options.properties) {
    const key = property.name && propertyName(property.name);
    if (key !== "props" && key !== "emits") continue;
    reader.declarations.push(property.getText(reader.source));
    // `{ props }` names a variable: its value is not followed.
    if (ts.isPropertyAssignment(property)) readValue(property.initializer, key, reader);
    else reader.partial.add(`${key} are built at runtime`);
  }
}

/** `['a', 'b']` or `{ a: …, b() {} }`; a spread, computed key or any other value is not read. */
function readValue(value: ts.Expression, kind: Kind, reader: Reader): void {
  let elements: readonly ts.Node[] | undefined;
  if (ts.isArrayLiteralExpression(value)) elements = value.elements;
  else if (ts.isObjectLiteralExpression(value)) elements = value.properties;
  if (!elements) {
    reader.partial.add(`${kind} are built at runtime`);
    return;
  }
  for (const element of elements) {
    const name = ts.isStringLiteralLike(element) ? element.text : memberName(element);
    if (name === undefined) reader.partial.add(`${kind} hold a spread or computed entry`);
    else reader.names[kind].add(name);
  }
}

/** A type literal, or an interface or type literal alias declared in the file; an imported type is not read. */
function readType(type: ts.TypeNode, kind: Kind, reader: Reader): void {
  if (ts.isTypeLiteralNode(type)) return readMembers(type.members, kind, reader);
  const local = ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? localType(type.typeName.text, reader.source) : undefined;
  if (local) {
    reader.declarations.push(local.declaration.getText(reader.source));
    return readMembers(local.members, kind, reader);
  }
  reader.partial.add(`${kind} are typed by '${type.getText(reader.source)}', not declared in this file`);
}

function readMembers(members: ts.NodeArray<ts.TypeElement>, kind: Kind, reader: Reader): void {
  for (const member of members) {
    // `(e: 'save' | 'close', id: number): void` declares its events by the first parameter's literal type.
    const names = ts.isCallSignatureDeclaration(member) ? literalNames(member.parameters[0]?.type) : [memberName(member)];
    if (names.length === 0 || names.includes(undefined)) reader.partial.add(`${kind} hold a member whose name is not a literal`);
    for (const name of names) if (name !== undefined) reader.names[kind].add(name);
  }
}

function localType(name: string, source: ts.SourceFile): { declaration: ts.Statement; members: ts.NodeArray<ts.TypeElement> } | undefined {
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) return { declaration: statement, members: statement.members };
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name && ts.isTypeLiteralNode(statement.type)) {
      return { declaration: statement, members: statement.type.members };
    }
  }
  return undefined;
}

function literalNames(type: ts.TypeNode | undefined): Array<string | undefined> {
  if (!type) return [];
  const parts = ts.isUnionTypeNode(type) ? type.types : [type];
  return parts.map((part) => (ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal) ? part.literal.text : undefined));
}

function memberName(member: ts.Node): string | undefined {
  if (ts.isShorthandPropertyAssignment(member)) return member.name.text;
  const isNamed = ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member) || ts.isPropertySignature(member) || ts.isMethodSignature(member);
  return isNamed ? propertyName(member.name) : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}
