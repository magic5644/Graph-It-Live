/**
 * GraphQL call graph extraction (#523).
 *
 * No tree-sitter GraphQL grammar ships with the extension, and the language is
 * small, so a hand-written scanner reads the definitions:
 *  - operations (`query`/`mutation`/`subscription`) and fragments are nodes;
 *    a fragment spread `...Name` is a CALLS edge, and an operation USES its
 *    default root type (`Query`, `Mutation`, `Subscription`);
 *  - schema types (`type`, `input`, `interface`, `enum`, `union`, `scalar`,
 *    and their `extend` forms) are nodes; field, argument and variable types,
 *    union members and type conditions (`on User`) are USES edges, and
 *    `implements` is an IMPLEMENTS edge.
 * Names are global in GraphQL, so a name not defined in the file becomes an
 * `@@external:` stub that CallGraphIndexer resolves workspace-wide by name.
 *
 * NO vscode imports — this module is VS Code agnostic.
 */

import type { RelationType, SymbolType } from "@/shared/callgraph-types";
import type { CallGraphEdge, CallGraphNode } from "./CallGraphIndexer";

interface Token {
  text: string;
  isName: boolean;
  /** 0-based */
  line: number;
  /** 0-based */
  col: number;
}

const PUNCTUATORS = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "|", "}"]);

const SYMBOL_TYPE_BY_KEYWORD: Readonly<Record<string, SymbolType>> = {
  query: "function",
  mutation: "function",
  subscription: "function",
  fragment: "function",
  type: "class",
  input: "class",
  interface: "interface",
  enum: "type",
  union: "type",
  scalar: "type",
};

/** Keywords that start a top-level definition; `schema`/`directive` give no node. */
const DEFINITION_KEYWORDS = new Set([...Object.keys(SYMBOL_TYPE_BY_KEYWORD), "schema", "directive", "extend"]);

const EXECUTABLE_KEYWORDS = new Set(["query", "mutation", "subscription", "fragment"]);

/**
 * Root type an operation reads from, by the default naming convention.
 * shortcut: a `schema { query: RootQuery }` override is not followed (it usually sits in another file);
 * the edge to `Query` is then dropped at resolution unless an unrelated `Query` type exists.
 */
const ROOT_TYPE_BY_OPERATION: Readonly<Record<string, string>> = {
  query: "Query",
  mutation: "Mutation",
  subscription: "Subscription",
};

function isNameStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= "0" && ch <= "9");
}

/** End index (exclusive) of the string literal starting at `start`. */
function stringEnd(source: string, start: number): number {
  if (source.startsWith('"""', start)) {
    let end = source.indexOf('"""', start + 3);
    // `\"""` is an escaped triple quote inside a block string.
    while (end !== -1 && source[end - 1] === "\\") end = source.indexOf('"""', end + 1);
    return end === -1 ? source.length : end + 3;
  }
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") i += 2;
    else if (ch === '"') return i + 1;
    else if (ch === "\n") return i; // unterminated: stop at the line end
    else i++;
  }
  return source.length;
}

/** Index of the first character in `source` from `start` that fails `accept`. */
function scanWhile(source: string, start: number, accept: (ch: string) => boolean): number {
  let i = start;
  while (i < source.length && accept(source[i])) i++;
  return i;
}

/** Names and punctuators of `source`; comments, strings, numbers and commas are dropped. */
export function tokenizeGraphQL(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 0;
  let lineStart = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    let end = i + 1;
    if (ch === "#") end = scanWhile(source, i, (c) => c !== "\n");
    else if (ch === '"') end = stringEnd(source, i);
    else if (ch >= "0" && ch <= "9") end = scanWhile(source, i, (c) => isNameChar(c) || c === ".");
    else if (isNameStart(ch)) {
      end = scanWhile(source, i, isNameChar);
      tokens.push({ text: source.slice(i, end), isName: true, line, col: i - lineStart });
    } else if (source.startsWith("...", i)) {
      end = i + 3;
      tokens.push({ text: "...", isName: false, line, col: i - lineStart });
    } else if (PUNCTUATORS.has(ch)) {
      tokens.push({ text: ch, isName: false, line, col: i - lineStart });
    }
    // Strings span lines: count every newline consumed (bounded by `end`, so linear overall).
    for (let j = i; j < end; j++) {
      if (source[j] === "\n") {
        line++;
        lineStart = j + 1;
      }
    }
    i = end;
  }
  return tokens;
}

