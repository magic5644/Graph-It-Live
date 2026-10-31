import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallGraphIndexer, inGraphQLNamespace } from "@/analyzer/callgraph/CallGraphIndexer";
import { fileExtToLang, GraphExtractor, getQueryFreshnessCutoffs } from "@/analyzer/callgraph/GraphExtractor";
import { extractGraphQL, tokenizeGraphQL } from "@/analyzer/callgraph/graphqlExtractor";
import { normalizePath } from "@/shared/path";

const FILE = "/ws/doc.graphql";
const SQL_WASM = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");

/** Edges of `source` as "Source -REL-> Target", external stubs shown as `@Name`. */
function edgesOf(source: string): string[] {
  const { nodes, edges } = extractGraphQL(source, FILE, "");
  const name = new Map(nodes.map((n) => [n.id, n.name]));
  return edges
    .map((e) => `${name.get(e.sourceId)} -${e.typeRelation}-> ${name.get(e.targetId) ?? e.targetId.replace("@@external:", "@")}`)
    .sort();
}

function namesOf(source: string): string[] {
  return extractGraphQL(source, FILE, "").nodes.map((n) => `${n.type}:${n.name}`);
}

describe("tokenizeGraphQL", () => {
  it("drops comments, strings, block strings, numbers and commas", () => {
    const source = [
      '# ...Hidden on Ghost',
      '"""Block ...Hidden \\""" still inside"""',
      'type A { f(n: Int = 1.5e3, s: String = "...Hidden"): B }',
    ].join("\n");
    expect(tokenizeGraphQL(source).map((t) => t.text).join(" ")).toBe("type A { f ( n : Int = s : String = ) : B }");
  });

  it("tracks 0-based lines and columns across multi-line strings", () => {
    const tokens = tokenizeGraphQL('"""a\nb"""\n  type X');
    expect(tokens.map((t) => [t.text, t.line, t.col])).toEqual([["type", 2, 2], ["X", 2, 7]]);
  });

  it.each([
    ["unterminated string", 'type A { f: "oops\n g: B }'],
    ["unterminated block string", 'type A { f: B } """never closed'],
    ["Windows line endings", "type A {\r\n  f: B\r\n}"],
  ])("does not throw on %s", (_title, source) => {
    expect(tokenizeGraphQL(source).some((t) => t.text === "B")).toBe(true);
  });
});

describe("extractGraphQL nodes", () => {
  it.each([
    ["query Q { a }", "function:Q"],
    ["mutation M { a }", "function:M"],
    ["subscription S { a }", "function:S"],
    ["fragment F on T { a }", "function:F"],
    ["type T { a: Int }", "class:T"],
    ["input I { a: Int }", "class:I"],
    ["interface N { id: ID }", "interface:N"],
    ["enum E { A B }", "type:E"],
    ["union U = A | B", "type:U"],
    ["scalar Date", "type:Date"],
    ["extend type T { b: Int }", "class:T"],
    ["{ a }", "function:(anonymous query)"],
    ["query ($id: ID) { a }", "function:(anonymous query)"],
    ["mutation { a }", "function:(anonymous mutation)"],
  ])("%s -> %s", (source, expected) => {
    expect(namesOf(source)).toEqual([expected]);
  });

  it.each([
    ["schema definition", "schema { query: Query mutation: Mutation }"],
    ["directive definition", "directive @auth(role: Role) on FIELD_DEFINITION | QUERY"],
    ["empty document", ""],
    ["only comments", "# fragment F on T { a }"],
    ["extend at end of file", "extend"],
  ])("gives no node and no edge for %s", (_title, source) => {
    expect(extractGraphQL(source, FILE, "")).toEqual({ nodes: [], edges: [] });
  });

  it("records the name position, the full span, the folder and exports every definition", () => {
    const [node] = extractGraphQL("\n\n  fragment F on T {\n  a\n}\n", FILE, "src/gql").nodes;
    expect(node).toEqual({
      id: `${FILE}:F:2`, name: "F", type: "function", lang: "graphql", path: FILE, folder: "src/gql",
      startLine: 2, endLine: 4, startCol: 11, isExported: true,
    });
  });
});

