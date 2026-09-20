import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchWatchService } from '@/extension/services/BranchWatchService';
import type { BranchWatchResult, BranchWatchSnapshot } from '@/analyzer/BranchWatchAnalyzer';

vi.mock('vscode', () => ({}));
const snapshot: BranchWatchSnapshot = { reference: 'main', referenceSha: 'base', headSha: 'head', branch: 'feature', mergeBaseSha: 'base', fingerprint: 'one', changes: [], readablePaths: [], limitations: [] };
const result: BranchWatchResult = { snapshot, fileImpacts: [], cycles: [], limitations: [], analyzedAt: 1,
  review: { baseRef: 'base', headRef: 'HEAD', changedFiles: [], symbols: [], score: 0, risk: 'low', isPartial: false, limitations: [] } };

describe('BranchWatchService lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const create = () => {
    const analyzer = { capture: vi.fn().mockResolvedValue(snapshot), analyze: vi.fn().mockResolvedValue(result) };
    const service = new BranchWatchService({ analyzer, prepareIndex: vi.fn().mockResolvedValue(undefined), isDirty: () => false });
    return { service, analyzer };
  };
  it('does no work while disabled, coalesces a save burst, and skips Git notifications with the same fingerprint', async () => {
    const { service, analyzer } = create();
    service.refresh(); await vi.advanceTimersByTimeAsync(1000);
    expect(analyzer.capture).not.toHaveBeenCalled();
    service.configure(true, 'main');
    for (let i = 0; i < 20; i++) service.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(service.state.phase).toBe('ready');
    service.refresh(); await vi.advanceTimersByTimeAsync(1000);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it('starts after the debounce deadline even when filesystem events keep arriving', async () => {
    const { service, analyzer } = create();
    service.configure(true, 'main');
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(200);
      service.refresh();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it('does not restart startup analysis when configuration is reported repeatedly', async () => {
    const { service, analyzer } = create();
    service.configure(true, 'main');
    await vi.advanceTimersByTimeAsync(900);
    service.configure(true, 'main');
    await vi.advanceTimersByTimeAsync(100);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it('publishes an empty result without preparing the dependency index after a complete revert', async () => {
    const analyzer = { capture: vi.fn().mockResolvedValue(snapshot), analyze: vi.fn().mockResolvedValue(result) };
    const prepareIndex = vi.fn().mockResolvedValue(undefined);
    const service = new BranchWatchService({ analyzer, prepareIndex, isDirty: () => false });
    service.configure(true, 'main'); await vi.advanceTimersByTimeAsync(1000);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(prepareIndex).not.toHaveBeenCalled();
    expect(service.state.phase).toBe('ready');
    service.dispose();
  });
  it.each(['pause', 'dispose', 'disable', 'dirty'] as const)('rejects late publication after %s', async action => {
    const { service, analyzer } = create();
    let finish!: (value: BranchWatchResult) => void;
    analyzer.analyze.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    service.configure(true, 'main'); await vi.advanceTimersByTimeAsync(1000);
    if (action === 'disable') service.configure(false, 'main');
    else if (action === 'dirty') service.markDirty();
    else service[action]();
    finish(result); await vi.advanceTimersByTimeAsync(1000);
    expect(service.state.phase).not.toBe('ready');
    expect(service.state.result).toBeUndefined();
    service.dispose();
  });
  it('serializes analyses and reruns once after an event during analysis', async () => {
    const { service, analyzer } = create();
    let finish!: (value: BranchWatchResult) => void;
    analyzer.analyze.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    service.configure(true, 'main'); await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 20; i++) service.refresh();
    await vi.advanceTimersByTimeAsync(2000);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    finish(result); await vi.advanceTimersByTimeAsync(1000);
    expect(analyzer.analyze).toHaveBeenCalledTimes(2);
    expect(service.state.phase).toBe('ready');
    service.dispose();
  });
  it('discards changed fingerprints and surfaces index errors without a running spinner', async () => {
    const { service, analyzer } = create();
    analyzer.capture.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot, fingerprint: 'two' });
    service.configure(true, 'main'); await vi.advanceTimersByTimeAsync(1000);
    expect(service.state.phase).toBe('running');
    expect(service.state.result).toBeUndefined();
    service.dispose();
    const failedAnalyzer = {
      capture: vi.fn().mockResolvedValue({ ...snapshot, changes: [{ path: 'src/file.ts', kind: 'modified' as const }] }),
      analyze: vi.fn().mockResolvedValue(result),
    };
    const failed = new BranchWatchService({ analyzer: failedAnalyzer, isDirty: () => false, prepareIndex: async () => { throw new Error('Index unavailable'); } });
    failed.configure(true, 'main'); await vi.advanceTimersByTimeAsync(1000);
    expect(failed.state).toMatchObject({ phase: 'unavailable', reason: 'Index unavailable' });
    failed.dispose();
  });
});
