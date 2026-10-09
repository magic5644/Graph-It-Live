import { describe, expect, it, vi } from 'vitest';
import { BranchWatchTreeProvider, branchWatchStatus } from '@/extension/services/BranchWatchTreeProvider';
import type { BranchWatchResult } from '@/analyzer/BranchWatchAnalyzer';

vi.mock('vscode', () => ({
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  ThemeIcon: class { constructor(public id: string) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
}));
const result: BranchWatchResult = { snapshot: { branch: 'feature', reference: 'main', referenceSha: 'abc', headSha: 'def', mergeBaseSha: 'abc', fingerprint: '1', changes: [], limitations: [], readablePaths: [] }, fileImpacts: [], cycles: [], limitations: [], analyzedAt: 1,
  review: { baseRef: 'abc', headRef: 'HEAD', changedFiles: [], symbols: [], score: 0, risk: 'low', isPartial: false, limitations: [] } };

describe('BranchWatchTreeProvider', () => {
  it('renders no activation rows while disabled and never shows a current success for stale states', () => {
    const tree = new BranchWatchTreeProvider('/workspace');
    expect(tree.getChildren()).toEqual([]);
    for (const phase of ['paused', 'dirty', 'pending', 'running', 'unavailable'] as const) {
      tree.setState({ phase, result, reason: 'historical' });
      expect(branchWatchStatus({ phase, result }).text).not.toMatch(/Structure: OK|No recorded changes/);
      expect(tree.getChildren()[0].label).toMatch(/Paused|Save required|Waiting|Analyzing|unavailable/);
    }
    tree.dispose();
  });
  it('keeps the test reminder informational and exposes safe source navigation without fabricated lines', () => {
    const tree = new BranchWatchTreeProvider('/workspace');
    tree.setState({ phase: 'ready', result });
    expect(branchWatchStatus({ phase: 'ready', result }).text).toBe('No recorded changes · risk low · confidence high');
    expect(tree.getChildren().find(item => item.label === 'Tests')?.children?.[0].label).toBe('Tests must pass before delivery.');
    const changed = { ...result, fileImpacts: [{ path: 'api.py', availability: 'available' as const, limitations: [], dependents: [{ path: 'consumer.py', depth: 1, changed: false }] }], limitations: ['behavior unverified'] };
    tree.setState({ phase: 'ready', result: changed });
    // "behavior unverified" holds for any static analysis: it does not lower confidence.
    expect(branchWatchStatus({ phase: 'ready', result: changed }).text).toContain('WARNING · 1 checks · risk low · confidence high');
    const files = tree.getChildren().find(item => item.label === 'Changed files');
    const consumer = files?.children?.[0].children?.[0];
    expect(consumer?.command).toMatchObject({ command: 'graph-it-live.branchWatch.openFile', arguments: [{ file: 'consumer.py' }] });
    expect(consumer?.description).toContain('no breaking contract detected');
    expect(JSON.stringify(tree.getChildren())).not.toMatch(/tests passed|covered by tests|ready to ship/i);
    tree.dispose();
  });

  it('labels each importer according to the available review evidence', () => {
    const tree = new BranchWatchTreeProvider('/workspace');
    const reviewed = {
      ...result,
      fileImpacts: [{ path: 'api.ts', availability: 'available' as const, limitations: [], dependents: [
        { path: 'covered.ts', depth: 1, changed: false },
        { path: 'updated.ts', depth: 1, changed: true },
        { path: 'unverified.ts', depth: 1, changed: false },
      ] }],
      review: {
        ...result.review,
        symbols: [{
          name: 'value', filePath: 'api.ts', score: 10, risk: 'low' as const, breakingChanges: [], impactedSymbolCount: 3,
          consumers: { updated: ['updated.ts'], covered: ['covered.ts'], unverified: ['unverified.ts'] }, cycleEvidence: [], unusedExportEvidence: false,
          testCandidates: [], scoreFactors: { breakingChanges: 0, unverifiedConsumers: 0, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 0 }, evidence: [],
        }],
      },
    };
    tree.setState({ phase: 'ready', result: reviewed });
    const changedFile = tree.getChildren().find(item => item.label === 'Changed files')?.children?.[0];
    expect(changedFile?.description).toContain('1 signature change');
    const children = changedFile?.children ?? [];
    expect(children.map(item => item.description)).toEqual([
      'depth 1 · test file detected · tests not run',
      'depth 1 · changed; compatibility unproven',
      'depth 1 · manual check required',
    ]);
    tree.dispose();
  });

  it('summarizes affected cycles once and removes duplicate limitations', () => {
    const tree = new BranchWatchTreeProvider('/workspace');
    const summarized = { ...result, cycleSummary: { detected: 2, scopeComplete: true }, limitations: ['same limitation', 'same limitation'] };
    tree.setState({ phase: 'ready', result: summarized });
    const rows = tree.getChildren();
    const cycles = rows.find(item => item.label === 'Cyclic dependencies');
    expect(cycles?.children?.[0].label).toBe('Affected dependency scope: 2 cycle(s) detected');
    expect(rows.find(item => item.label === 'Limitations')?.children?.filter(item => item.label === 'same limitation')).toHaveLength(1);
    tree.dispose();
  });

  it('keeps confidence medium when only the large-project cycle scope is truncated', () => {
    const tree = new BranchWatchTreeProvider('/workspace');
    const partial = { ...result,
      snapshot: { ...result.snapshot, changes: [{ path: 'api.ts', kind: 'modified' as const }], readablePaths: ['api.ts'] },
      fileImpacts: [{ path: 'api.ts', availability: 'available' as const, limitations: [], dependents: [] }],
      cycleSummary: { detected: 1, scopeComplete: false },
      limitations: ['Cycle analysis reached the 200-file affected-scope limit.'],
    };
    expect(branchWatchStatus({ phase: 'ready', result: partial }).text).toContain('confidence medium');
    tree.dispose();
  });

  it('lowers confidence when a scored risk rests on estimated consumers', () => {
    const symbol = {
      name: 'Service.run', filePath: 'api.ts', score: 60, risk: 'high' as const, breakingChanges: [], impactedSymbolCount: 4,
      consumers: { updated: [], covered: [], unverified: ['a.ts'] }, cycleEvidence: [], unusedExportEvidence: false, testCandidates: [],
      scoreFactors: { breakingChanges: 50, unverifiedConsumers: 5, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 5 },
      evidence: [{ kind: 'partial' as const, detail: 'Dependents are tracked per exported symbol, not per member.' }],
    };
    const estimated = { ...result, review: { ...result.review, risk: 'high' as const, score: 60, symbols: [symbol] } };
    expect(branchWatchStatus({ phase: 'ready', result: estimated }).text).toContain('confidence medium');

    const unscored = { ...result, review: { ...result.review, symbols: [{ ...symbol, score: 0 }] } };
    expect(branchWatchStatus({ phase: 'ready', result: unscored }).text).toContain('confidence high');
  });

  it.each([
    ['a partial review', { review: { ...result.review, isPartial: true } }],
    ['a snapshot limitation', { snapshot: { ...result.snapshot, limitations: ['unsafe path skipped'] } }],
    ['a partial file impact', { fileImpacts: [{ path: 'api.ts', availability: 'partial' as const, limitations: [], dependents: [] }] }],
  ])('lowers confidence to medium for %s', (_case, override) => {
    expect(branchWatchStatus({ phase: 'ready', result: { ...result, ...override } }).text).toContain('confidence medium');
  });

  it('reports low confidence when no changed file could be read', () => {
    const unreadable = { ...result, snapshot: { ...result.snapshot, changes: [{ path: 'api.ts', kind: 'modified' as const }], readablePaths: [] } };
    expect(branchWatchStatus({ phase: 'ready', result: unreadable }).text).toContain('confidence low');
  });

  it('exports the complete visible status as plain text', () => {
    const tree = new BranchWatchTreeProvider('/workspace');
    tree.setState({ phase: 'ready', result: { ...result, limitations: ['one limitation'] } });
    const text = tree.getCopyText();
    expect(text).toContain('WARNING · 1 checks · risk low · confidence high');
    expect(text).toContain('Workspace: /workspace');
    expect(text).toContain('one limitation');
    expect(text).toContain('Tests must pass before delivery.');
    tree.dispose();
  });
});