interface Definition {
  keyword: string;
  /** null for `schema` and `directive` definitions */
  node: CallGraphNode | null;
  /** True once the `{...}` body closed: a later top-level `{` is an anonymous query */
  bodyClosed: boolean;
}

interface Reference {
  sourceId: string;
  name: string;
  relation: RelationType;
  line: number;
}

interface ParseState {
  readonly tokens: Token[];
  readonly filePath: string;
  readonly folder: string;
  k: number;
  braceDepth: number;
  /** `(...)` nesting: a keyword inside arguments or variables is a value, not a definition */
  parenDepth: number;
  /** parenDepth of the open `@directive(...)` argument list, 0 when none: its values are never types */
  directiveParen: number;
  def: Definition | null;
  readonly nodes: CallGraphNode[];
  readonly refs: Reference[];
}

/** Add the node of a `keyword` definition named `name` at `token`; an operation also USES its root type. */
function addNode(state: ParseState, keyword: string, name: string, token: Token): CallGraphNode {
  const node: CallGraphNode = {
    id: `${state.filePath}:${name}:${token.line}`,
    name,
    type: SYMBOL_TYPE_BY_KEYWORD[keyword],
    lang: "graphql",
    path: state.filePath,
    folder: state.folder,
    startLine: token.line,
    endLine: token.line,
    startCol: token.col,
    // GraphQL has no modules: every definition is visible document-wide.
    isExported: true,
  };
  state.nodes.push(node);
  const rootType = ROOT_TYPE_BY_OPERATION[keyword];
  if (rootType) state.refs.push({ sourceId: node.id, name: rootType, relation: "USES", line: token.line });
  return node;
}

/** Node name of an unnamed operation; the spec allows one per document, so the name is unique. */
function anonymousName(keyword: string): string {
  return `(anonymous ${keyword})`;
}

function startDefinition(state: ParseState): void {
  const { tokens } = state;
  let k = state.k;
  if (tokens[k].text === "extend") k++;
  const keyword = tokens[k]?.text ?? "";
  const nameToken = tokens[k + 1];
  let node: CallGraphNode | null = null;
  if (SYMBOL_TYPE_BY_KEYWORD[keyword] && nameToken?.isName) {
    node = addNode(state, keyword, nameToken.text, nameToken);
    k++;
  } else if (ROOT_TYPE_BY_OPERATION[keyword]) {
    node = addNode(state, keyword, anonymousName(keyword), tokens[k]);
  }
  state.k = k;
  state.def = { keyword, node, bodyClosed: false };
}

/** Text of the token before `k`, skipping list brackets (`[User!]`) when `skipLists`. */
function previousText(tokens: Token[], k: number, skipLists = false): string {
  let i = k - 1;
  while (skipLists && tokens[i]?.text === "[") i--;
  return tokens[i]?.text ?? "";
}

/** `...Name` spread, `... on Type` inline fragment, or `fragment F on Type` condition. */
function fragmentRelation(state: ParseState, def: Definition, previous: string): RelationType | null {
  const { tokens, k } = state;
  if (previous === "...") return tokens[k].text === "on" ? null : "CALLS";
  const inlineFragment = previousText(tokens, k - 1) === "...";
  return inlineFragment || (state.braceDepth === 0 && def.keyword === "fragment") ? "USES" : null;
}

/** `implements A & B` and `union U = A | B` in a type-system definition header. */
function headerRelation(state: ParseState, def: Definition, previous: string): RelationType | null {
  if (state.braceDepth !== 0 || EXECUTABLE_KEYWORDS.has(def.keyword)) return null;
  if (previous === "implements" || previous === "&") return "IMPLEMENTS";
  if (def.keyword === "union" && (previous === "=" || previous === "|")) return "USES";
  return null;
}

