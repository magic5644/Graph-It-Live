/**
 * A function passed as an argument is a REFERENCES edge in every call graph language (#575): passed, not
 * called there. It links through an import, a scope or a single same-file declaration only, never a guess:
 * parameters, local variables, builtins and members of anything but `this`/`self` link nowhere.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARGUMENT_CASES } from "./argumentCorpus";
import { createTreeSitterHarness } from "./treeSitterHarness";

describe("function references passed as arguments", () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;

  beforeAll(async () => {
    harness = await createTreeSitterHarness("gil-args-");
  });
  afterAll(() => harness.dispose());

  it.each(ARGUMENT_CASES)("$lang: references a passed function exactly, at its line", async ({ files, source, expected }) => {
    const { edges } = await harness.index(files);

    expect(edges.filter((edge) => edge.startsWith(source) && !edge.includes(" -USES@")).sort()).toEqual(expected);
  });

  it("links each same-name local component to the one of its own scope", async () => {
    const indexer = await harness.newIndexer();
    try {
      await harness.indexInto(indexer, {
        "src/Dup.tsx": "export function A() { function Item() { return null; } return <Item />; }\nexport function B() { function Item() { return null; } return <Item />; }\n",
      });
      const { nodes, edges } = indexer.getIndexSnapshot();
      const lineOf = (id: string) => nodes.find((n) => n.id === id)?.startLine;

      expect(edges.map((e) => [lineOf(e.sourceId), e.typeRelation, lineOf(e.targetId)]).sort()).toEqual([[0, "REFERENCES", 0], [1, "REFERENCES", 1]]);
    } finally {
      indexer.dispose();
    }
  });
});