describe("extractGraphQL edges", () => {
  it.each<[string, string, string[]]>([
    ["fragment spread across files", "query GetUser { user { ...UserFields } }", ["GetUser -CALLS-> @UserFields", "GetUser -USES-> @Query"]],
    ["fragment type condition", "fragment UserFields on User { id }", ["UserFields -USES-> @User"]],
    ["spread of a fragment in the same file", "fragment A on T { id }\nquery Q { ...A }", ["A -USES-> @T", "Q -CALLS-> A", "Q -USES-> @Query"]],
    ["spread before the fragment definition", "query Q { ...A }\nfragment A on T { id }", ["A -USES-> @T", "Q -CALLS-> A", "Q -USES-> @Query"]],
    ["nested spreads, repeated once", "query Q { a { ...F b { ...F ...G } } }", ["Q -CALLS-> @F", "Q -CALLS-> @G", "Q -USES-> @Query"]],
    ["inline fragment type condition", "query Q { node { ... on User { id } } }", ["Q -USES-> @Query", "Q -USES-> @User"]],
    ["inline fragment without type condition", "query Q { a { ... @include(if: $x) { id } } }", ["Q -USES-> @Query"]],
    ["variable types, lists and non-null", "query Q($id: ID!, $ids: [[Key!]]) { a }", ["Q -USES-> @ID", "Q -USES-> @Key", "Q -USES-> @Query"]],
    ["aliases, arguments and enum values in a selection", "query Q { u: user(id: 1, status: ACTIVE, f: { a: B }) { id } }", ["Q -USES-> @Query"]],
    ["directives on a spread", "query Q { ...F @skip(if: $no) }", ["Q -CALLS-> @F", "Q -USES-> @Query"]],
    ["field named on", "query Q { on name }", ["Q -USES-> @Query"]],
    ["field types and argument types", "type T { f(a: In = DEFAULT): [Out!]! }", ["T -USES-> @In", "T -USES-> @Out"]],
    ["self reference", "type User { friends: [User!] }", ["User -USES-> User"]],
    ["implements with leading &", "type A implements & Node & Entity { id: ID }", ["A -IMPLEMENTS-> @Entity", "A -IMPLEMENTS-> @Node", "A -USES-> @ID"]],
    ["interface implementing an interface", "interface A implements Node { id: ID }", ["A -IMPLEMENTS-> @Node", "A -USES-> @ID"]],
    ["union members with leading |", "union R = | A | B", ["R -USES-> @A", "R -USES-> @B"]],
    ["field directive", "type T { a: Int @deprecated(reason: \"no\") }", ["T -USES-> @Int"]],
    ["enum values", "enum E { query type A }", []],
    ["keyword used as a variable type", "query Q($t: type) { a }\ntype B { b: C }", ["B -USES-> @C", "Q -USES-> @Query", "Q -USES-> @type"]],
    ["spread in a comment or a string", "query Q { a(s: \"...F\") # ...G\n }", ["Q -USES-> @Query"]],
    ["anonymous query after a fragment", "fragment A on T { id }\n{ ...B }", ["(anonymous query) -CALLS-> @B", "(anonymous query) -USES-> @Query", "A -USES-> @T"]],
    ["unnamed operation with variables", "query ($id: ID) { ...F }", ["(anonymous query) -CALLS-> @F", "(anonymous query) -USES-> @ID", "(anonymous query) -USES-> @Query"]],
    ["enum value in a type directive", "type T @auth(role: ADMIN) { a: Int @dir(x: Y) }", ["T -USES-> @Int"]],
    ["enum value in a variable directive", "query Q($x: T @dir(a: B)) { a }", ["Q -USES-> @Query", "Q -USES-> @T"]],
    ["nested parens inside a directive", "type T @d(a: [(B)], c: D) { e: F }", ["T -USES-> @F"]],
    ["fragment and type of the same name", "type User { id: ID }\nfragment User on User { id }\nquery Q { u: user { ...User } }", ["Q -CALLS-> User", "Q -USES-> @Query", "User -USES-> @ID", "User -USES-> User"]],
    ["mutation root type", "mutation M { a }", ["M -USES-> @Mutation"]],
    ["subscription root type", "subscription S { a }", ["S -USES-> @Subscription"]],
    ["root type defined in the same file", "type Query { a: Int }\nquery Q { a }", ["Q -USES-> Query", "Query -USES-> @Int"]],
    ["unbalanced closing brace", "query Q { a } }\nquery R { ...F }", ["Q -USES-> @Query", "R -CALLS-> @F", "R -USES-> @Query"]],
  ])("%s", (_title, source, expected) => {
    expect(edgesOf(source)).toEqual(expected);
  });

  it("links a spread to the fragment and a type condition to the type when both are named User", () => {
    const { edges } = extractGraphQL("type User { id: ID }\nfragment User on User { id }\nquery Q { ...User }", FILE, "");
    expect(edges.map((e) => `${e.sourceId} -${e.typeRelation}-> ${e.targetId}`)).toEqual([
      `${FILE}:User:0 -USES-> @@external:ID`,
      `${FILE}:User:1 -USES-> ${FILE}:User:0`,
      `${FILE}:Q:2 -USES-> @@external:Query`,
      `${FILE}:Q:2 -CALLS-> ${FILE}:User:1`,
    ]);
  });

  it("stays linear on a large single-line document", () => {
    const source = Array.from({ length: 20_000 }, (_, i) => `type T${i} { a: B${i} }`).join(" ");
    const started = performance.now();
    const { nodes, edges } = extractGraphQL(source, FILE, "");
    expect(nodes).toHaveLength(20_000);
    expect(edges).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("keeps the line of the reference", () => {
    const { edges } = extractGraphQL("query Q {\n  a {\n    ...F\n  }\n}", FILE, "");
    expect(edges).toEqual([
      { sourceId: `${FILE}:Q:0`, targetId: "@@external:Query", typeRelation: "USES", sourceLine: 0 },
      { sourceId: `${FILE}:Q:0`, targetId: "@@external:F", typeRelation: "CALLS", sourceLine: 2 },
    ]);
  });
});

describe("GraphQL in GraphExtractor", () => {
  it.each([
    ["/ws/a.graphql", "graphql"],
    ["/ws/a.gql", "graphql"],
    ["C:\\ws\\A.GQL", "graphql"],
    ["/ws/a.graphqls", null],
  ])("fileExtToLang(%s) = %s", (file, expected) => {
    expect(fileExtToLang(file)).toBe(expected);
  });

  it.each([
    ["Linux/macOS", "/ws", "/ws/api/ops.graphql"],
    ["Windows", String.raw`C:\ws`, String.raw`C:\ws\api\ops.graphql`],
  ])("extracts without tree-sitter WASM on %s paths", async (_os, root, file) => {
    const extractor = new GraphExtractor({ extensionPath: "/nonexistent", workspaceRoot: root });
    const { nodes, edges } = await extractor.extractSource(file, "graphql", "query Q { ...F }");
    expect(nodes.map((n) => [n.id, n.folder])).toEqual([[`${normalizePath(file)}:Q:0`, "api"]]);
    expect(edges.map((e) => e.targetId)).toEqual(["@@external:Query", "@@external:F"]);
  });

  it("has no query file, so no freshness cutoff", async () => {
    expect((await getQueryFreshnessCutoffs("/nonexistent")).graphql).toBe(0);
  });
});

describe("inGraphQLNamespace", () => {
  it.each([
    ["graphql", "CALLS", "function", true],
    ["graphql", "CALLS", "class", false],
    ["graphql", "USES", "class", true],
    ["graphql", "USES", "function", false],
    ["graphql", "IMPLEMENTS", "interface", true],
    ["typescript", "USES", "function", true],
    ["typescript", "CALLS", "class", true],
  ])("%s %s -> %s = %s", (lang, relation, type, expected) => {
    expect(inGraphQLNamespace(lang, relation, type)).toBe(expected);
  });
});

describe("GraphQL call graph across files (#523)", () => {
  let root: string;
  let run = 0;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-graphql-")));
    // TypeScript files of the cross-language case need the real grammar.
    await fs.mkdir(path.join(root, "dist/wasm"), { recursive: true });
    await fs.mkdir(path.join(root, "dist/queries"), { recursive: true });
    await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(root, "dist/wasm/tree-sitter.wasm"));
    await fs.copyFile("node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm", path.join(root, "dist/wasm/tree-sitter-typescript.wasm"));
    await fs.copyFile("resources/queries/typescript.scm", path.join(root, "dist/queries/typescript.scm"));
  });
  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  /** Index `files` (GraphQL and TypeScript) and return resolved edges as "file#Source -REL-> file#Target". */
  async function resolvedEdges(files: Record<string, string>): Promise<{ edges: string[]; nodes: string[] }> {
    const dir = path.join(root, `case${run++}`);
    const extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: dir });
    const indexer = new CallGraphIndexer(SQL_WASM);
    await indexer.init();
    for (const [name, source] of Object.entries(files)) {
      const file = normalizePath(path.join(dir, name));
      const lang = fileExtToLang(file);
      if (!lang) continue;
      const result = await extractor.extractSource(file, lang, source);
      indexer.indexFile(result.nodes, result.edges, file, lang, 1);
    }
    indexer.resolveExternalEdges();
    extractor.dispose();
    const snapshot = indexer.getIndexSnapshot();
    indexer.dispose();
    const label = new Map(snapshot.nodes.map((n) => [n.id, `${normalizePath(path.relative(dir, n.path))}#${n.name}`]));
    return {
      edges: snapshot.edges.map((e) => `${label.get(e.sourceId)} -${e.typeRelation}-> ${label.get(e.targetId)}`).sort(),
      nodes: [...label.values()].sort(),
    };
  }

  it("links the issue reproduction: operation -> fragment -> schema type", async () => {
    const { edges } = await resolvedEdges({
      "fragments.graphql": "fragment UserFields on User { id name }",
      "ops.graphql": "query GetUser { user { ...UserFields } }",
      "schema.graphql": "type Query { user: User }\ntype User { id: ID! name: String }",
    });
    expect(edges).toEqual([
      "fragments.graphql#UserFields -USES-> schema.graphql#User",
      "ops.graphql#GetUser -CALLS-> fragments.graphql#UserFields",
      "ops.graphql#GetUser -USES-> schema.graphql#Query",
      "schema.graphql#Query -USES-> schema.graphql#User",
    ]);
  });

  it("drops a spread of an unknown fragment and keeps an unused fragment as a node", async () => {
    const { edges, nodes } = await resolvedEdges({
      "ops.graphql": "query Q { ...Missing }",
      "unused.gql": "fragment Unused on Ghost { id }",
    });
    expect(edges).toEqual([]);
    expect(nodes).toEqual(["ops.graphql#Q", "unused.gql#Unused"]);
  });

  it("does not follow a renamed root type: the default-name edge is dropped (shortcut)", async () => {
    const { edges } = await resolvedEdges({
      "ops.graphql": "query Q { a }",
      "schema.graphql": "schema { query: Root }\ntype Root { a: Int }",
    });
    expect(edges).toEqual([]);
  });

  it("keeps fragments and types apart across files", async () => {
    const { edges } = await resolvedEdges({
      "schema.graphql": "type User { id: ID }",
      "fragments.graphql": "fragment User on User { id }",
      "ops.graphql": "query Q { ...User }",
    });
    expect(edges).toEqual([
      "fragments.graphql#User -USES-> schema.graphql#User",
      "ops.graphql#Q -CALLS-> fragments.graphql#User",
    ]);
  });

  it("resolves a duplicated fragment name to the closest file", async () => {
    const { edges } = await resolvedEdges({
      "a/ops.graphql": "query Q { ...F }",
      "a/f.graphql": "fragment F on T { id }",
      "b/f.graphql": "fragment F on T { id }",
    });
    expect(edges).toEqual(["a/ops.graphql#Q -CALLS-> a/f.graphql#F"]);
  });

  it("never links GraphQL to a same-name symbol of another language", async () => {
    const { edges } = await resolvedEdges({
      "ops.graphql": "query Q { ...UserFields }",
      "user.ts": "export function UserFields() { return 1; }\nexport function caller() { return UserFields(); }",
    });
    expect(edges).toEqual(["user.ts#caller -CALLS-> user.ts#UserFields"]);
  });
});
