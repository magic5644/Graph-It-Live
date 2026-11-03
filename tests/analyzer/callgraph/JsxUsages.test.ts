import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grammarOf } from "@/analyzer/callgraph/GraphExtractor";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { createTreeSitterHarness, SQL_WASM_PATH } from "./treeSitterHarness";

describe("grammarOf", () => {
  it("parses .tsx and .jsx, in any case, with the tsx grammar", () => {
    expect(grammarOf("typescript", "src/Page.tsx")).toBe("tsx");
    expect(grammarOf("javascript", "src/Old.jsx")).toBe("tsx");
    expect(grammarOf("typescript", String.raw`C:\repo\src\PAGE.TSX`)).toBe("tsx");
  });

  it("keeps other TS/JS files, Vue, Svelte and other languages on their own grammar", () => {
    for (const file of ["a.ts", "a.mts", "a.cts", "App.vue", "App.svelte"]) expect(grammarOf("typescript", file)).toBe("typescript");
    for (const file of ["a.js", "a.mjs", "a.cjs"]) expect(grammarOf("javascript", file)).toBe("javascript");
    expect(grammarOf("python", "a.tsx")).toBe("python");
  });
});

describe("JSX usages in the call graph", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
  let root: string;
  const index = (files: Record<string, string>, savePath?: string) => harness.index(files, savePath);

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-jsx-");
    root = harness.root;
  });
  afterAll(() => harness.dispose());

  const ISSUE_FIXTURE = {
    "src/ui/Card.tsx": "export function Card() { return <section />; }\nexport default function Panel() { return <aside />; }\n",
    "src/ui/index.ts": "export * from './Card';\n",
    "src/hooks.ts": "export function useCounter() { return 1; }\nexport function track(_e: string) {}\n",
    "src/Page.tsx": `import * as UI from './ui';
import Panel from './ui/Card';
import { useCounter, track } from './hooks';
export function Page({ show }: { show: boolean }) {
  const n = useCounter();
  return (
    <main>
      {show && <UI.Card />}
      <Panel />
      <button onClick={() => track('x')}>{n}</button>
    </main>
  );
}
export function Later() { return useCounter(); }
`,
    "src/Old.jsx": "import { Card } from './ui/Card';\nexport function Old() { return <div><Card /></div>; }\n",
  };

  it("indexes every component of a .tsx/.jsx file with its line range and links its JSX, calls and handlers", async () => {
    const { nodes, edges } = await index(ISSUE_FIXTURE);

    expect(nodes).toEqual(expect.arrayContaining([
      { key: "src/Page.tsx#Page", lang: "typescript", startLine: 3, endLine: 12 },
      { key: "src/Page.tsx#Later", lang: "typescript", startLine: 13, endLine: 13 },
      { key: "src/ui/Card.tsx#Card", lang: "typescript", startLine: 0, endLine: 0 },
      { key: "src/ui/Card.tsx#Panel", lang: "typescript", startLine: 1, endLine: 1 },
      { key: "src/Old.jsx#Old", lang: "javascript", startLine: 1, endLine: 1 },
    ]));
    expect(edges.filter(e => e.startsWith("src/Page.tsx#Page ")).sort()).toEqual([
      "src/Page.tsx#Page -CALLS@4-> src/hooks.ts#useCounter",
      "src/Page.tsx#Page -CALLS@9-> src/hooks.ts#track",
      "src/Page.tsx#Page -REFERENCES@7-> src/ui/Card.tsx#Card",
      "src/Page.tsx#Page -REFERENCES@8-> src/ui/Card.tsx#Panel",
    ]);
    expect(edges).toContain("src/Old.jsx#Old -REFERENCES@1-> src/ui/Card.tsx#Card");
    expect(edges).toContain("src/Page.tsx#Later -CALLS@13-> src/hooks.ts#useCounter");
  });

  it("returns the same components and JSX edges from a reloaded (warm) index as from the cold run", async () => {
    const dbPath = path.join(root, "callgraph.db");
    const cold = await index(ISSUE_FIXTURE, dbPath);
    const warm = new CallGraphIndexer(SQL_WASM_PATH);
    try {
      await expect(warm.loadFromFile(dbPath)).resolves.toBe(true);
      const reloaded = harness.describe(warm);

      expect(reloaded.nodes).toEqual(cold.nodes);
      expect(reloaded.edges.sort()).toEqual([...cold.edges].sort());
      expect(reloaded.edges).toContain("src/Page.tsx#Page -REFERENCES@7-> src/ui/Card.tsx#Card");
    } finally {
      warm.dispose();
    }
  });

  const NULL_COMPONENTS = "export const Card = () => null;\nexport function Panel() { return null; }\nexport function C() { return null; }\n";

  it.each([
    {
      // `<Tabs.Panel />` is whatever `Tabs` holds: a same-file `Panel` is only a homonym, never guessed (#575).
      title: "keeps intrinsic, namespaced and custom elements, fragments and unresolved members out of the graph",
      file: "src/Tags.tsx",
      source: `export function Tags() {
  return (<>
    <div><span /></div>
    <svg:rect />
    <my-element />
    <Tabs.Panel />
    <A.B.C />
  </>);
}
export function Panel() { return null; }
export function C() { return null; }
`,
      expected: [],
    },
    {
      title: "links paired, self-closing, nested, conditional and ternary JSX once per target",
      file: "src/Shell.tsx",
      source: `import { Card, Panel } from './parts';
export function Shell({ a }: { a: boolean }) {
  return (
    <Card title="t">
      {a ? <Panel /> : null}
      <Card><Panel></Panel></Card>
    </Card>
  );
}
`,
      expected: ["src/Shell.tsx#Shell -REFERENCES@3-> src/parts.tsx#Card", "src/Shell.tsx#Shell -REFERENCES@4-> src/parts.tsx#Panel"],
    },
    {
      title: "follows a component's local binding: a parameter shadowing an import or a type-only import links nowhere",
      file: "src/Wrap.tsx",
      source: `import type { Card } from './parts';
import { Panel } from './parts';
export function Wrap() { return <Card />; }
export function Pass({ Panel }: { Panel: () => null }) { return <Panel />; }
export function Uses() { return <Panel />; }
`,
      expected: ["src/Wrap.tsx#Uses -REFERENCES@4-> src/parts.tsx#Panel"],
    },
    {
      title: "links a .jsx component to a same-file component without an import",
      file: "src/Local.jsx",
      source: "function Item() { return <li />; }\nexport function List() { return <ul><Item /></ul>; }\n",
      expected: ["src/Local.jsx#List -REFERENCES@1-> src/Local.jsx#Item"],
    },
    {
      title: "references a handler passed as a value and calls the one written in an arrow, at their lines",
      file: "src/Form.tsx",
      source: `function save() {}
function track() {}
export function Form() {
  return <form onSubmit={save}>
    <button onClick={() => track()} />
  </form>;
}
`,
      expected: ["src/Form.tsx#Form -CALLS@4-> src/Form.tsx#track", "src/Form.tsx#Form -REFERENCES@3-> src/Form.tsx#save"],
    },
    {
      // `props.save` is whatever the parent passed: only `this.save` is known to be in this file.
      title: "links a this.method handler, never a props member to a same-name function",
      file: "src/Btn.tsx",
      source: `function save() {}
export class Btn {
  handle() {}
  render() { return <b onClick={this.handle} onBlur={this.props.save} />; }
}
export function Fn(props: { save: () => void }) { return <b onClick={props.save} />; }
`,
      expected: ["src/Btn.tsx#render -REFERENCES@3-> src/Btn.tsx#handle"],
    },
    {
      // Each `<Item />` is the `Item` of its own function, by scope; `C` and `Card` are declared in another file only.
      title: "resolves same-name local components by scope, and never guesses an unimported name declared elsewhere",
      file: "src/Dup.tsx",
      source: `export function A() { function Item() { return null; } return <Item />; }
export function B() { function Item() { return null; } return <Item render={Item} />; }
export function Other() { return <C onClick={Card} />; }
`,
      expected: ["src/Dup.tsx#A -REFERENCES@0-> src/Dup.tsx#Item", "src/Dup.tsx#B -REFERENCES@1-> src/Dup.tsx#Item"],
    },
    {
      title: "declares memo, forwardRef and lazy components, bare or as React.*, with var or const",
      file: "src/Wrapped.tsx",
      source: `import { Card } from './parts';
export const A = memo(function A() { return <Card />; });
export const B = React.forwardRef(() => <A />);
var L = React.lazy(() => import(name));
export function Use() { return <><B /><L /></>; }
`,
      expected: [
        "src/Wrapped.tsx#A -REFERENCES@1-> src/parts.tsx#Card",
        "src/Wrapped.tsx#B -REFERENCES@2-> src/Wrapped.tsx#A",
        "src/Wrapped.tsx#Use -REFERENCES@4-> src/Wrapped.tsx#B",
        "src/Wrapped.tsx#Use -REFERENCES@4-> src/Wrapped.tsx#L",
      ],
    },
  ])("$title", async ({ file, source, expected }) => {
    const { edges } = await index({ [file]: source, "src/parts.tsx": NULL_COMPONENTS });

    // A class name is also a type: its type-only USES edge is not what these cases check.
    expect(edges.filter(e => e.startsWith(`${file}#`) && !e.includes(" -USES@")).sort()).toEqual(expected);
  });

  it("keeps .ts files on the TypeScript grammar, where `<T>x` is a type assertion, not JSX", async () => {
    const { nodes, edges } = await index({
      "src/cast.ts": `function wrap<T>(x: T) { return x; }
export function cast(v: unknown) { return <string>wrap(v); }
export const ident = <T,>(x: T) => wrap(x);
`,
    });

    expect(nodes.map(n => n.key).sort()).toEqual(["src/cast.ts#cast", "src/cast.ts#ident", "src/cast.ts#wrap"]);
    expect(edges.sort()).toEqual([
      "src/cast.ts#cast -CALLS@1-> src/cast.ts#wrap",
      "src/cast.ts#ident -CALLS@2-> src/cast.ts#wrap",
    ]);
  });
});
