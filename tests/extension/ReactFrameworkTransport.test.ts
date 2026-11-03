import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Spider } from '@/analyzer/Spider';
import { GraphViewService } from '@/extension/services/GraphViewService';
import { NodeInteractionService } from '@/extension/services/NodeInteractionService';
import { SymbolViewService } from '@/extension/services/SymbolViewService';
import { normalizePath } from '@/shared/path';

describe('React framework transport', () => {
  let root: string;
  let component: string;
  let plain: string;
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    root = normalizePath(await fs.mkdtemp(path.join(os.tmpdir(), 'react-transport-')));
    component = normalizePath(path.join(root, 'Card.tsx'));
    plain = normalizePath(path.join(root, 'plain.tsx'));
    await Promise.all([
      fs.writeFile(component, `import React from 'react';\nexport function Card() { return <button />; }`),
      fs.writeFile(plain, `export const value = 1;`),
    ]);
  });

  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function spider(): Spider {
    return {
      workspaceRoot: root,
      crawl: vi.fn().mockResolvedValue({ nodes: [component, plain], edges: [] }),
      crawlFrom: vi.fn().mockResolvedValue({ nodes: [component, plain], edges: [] }),
      findReferencingFiles: vi.fn().mockResolvedValue([{ path: component }, { path: plain }]),
      getIndexedReferencingFiles: vi.fn().mockReturnValue([{ path: component }, { path: plain }]),
      hasReverseIndex: vi.fn().mockReturnValue(false),
      getCallerCount: vi.fn().mockReturnValue(0),
      verifyDependencyUsage: vi.fn().mockResolvedValue(true),
    } as unknown as Spider;
  }

  it.each(['initial', 'expanded', 'referencing'] as const)('sends proven file identity in %s graphs', async (view) => {
    const analyzer = spider();
    let graph;
    if (view === 'initial') {
      graph = await new GraphViewService(analyzer, logger, { unusedAnalysisConcurrency: 1, unusedAnalysisMaxEdges: 0 }).buildGraphData(component);
    } else {
      const service = new NodeInteractionService(analyzer, logger);
      graph = (view === 'expanded' ? await service.expandNode(component, []) : await service.getReferencingFiles(plain)).data;
    }
    expect(graph.nodeMetadata?.[component]).toMatchObject({ framework: 'react' });
    expect(graph.nodeMetadata?.[plain]?.framework).toBeUndefined();
  });

  it('keeps component identity in the intra-file view without marking utilities', async () => {
    const analyzer = spider();
    Object.assign(analyzer, {
      getSymbolGraph: vi.fn().mockResolvedValue({
        symbols: [
          { id: `${component}:Card`, name: 'Card', kind: 'FunctionDeclaration', line: 2, category: 'function', isExported: true, framework: 'react' },
          { id: `${component}:util`, name: 'util', kind: 'FunctionDeclaration', line: 3, category: 'function', isExported: true },
        ],
        dependencies: [],
      }),
      findReferencingFiles: vi.fn().mockResolvedValue([]),
    });
    const graph = await new SymbolViewService(analyzer, logger).buildSymbolGraph(component, component);
    expect(graph.nodeMetadata?.[component]?.framework).toBe('react');
    expect(graph.intraFileGraph?.nodes.find(node => node.name === 'Card')?.framework).toBe('react');
    expect(graph.intraFileGraph?.nodes.find(node => node.name === 'util')?.framework).toBeUndefined();
  });
});
