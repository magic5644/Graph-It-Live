import assert from 'node:assert/strict';
import { bench, describe } from 'vitest';
import { createTreeSitterHarness } from '../analyzer/callgraph/treeSitterHarness';

const corpus = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
  `src/Card${index}.tsx`,
  `import React, { memo } from 'react';
export const Card${index} = memo(() => <section />);
export function utility${index}() { return ${index}; }
`,
]));

describe('React corpus indexing (24 files, 48 symbols)', () => {
  // Bench runners do not await test beforeAll hooks; share one lazy initialization promise.
  const ready = async () => {
    const harness = await createTreeSitterHarness('react-identity-bench-');
    const warm = await harness.newIndexer();
    await harness.indexInto(warm, corpus);
    assert.equal(warm.getIndexSnapshot().nodes.length, 48);
    assert.ok(warm.getIndexSnapshot().nodes.every(node => node.lang === 'typescript'));
    process.once('beforeExit', () => { warm.dispose(); void harness.dispose(); });
    return { harness, warm };
  };
  let pending: ReturnType<typeof ready> | undefined;
  const getReady = () => pending ??= ready();

  bench('cold index', async () => {
    const { harness } = await getReady();
    const index = await harness.newIndexer();
    try { await harness.indexInto(index, corpus); } finally { index.dispose(); }
  }, { iterations: 5, time: 10, warmupIterations: 0, warmupTime: 0 });

  bench('warm incremental index', async () => {
    const { harness, warm } = await getReady();
    await harness.indexInto(warm, corpus);
  }, { iterations: 5, time: 10, warmupIterations: 0, warmupTime: 0 });
});
