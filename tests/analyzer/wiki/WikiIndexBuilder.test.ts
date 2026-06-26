import { describe, it, expect } from "vitest";
import { WikiIndexBuilder } from "../../../src/analyzer/wiki/WikiIndexBuilder.js";
import type { WikiArticle } from "../../../src/shared/wiki-types.js";

function makeArticle(title: string, hubScore: number, filePath = `/ws/${title}.ts`): WikiArticle {
  return {
    title,
    filePath,
    articlePath: `/out/articles/${title}.md`,
    hubScore,
    symbols: [],
    callers: [],
    callees: [],
  };
}

describe("WikiIndexBuilder", () => {
  it("buildIndex sorts by hubScore descending", () => {
    const builder = new WikiIndexBuilder();
    const articles = [
      makeArticle("a", 10),
      makeArticle("b", 90),
      makeArticle("c", 50),
    ];
    const sorted = builder.buildIndex(articles);
    expect(sorted.map((a) => a.hubScore)).toEqual([90, 50, 10]);
  });

  it("buildIndex does not mutate input", () => {
    const builder = new WikiIndexBuilder();
    const articles = [makeArticle("a", 10), makeArticle("b", 90)];
    builder.buildIndex(articles);
    expect(articles[0].title).toBe("a"); // original order preserved
  });

  it("topHubs returns top N by score", () => {
    const builder = new WikiIndexBuilder();
    const articles = [
      makeArticle("a", 20),
      makeArticle("b", 80),
      makeArticle("c", 60),
      makeArticle("d", 40),
    ];
    const top2 = builder.topHubs(articles, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0].name).toBe("b");
    expect(top2[0].score).toBe(80);
    expect(top2[1].name).toBe("c");
  });

  it("topHubs defaults to 10", () => {
    const builder = new WikiIndexBuilder();
    const articles = Array.from({ length: 15 }, (_, i) => makeArticle(`f${i}`, i * 5));
    const top = builder.topHubs(articles);
    expect(top).toHaveLength(10);
  });

  it("topHubs handles empty list", () => {
    const builder = new WikiIndexBuilder();
    expect(builder.topHubs([])).toEqual([]);
  });
});
