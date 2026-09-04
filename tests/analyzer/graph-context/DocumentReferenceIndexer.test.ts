import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentReferenceIndexer } from '../../../src/analyzer/graph-context/DocumentReferenceIndexer';
import { GraphContextRetriever } from '../../../src/analyzer/graph-context/GraphContextRetriever';

describe('DocumentReferenceIndexer', () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(workspace => rm(workspace, { recursive: true, force: true })));
  });

  it('indexes local Markdown references, headings, rationale markers, and skips outside links', async () => {
    const root = await fixture(workspaces);
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'src.ts'), '// WHY: keep this local\nexport const value = 1;\n');
    await writeFile(path.join(root, 'docs', 'ADR-001.md'), [
      '# Decision',
      '',
      'The [implementation](../src.ts) is deliberate.',
      '# WHY: preserve the stable API',
      '[outside](/tmp/secret.md)',
    ].join('\n'));
    await writeFile(path.join(root, 'docs', 'notes.yaml'), 'reason: "# NOTE: yaml is local"\n');
    await writeFile(path.join(root, 'image.png'), 'not indexed');

    const result = await new DocumentReferenceIndexer(root).index('**');
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'document:docs/ADR-001.md', kind: 'document' }),
      expect.objectContaining({ id: 'rationale:docs/ADR-001.md:4', kind: 'rationale', startLine: 4 }),
      expect.objectContaining({ id: 'rationale:src.ts:1', kind: 'rationale' }),
    ]));
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'document:docs/ADR-001.md', target: 'file:src.ts', relation: 'REFERENCES', confidence: 'EXTRACTED', sourceLine: 3 }),
      expect.objectContaining({ source: 'document:docs/ADR-001.md', target: 'file:src.ts', relation: 'DOCUMENTS' }),
      expect.objectContaining({ source: 'rationale:docs/ADR-001.md:4', target: 'file:src.ts', relation: 'EXPLAINS' }),
      expect.objectContaining({ source: 'rationale:src.ts:1', target: 'file:src.ts', relation: 'EXPLAINS' }),
    ]));
    expect(result.edges.some(edge => edge.target.includes('secret'))).toBe(false);
  });

  it('keeps documentation opt-in and lets an ADR explain a code seed', async () => {
    const snapshot = {
      revision: 'docs',
      fresh: true,
      nodes: [
        { id: 'symbol:src.ts:value:2', kind: 'symbol' as const, name: 'value', path: 'src.ts' },
        { id: 'rationale:docs/ADR.md:2', kind: 'rationale' as const, name: 'stable API', path: 'docs/ADR.md', startLine: 2 },
      ],
      edges: [{ source: 'rationale:docs/ADR.md:2', target: 'symbol:src.ts:value:2', relation: 'EXPLAINS' as const, confidence: 'EXTRACTED' as const }],
    };
    const retriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => snapshot },
      workspaceRoot: '/workspace',
    });
    const response = await retriever.retrieve({ question: 'stable API', scope: '**', maxNodes: 10 });
    expect(response.nodes.map(node => node.id)).toEqual(expect.arrayContaining(['symbol:src.ts:value:2', 'rationale:docs/ADR.md:2']));
    expect(response.edges).toContainEqual(expect.objectContaining({ relation: 'EXPLAINS' }));
  });
});

async function fixture(workspaces: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-context-docs-'));
  workspaces.push(root);
  return root;
}
