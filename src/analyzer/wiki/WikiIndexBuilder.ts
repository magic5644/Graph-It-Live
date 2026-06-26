import type { WikiArticle, WikiGenerateResult } from "../../shared/wiki-types.js";

export class WikiIndexBuilder {
  buildIndex(articles: WikiArticle[]): WikiArticle[] {
    return [...articles].sort((a, b) => b.hubScore - a.hubScore);
  }

  topHubs(
    articles: WikiArticle[],
    n = 10,
  ): WikiGenerateResult["topHubs"] {
    return this.buildIndex(articles)
      .slice(0, n)
      .map((a) => ({ name: a.title, score: a.hubScore }));
  }
}
