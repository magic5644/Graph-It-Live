/**
 * A bare name no import binds is never guessed across the workspace: in a TS/JS ES module it reaches a same-file
 * declaration only, and no bare name reaches a Vue SFC component node (named after its file).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTreeSitterHarness } from "./treeSitterHarness";

let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
beforeAll(async () => { harness = await createTreeSitterHarness("unimported-names-"); });
afterAll(() => harness.dispose());

const HOMONYMS = {
  "src/icons/error.vue": "<template><svg/></template>\n<script setup lang=\"ts\">\n</script>\n",
  "src/icons/Map.vue": "<template><svg/></template>\n<script setup lang=\"ts\">\n</script>\n",
  "src/icons/Promise.vue": "<template><svg/></template>\n<script setup lang=\"ts\">\n</script>\n",
  "src/other/err.ts": "export class Error {}\nexport class Promise {}\nexport function cb() {}\n",
};

it("links no builtin, parameter or unimported name of an ES module to a homonym of another file", async () => {
  const { edges } = await harness.index({
    ...HOMONYMS,
    "src/a.ts": [
      "export function main(x: number, cb: () => void): Promise<number> {",
      "  const m = new Map();",
      "  cb();",
      "  if (!x) throw new Error('x');",
      "  return Promise.resolve(m.size);",
      "}",
      "export class C extends Error implements Map<string, number> {}",
    ].join("\n"),
  });
  expect(edges.filter(edge => edge.startsWith("src/a.ts")).sort()).toEqual(["src/a.ts#C -USES@6-> src/a.ts#C"]);
});

it("keeps imported names, same-file declarations and script globals linked", async () => {
  const { edges } = await harness.index({
    ...HOMONYMS,
    "src/ext.ts": "export class Base {}\n",
    "src/b.ts": [
      "import { Base } from './ext';",
      "import { Error } from './other/err';",
      "class Local {}",
      "export class D extends Base { f(): Local { throw new Error(); } }",
    ].join("\n"),
    "lib/helpers.js": "function helper() {}\n",
    "lib/run.js": "function run() { helper(); }\n",
  });
  expect(edges.filter(edge => !edge.startsWith("src/ext.ts") && !edge.startsWith("src/other")).sort()).toEqual([
    "lib/run.js#run -CALLS@0-> lib/helpers.js#helper",
    "src/b.ts#D -INHERITS@3-> src/ext.ts#Base",
    "src/b.ts#D -USES@3-> src/b.ts#D",
    "src/b.ts#Local -USES@2-> src/b.ts#Local",
    "src/b.ts#f -CALLS@3-> src/other/err.ts#Error",
    "src/b.ts#f -USES@3-> src/b.ts#Local",
  ]);
});

it("links no bare name of a script file to a Vue component node", async () => {
  const { edges } = await harness.index({
    "src/icons/Error.vue": "<template><svg/></template>\n<script setup>\n</script>\n",
    "src/run.ts": "function run() { throw new Error('x'); }\n",
  });
  expect(edges).toEqual([]);
});

it("links no Python builtin to a homonym of another file", async () => {
  const { edges } = await harness.index({
    "py/exc.py": "class Exception:\n    pass\n",
    "py/m.py": "class E(Exception):\n    pass\n\ndef f():\n    raise Exception()\n",
  });
  expect(edges.filter(edge => edge.startsWith("py/m.py"))).toEqual([]);
});
