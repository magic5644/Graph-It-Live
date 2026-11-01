import { describe, expect, it } from 'vitest';
import { GraphContextScorer } from '@/analyzer/graph-context/GraphContextScorer';
import { extractQueryKeywords } from '@/analyzer/query/keywords';
import type { GraphContextNode } from '@/shared/graph-context-types';

const node = (
  id: string,
  kind: GraphContextNode['kind'],
  name: string,
  filePath: string,
): GraphContextNode => ({ id, kind, name, path: filePath, startLine: 1 });

const scorer = new GraphContextScorer({ workspaceRoot: '/workspace' });

describe('GraphContextScorer multilingual keywords', () => {
  const pythonRefs = node('symbol:py', 'symbol', 'computeReferences', 'src/languages/python/references.ts');
  const countFiles = node('symbol:count', 'symbol', 'countFiles', 'src/stats.ts');
  const round = node('symbol:round', 'symbol', 'round', 'src/math.ts');

  it('shares the query keyword extraction', () => {
    const question = 'où est fait le calcul des références python ?';
    expect(scorer.extractKeywords(question)).toEqual(extractQueryKeywords(question));
  });

  it.each([
    'where are python references computed?',
    'ou est fait le calcul des références python ?',
    'wo werden die Python-Referenzen berechnet?',
    '¿dónde se calculan las referencias de python?',
    '在哪里计算Python引用的地方',
    'где вычисляются ссылки python?',
  ])('ranks python reference code above unrelated symbols: %s', question => {
    const ranked = scorer.scoreSearchNodes(question, [round, countFiles, pythonRefs]);

    expect(ranked.map(candidate => candidate.node.id)).toEqual(['symbol:py']);
  });

  it('matches accented names and paths without accents in the question', () => {
    const accented = node('symbol:fr', 'symbol', 'calculRéférence', 'src/références/calcul.ts');

    expect(scorer.scoreSearchNodes('reference', [accented])[0]?.score).toBeGreaterThan(0);
  });

  it('gives the exact-identifier bonus to non-ASCII identifiers', () => {
    const german = node('symbol:de', 'symbol', 'größeBerechnen', 'src/größe.ts');
    const other = node('symbol:other', 'symbol', 'berechnenGröße', 'src/other.ts');

    const ranked = scorer.scoreSearchNodes('wer ruft größeBerechnen auf?', [other, german]);

    expect(ranked[0]?.node.id).toBe('symbol:de');
    expect(ranked[0]?.score).toBeGreaterThan(1000);
  });

  it('does not seed nodes that only match the question kind word', () => {
    const invoice = node('file:invoice', 'file', 'InvoiceService.ts', 'src/billing/InvoiceService.ts');
    const api = node('file:api', 'file', 'BillingApi.ts', 'src/api/BillingApi.ts');

    const ranked = scorer.scoreSearchNodes('What depends on the InvoiceService file?', [api, invoice]);

    expect(ranked.map(candidate => candidate.node.id)).toEqual(['file:invoice']);
  });

  it('returns nothing for a stopword-only question', () => {
    expect(scorer.scoreSearchNodes('le la les der die', [pythonRefs])).toEqual([]);
  });
});

describe('GraphContextScorer multilingual intents', () => {
  const target = node('symbol:target', 'symbol', 'target', 'src/example.ts');
  const english = scorer.scoreRelation('search', 'CALLS', 'Which calls reach target?', target);

  it.each([
    'Qui appelle target ?',
    'Wer ruft target auf?',
    '¿Quién llama a target?',
    '谁调用了target',
    'Кто вызывает target?',
  ])('boosts CALLS like the English question: %s', question => {
    expect(scorer.scoreRelation('search', 'CALLS', question, target)).toBe(english);
  });

  it('recognizes a translated test intent', () => {
    const testNode = node('test:t', 'test', 'computeReferences', 'tests/references.test.ts');

    const asked = scorer.scoreSearchNodes('pruebas de referencias', [testNode])[0]?.score ?? 0;
    const notAsked = scorer.scoreSearchNodes('referencias', [testNode])[0]?.score ?? 0;

    expect(asked).toBeGreaterThan(notAsked);
  });
});
