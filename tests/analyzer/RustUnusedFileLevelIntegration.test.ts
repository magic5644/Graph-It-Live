import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import path from 'node:path';
import { normalizePath } from '../../src/shared/path';

describe('Rust Unused Dependencies Integration', () => {
  let spider: Spider;
  const fixtureRoot = path.resolve(__dirname, '../fixtures/rust-unused-deps');

  beforeAll(async () => {
    spider = new SpiderBuilder()
     .withRootDir(fixtureRoot)
     .withMaxDepth(20)
     .withExtensionPath(process.cwd())
     .build();
  });

  afterAll(async () => {
    await spider.dispose();
  });

  it('should crawl project and detect unused module at file level', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const result = await spider.crawl(mainPath);

    // Should include all three files
    expect(result.nodes.length).toBe(3);
    expect(result.nodes).toContain(normalizePath(mainPath));
    expect(result.nodes).toContain(normalizePath(path.join(fixtureRoot, 'helper.rs')));
    expect(result.nodes).toContain(normalizePath(path.join(fixtureRoot, 'unused.rs')));

    // Should have 2 edges (main -> helper, main -> unused)
    expect(result.edges.length).toBe(2);
  });

  it('should verify that unused.rs is not used', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const unusedPath = path.join(fixtureRoot, 'unused.rs');
    const helperPath = path.join(fixtureRoot, 'helper.rs');

    // Verify usage
    const unusedIsUsed = await spider.verifyDependencyUsage(mainPath, unusedPath);
    const helperIsUsed = await spider.verifyDependencyUsage(mainPath, helperPath);

    expect(unusedIsUsed).toBe(false); // unused.rs is NOT used
    expect(helperIsUsed).toBe(true);  // helper.rs IS used
  });

  it('should batch verify dependencies correctly', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const unusedPath = path.join(fixtureRoot, 'unused.rs');
    const helperPath = path.join(fixtureRoot, 'helper.rs');

    // Batch verify
    const usageMap = await spider.verifyDependencyUsageBatch(mainPath, [unusedPath, helperPath]);

    expect(usageMap.get(normalizePath(unusedPath))).toBe(false);
    expect(usageMap.get(normalizePath(helperPath))).toBe(true);
  });

  it('should return correct unusedEdges list after crawl', async () => {
    const mainPath = path.join(fixtureRoot, 'main.rs');
    const result = await spider.crawl(mainPath);
    
    // Group edges by source
    const edgesBySource = new Map<string, string[]>();
    for (const edge of result.edges) {
      const targets = edgesBySource.get(edge.source) || [];
      targets.push(edge.target);
      edgesBySource.set(edge.source, targets);
    }

    // For main.rs, verify usage of all targets
    const normalizedMain = normalizePath(mainPath);
    const targets = edgesBySource.get(normalizedMain) || [];
    
    expect(targets.length).toBe(2); // main -> helper, main -> unused

    const usageMap = await spider.verifyDependencyUsageBatch(normalizedMain, targets);
    
    const unusedEdges: string[] = [];
    for (const edge of result.edges) {
      if (edge.source === normalizedMain) {
        const isUsed = usageMap.get(edge.target);
        if (isUsed === false) {
          unusedEdges.push(`${edge.source}->${edge.target}`);
        }
      }
    }

    // Should have exactly 1 unused edge: main -> unused
    expect(unusedEdges.length).toBe(1);
    expect(unusedEdges[0]).toContain('unused.rs');
  });
});
