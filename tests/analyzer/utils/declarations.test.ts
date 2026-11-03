import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ONLY, defaultExportName, findDeclaration, isComponentFactory } from "@/analyzer/utils/declarations";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { normalizePath } from "@/shared/path";
import { writeFiles } from "../callgraph/treeSitterHarness";

describe("defaultExportName", () => {
  it.each([
    ["a default function", "export default function Panel() {}", "Panel"],
    ["a default class", "export default class Panel {}", "Panel"],
    ["a default async function", "export default async function load() {}", "load"],
    ["a local identifier", "function Panel() {}\nexport default Panel;", "Panel"],
    ["a local identifier in parentheses or with a cast", "const Panel = () => null;\nexport default (Panel as unknown);", "Panel"],
    ["a memo-wrapped local", "function Panel() {}\nexport default memo(Panel);", "Panel"],
    ["nested React.memo(forwardRef())", "function Panel() {}\nexport default React.memo(React.forwardRef(Panel));", "Panel"],
    ["a local export as default", "class Panel {}\nexport { Panel as default };", "Panel"],
  ])("returns the declared name of %s", (_title, source, expected) => {
    expect(defaultExportName("/ws/Panel.tsx", source)).toBe(expected);
  });

  it.each([
    ["an anonymous default arrow", "export default () => null;"],
    ["an anonymous default function", "export default function () {}"],
    ["an unknown wrapper", "function Panel() {}\nexport default withRouter(Panel);"],
    ["a lazy() default", "export default lazy(() => import('./Panel'));"],
    ["a default of an import", "import Panel from './Panel';\nexport default Panel;"],
    ["a default re-export", "export { default } from './Panel';"],
    ["a renamed re-export as default", "export { Panel as default } from './Panel';"],
    ["a default of a member", "const ui = { Panel() {} };\nexport default ui.Panel;"],
    ["export =", "function Panel() {}\nexport = Panel;"],
    ["no default export", "export function Panel() {}"],
  ])("returns undefined for %s", (_title, source) => {
    expect(defaultExportName("/ws/Panel.tsx", source)).toBeUndefined();
  });
});

describe("isComponentFactory", () => {
  it.each(["memo", "forwardRef", "lazy", "React.memo", "React.forwardRef", "React.lazy"])("accepts %s", (callee) => {
    expect(isComponentFactory(callee)).toBe(true);
  });

  it.each(["withRouter", "connect", "Preact.memo", "memoize", "useMemo", "React.createElement"])("rejects %s", (callee) => {
    expect(isComponentFactory(callee)).toBe(false);
  });
});

describe("findDeclaration", () => {
  let root: string;
  const resolver = () => new PathResolver(undefined, true, root);
  const file = (relative: string) => normalizePath(path.join(root, relative));
  const find = (relative: string, name: string) => findDeclaration(path.join(root, relative), name, resolver(), new Map());

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-decl-")));
    await writeFiles(root, {
      "Card.tsx": "export function Card() {}\nexport default function Panel() {}\n",
      "Anon.tsx": "export default () => null;\n",
      "Button.jsx": "export class Button {}\n",
      "index.ts": "export * from './Card';\nexport * from './Button';\nexport { default as Panel } from './Card';\nexport { default as Anon } from './Anon';\n",
      "cycle-a.ts": "export * from './cycle-b';\n",
      "cycle-b.ts": "export * from './cycle-a';\n",
      "cjs.js": "module.exports = { a: 1 };\n",
      "Other.tsx": "export function Card() {}\n",
      "twoStars.ts": "export * from './Card';\nexport * from './Other';\n",
      "namedWins.ts": "export * from './Card';\nexport { Card } from './Other';\n",
      "diamondA.ts": "export * from './Card';\n",
      "diamondB.ts": "export * from './Card';\n",
      "diamond.ts": "export * from './diamondA';\nexport * from './diamondB';\n",
      "node_modules/pkg/index.js": "export function a() {}\n",
    });
  });
  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  it.each([
    ["a named declaration", "Card.tsx", "Card", { file: "Card.tsx", name: "Card" }],
    ["a default export, by its declared name", "Card.tsx", "default", { file: "Card.tsx", name: "Panel" }],
    ["a name of the second `export *` module", "index.ts", "Button", { file: "Button.jsx", name: "Button" }],
    ["a default re-exported under a name", "index.ts", "Panel", { file: "Card.tsx", name: "Panel" }],
    ["an anonymous default re-exported under a name", "index.ts", "Anon", null],
    ["an anonymous default, as is", "Anon.tsx", "default", { file: "Anon.tsx", name: "default" }],
    ["a name no module of an `export *` cycle declares", "cycle-a.ts", "x", null],
    ["a module without re-exports imported directly, unparsed", "cjs.js", "a", { file: "cjs.js", name: "a" }],
    ["a module in node_modules", "node_modules/pkg/index.js", "a", null],
    ["a missing file", "missing.ts", "a", null],
    ["a name two `export *` modules declare: ambiguous", "twoStars.ts", "Card", null],
    ["a named re-export over an `export *` of the same name", "namedWins.ts", "Card", { file: "Other.tsx", name: "Card" }],
    ["a name two `export *` paths reach in the same module", "diamond.ts", "Card", { file: "Card.tsx", name: "Card" }],
  ])("resolves %s", async (_title, relative, name, expected) => {
    const found = await find(relative, name);

    expect(found).toEqual(expected && { filePath: file(expected.file), name: expected.name });
  });

  it("reports the local name of a default export imported by name as default-only", async () => {
    expect(await find("Card.tsx", "Panel")).toBe(DEFAULT_ONLY);
  });

  it("records every module it read", async () => {
    const reads = new Map<string, Promise<string | null>>();

    await findDeclaration(path.join(root, "index.ts"), "Button", resolver(), reads);

    expect([...reads.keys()].sort()).toEqual([file("Button.jsx"), file("Card.tsx"), file("index.ts")]);
  });
});
