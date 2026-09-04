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

  it('associates rationale markers only with the nearest code link in their section', async () => {
    const root = await fixture(workspaces);
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'ADR.md'), [
      '# Decisions',
      '## Authentication',
      '[auth](../src/auth.ts)',
      '# WHY: keep authentication isolated',
      '## Billing',
      '[billing](../src/billing.ts)',
      '# NOTE: billing has separate retry rules',
    ].join('\n'));

    const result = await new DocumentReferenceIndexer(root).index('**');
    const explainsCode = result.edges.filter(edge => (
      edge.relation === 'EXPLAINS' && edge.target.startsWith('file:')
    ));

    expect(explainsCode).toEqual([
      expect.objectContaining({
        source: 'rationale:docs/ADR.md:4',
        target: 'file:src/auth.ts',
        sourceLine: 3,
      }),
      expect.objectContaining({
        source: 'rationale:docs/ADR.md:7',
        target: 'file:src/billing.ts',
        sourceLine: 6,
      }),
    ]);
  });

  it('uses RST headings and inline links', async () => {
    const root = await fixture(workspaces);
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'decision.rst'), [
      'Gateway Decision',
      '================',
      '',
      'See `the implementation <../src/gateway.ts>`_.',
    ].join('\n'));

    const result = await new DocumentReferenceIndexer(root).index('**');

    expect(result.nodes).toContainEqual(expect.objectContaining({
      id: 'document:docs/decision.rst',
      name: 'Gateway Decision',
    }));
    expect(result.edges).toContainEqual(expect.objectContaining({
      source: 'document:docs/decision.rst',
      target: 'file:src/gateway.ts',
      relation: 'REFERENCES',
      sourceLine: 4,
    }));
  });

  it('indexes Markdown and literal JSX links in MDX without evaluating expressions', async () => {
    const root = await fixture(workspaces);
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'guide.mdx'), [
      '# Gateway Guide',
      '[API](../src/api.ts)',
      '<Link href="../src/gateway.ts">Gateway</Link>',
      '<Link href={dynamicTarget}>Dynamic</Link>',
      '<Link href="https://example.com/remote.ts">Remote</Link>',
    ].join('\n'));

    const result = await new DocumentReferenceIndexer(root).index('**');
    const references = result.edges.filter(edge => edge.relation === 'REFERENCES');

    expect(references).toEqual([
      expect.objectContaining({ target: 'file:src/api.ts', sourceLine: 2 }),
      expect.objectContaining({ target: 'file:src/gateway.ts', sourceLine: 3 }),
    ]);
  });

  it('indexes YAML path values and real comments without treating quoted strings as rationale', async () => {
    const root = await fixture(workspaces);
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'gateway.yaml'), [
      'implementation: ../src/gateway.ts # NOTE: keep the adapter local',
      'description: "# HACK: this is data, not a comment"',
      'remote: https://example.com/remote.ts',
    ].join('\n'));

    const result = await new DocumentReferenceIndexer(root).index('**');

    expect(result.nodes.filter(node => node.kind === 'rationale')).toEqual([
      expect.objectContaining({
        id: 'rationale:docs/gateway.yaml:1',
        name: 'keep the adapter local',
      }),
    ]);
    expect(result.edges).toContainEqual(expect.objectContaining({
      source: 'document:docs/gateway.yaml',
      target: 'file:src/gateway.ts',
      relation: 'REFERENCES',
      sourceLine: 1,
    }));
    expect(result.edges).toContainEqual(expect.objectContaining({
      source: 'rationale:docs/gateway.yaml:1',
      target: 'file:src/gateway.ts',
      relation: 'EXPLAINS',
      sourceLine: 1,
    }));
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