/** Relation from the current definition to the name token at `state.k`, or null. */
function relationOf(state: ParseState, def: Definition): RelationType | null {
  const { tokens, k } = state;
  const previous = previousText(tokens, k);
  if (previous === "..." || previous === "on") return fragmentRelation(state, def, previous);
  if (previousText(tokens, k, true) !== ":") return headerRelation(state, def, previous);
  // Inside an operation, `name: value` is an alias or an argument: only header variables carry types.
  return !EXECUTABLE_KEYWORDS.has(def.keyword) || state.braceDepth === 0 ? "USES" : null;
}

function trackParens(state: ParseState, text: string): void {
  if (text === "(") {
    state.parenDepth++;
    if (state.directiveParen === 0 && previousText(state.tokens, state.k - 1) === "@") state.directiveParen = state.parenDepth;
  } else if (text === ")") {
    if (state.parenDepth === state.directiveParen) state.directiveParen = 0;
    state.parenDepth = Math.max(0, state.parenDepth - 1);
  }
}

function trackBraces(state: ParseState, text: string): void {
  if (text === "{") state.braceDepth++;
  else if (text === "}") {
    state.braceDepth = Math.max(0, state.braceDepth - 1);
    if (state.braceDepth === 0 && state.def) state.def.bodyClosed = true;
  }
}

function readToken(state: ParseState): void {
  const token = state.tokens[state.k];
  if (token.text === "{" && state.braceDepth === 0 && (!state.def || state.def.bodyClosed)) {
    // Query shorthand: `{ ... }` with no keyword.
    state.def = { keyword: "query", node: addNode(state, "query", anonymousName("query"), token), bodyClosed: false };
  }
  const def = state.def;
  if (def?.node) def.node.endLine = token.line;
  trackParens(state, token.text);
  trackBraces(state, token.text);
  if (!token.isName || !def?.node || state.directiveParen > 0) return;
  // `@name` is a directive, never a type.
  if (previousText(state.tokens, state.k) === "@") return;
  const relation = relationOf(state, def);
  if (relation) state.refs.push({ sourceId: def.node.id, name: token.text, relation, line: token.line });
}

/**
 * Edges of `refs`: a name defined in the file wins, else an `@@external:` stub.
 * Fragments and types are separate namespaces, as in CallGraphIndexer's inGraphQLNamespace:
 * a spread (CALLS) reaches operations/fragments, every other relation reaches types.
 */
function toEdges(nodes: CallGraphNode[], refs: Reference[]): CallGraphEdge[] {
  const local = new Map<string, string>();
  const key = (executable: boolean, name: string) => `${executable}\0${name}`;
  for (const node of nodes) {
    const nodeKey = key(node.type === "function", node.name);
    if (!local.has(nodeKey)) local.set(nodeKey, node.id);
  }
  const seen = new Set<string>();
  const edges: CallGraphEdge[] = [];
  for (const ref of refs) {
    const targetId = local.get(key(ref.relation === "CALLS", ref.name)) ?? `@@external:${ref.name}`;
    const edgeKey = `${ref.sourceId}::${targetId}::${ref.relation}`;
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);
    edges.push({ sourceId: ref.sourceId, targetId, typeRelation: ref.relation, sourceLine: ref.line });
  }
  return edges;
}

/**
 * Call graph nodes and edges of a GraphQL document.
 *
 * @param source - Document text
 * @param filePath - Normalized absolute path (node ids and `path`)
 * @param folder - Workspace-relative folder of the file
 */
export function extractGraphQL(source: string, filePath: string, folder: string): { nodes: CallGraphNode[]; edges: CallGraphEdge[] } {
  const state: ParseState = { tokens: tokenizeGraphQL(source), filePath, folder, k: 0, braceDepth: 0, parenDepth: 0, directiveParen: 0, def: null, nodes: [], refs: [] };
  for (; state.k < state.tokens.length; state.k++) {
    const token = state.tokens[state.k];
    const topLevel = state.braceDepth === 0 && state.parenDepth === 0;
    if (topLevel && token.isName && DEFINITION_KEYWORDS.has(token.text)) startDefinition(state);
    else readToken(state);
  }
  return { nodes: state.nodes, edges: toEdges(state.nodes, state.refs) };
}
