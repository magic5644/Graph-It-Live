/**
 * Shared React corpus (#575): JS/JSX/TS/TSX files covering function, class, default and named components,
 * aliases, barrels, namespace JSX, hooks, memo/forwardRef/lazy, handlers, render props, unresolved and
 * ambiguous components. Both analyzer pipelines (ts-morph and tree-sitter) and every surface (CLI, MCP,
 * LM tools) must report the same edges for it.
 */
export const REACT_CORPUS: Record<string, string> = {
  "src/ui/Card.tsx": `export function Card() { return <section />; }
export default function Panel() { return <aside />; }
`,
  "src/ui/Button.jsx": `import React from 'react';
export class Button extends React.Component { render() { return <button />; } }
`,
  "src/ui/index.ts": `export * from './Card';
export { Button } from './Button';
`,
  "src/hooks.js": `export function useCounter() { return 1; }
export function track(_e) {}
export function save() {}
`,
  "src/Fancy.tsx": `import { memo, forwardRef } from 'react';
import { Card } from './ui';
export const Fancy = memo(function Fancy() { return <Card />; });
export const Field = forwardRef(function Field() { return <input />; });
`,
  "src/Page.tsx": `import * as UI from './ui';
import { Card as Tile } from './ui';
import Panel from './ui/Card';
import { lazy } from 'react';
import { useCounter, track, save } from './hooks';
import { Fancy, Field } from './Fancy';
const Lazy = lazy(() => import('./ui/Card'));
const Dynamic = lazy(() => import(\`./ui/\${'Card'}\`));
function Row() { return <li />; }
export function Page({ show, Slot }: { show: boolean; Slot: () => null }) {
  const n = useCounter();
  return (
    <main>
      {show && <UI.Card />}
      <Tile />
      <Panel />
      <UI.Button />
      <Fancy />
      <Field />
      <Lazy />
      <Dynamic />
      <Slot />
      <Missing />
      <List render={Row} />
      <button onClick={save}>a</button>
      <button onClick={() => track('x')}>{n}</button>
    </main>
  );
}
`,
  "src/Old.jsx": `import { Card } from './ui/Card';
export function Old() { return <div><Card /></div>; }
`,
  "src/other.tsx": `export function Missing() { return null; }
`,
};

/**
 * `source -RELATION@line-> target` edges both pipelines report for the corpus, with 1-based lines and workspace
 * symbols only (`react` is outside the workspace). A plain call is `CALLS`.
 * Not linked: `<Missing />` (not imported, a homonym elsewhere is never guessed), `<Slot />` (a parameter),
 * `<List />` (undeclared), `Dynamic`'s non-literal `import()`, intrinsic tags and the memo/forwardRef/lazy wrappers.
 */
export const REACT_CORPUS_EDGES = [
  "src/Fancy.tsx#Fancy -REFERENCES@3-> src/ui/Card.tsx#Card",
  "src/Old.jsx#Old -REFERENCES@2-> src/ui/Card.tsx#Card",
  "src/Page.tsx#Lazy -REFERENCES@7-> src/ui/Card.tsx#Panel",
  "src/Page.tsx#Page -CALLS@11-> src/hooks.js#useCounter",
  "src/Page.tsx#Page -CALLS@26-> src/hooks.js#track",
  "src/Page.tsx#Page -REFERENCES@14-> src/ui/Card.tsx#Card",
  "src/Page.tsx#Page -REFERENCES@16-> src/ui/Card.tsx#Panel",
  "src/Page.tsx#Page -REFERENCES@17-> src/ui/Button.jsx#Button",
  "src/Page.tsx#Page -REFERENCES@18-> src/Fancy.tsx#Fancy",
  "src/Page.tsx#Page -REFERENCES@19-> src/Fancy.tsx#Field",
  "src/Page.tsx#Page -REFERENCES@20-> src/Page.tsx#Lazy",
  "src/Page.tsx#Page -REFERENCES@21-> src/Page.tsx#Dynamic",
  "src/Page.tsx#Page -REFERENCES@24-> src/Page.tsx#Row",
  "src/Page.tsx#Page -REFERENCES@25-> src/hooks.js#save",
];
