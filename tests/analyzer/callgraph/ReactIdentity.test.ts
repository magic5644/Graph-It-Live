import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTreeSitterHarness } from './treeSitterHarness';
import { queryNeighbourhood } from '@/analyzer/callgraph/CallGraphQuery';
import { SymbolAnalyzer } from '@/analyzer/SymbolAnalyzer';

describe('React identity across analyzer surfaces', () => {
  let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
  beforeAll(async () => { harness = await createTreeSitterHarness('gil-react-index-'); });
  afterAll(() => harness.dispose());

  const files = {
    'Card.ts': `export function Card() { return null; } export function save() {}`,
    'barrel.ts': `export { Card, save } from './Card';`,
    'App.tsx': `import React from 'react'; import { Card, save } from './barrel'; export function App() { return <Card onClick={save} />; } export function utility() { return 1; }`,
    'Other.jsx': `import React from 'react'; import { h } from 'preact'; export const Other = () => <div />;`,
  };

  it('persists exact JSX target identity without turning callbacks or utilities into components', async () => {
    const indexer = await harness.newIndexer();
    try {
      await harness.indexInto(indexer, files);
      const snapshot = indexer.getIndexSnapshot();
      expect(snapshot.nodes.filter(node => node.framework === 'react').map(node => node.name).sort()).toEqual(['App', 'Card']);
      const root = snapshot.nodes.find(node => node.name === 'App')!;
      expect(queryNeighbourhood(indexer.getDb(), root.id).nodes.filter(node => node.framework === 'react').map(node => node.name).sort()).toEqual(['App', 'Card']);
      const savePath = path.join(harness.root, 'identity.db');
      await indexer.saveToFile(savePath);
      const warm = await harness.newIndexer();
      try {
        expect(await warm.loadFromFile(savePath)).toBe(true);
        expect(warm.getIndexSnapshot().nodes.filter(node => node.framework === 'react').map(node => node.name).sort()).toEqual(['App', 'Card']);
        await harness.indexInto(warm, { 'App.tsx': `export function App() { return null; }` });
        expect(warm.getIndexSnapshot().nodes.some(node => node.framework)).toBe(false);
      } finally { warm.dispose(); }
    } finally { indexer.dispose(); }
  });

  it.each(['tsx', 'jsx'])('exposes local React component evidence in SymbolAnalyzer for .%s', extension => {
    const analyzer = new SymbolAnalyzer();
    const source = `import React from 'react'; export function App() { return <div />; } export function utility() { return 1; }`;
    expect(analyzer.analyzeFileContent(`/repo/App.${extension}`, source).symbols.filter(symbol => symbol.framework === 'react').map(symbol => symbol.name)).toEqual(['App']);
    expect(analyzer.getExportedSymbols(`/repo/App.${extension}`, source).filter(symbol => symbol.framework === 'react').map(symbol => symbol.name)).toEqual(['App']);
  });
});
