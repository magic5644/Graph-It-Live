/**
 * REPL end-to-end chaining tests.
 *
 * These tests execute the real REPL loop with mocked prompts/runtime/commands
 * to validate command chaining and input propagation between cycles.
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectMainAction: vi.fn(),
  selectPostResultAction: vi.fn(),
  searchFile: vi.fn(),
  inputSymbol: vi.fn(),
  selectExportFormat: vi.fn(),
  confirmScan: vi.fn(),

  traceRun: vi.fn(),
  pathRun: vi.fn(),
  explainRun: vi.fn(),
  summaryRun: vi.fn(),
  checkRun: vi.fn(),
}));

vi.mock('../../src/cli/repl/prompts.js', () => ({
  selectMainAction: mocks.selectMainAction,
  selectPostResultAction: mocks.selectPostResultAction,
  searchFile: mocks.searchFile,
  inputSymbol: mocks.inputSymbol,
  selectExportFormat: mocks.selectExportFormat,
  confirmScan: mocks.confirmScan,
}));

vi.mock('../../src/analyzer/SourceFileCollector.js', () => ({
  SourceFileCollector: class {
    collectAllSourceFiles = vi.fn().mockResolvedValue([
      path.resolve('/workspace', 'src/index.ts'),
      path.resolve('/workspace', 'src/utils.ts'),
    ]);
  },
}));

vi.mock('../../src/cli/commands/trace.js', () => ({ run: mocks.traceRun }));
vi.mock('../../src/cli/commands/path.js', () => ({ run: mocks.pathRun }));
vi.mock('../../src/cli/commands/explain.js', () => ({ run: mocks.explainRun }));
vi.mock('../../src/cli/commands/summary.js', () => ({ run: mocks.summaryRun }));
vi.mock('../../src/cli/commands/check.js', () => ({ run: mocks.checkRun }));

import { run } from '../../src/cli/commands/repl.js';

function createRuntimeStub() {
  return {
    workspaceRoot: '/workspace',
    init: vi.fn().mockResolvedValue(undefined),
    ensureIndexed: vi.fn().mockResolvedValue({ filesIndexed: 2, durationMs: 1 }),
  };
}

describe('REPL command chaining e2e', () => {
  const stdoutSpy = vi.spyOn(process.stdout, 'write');
  const stderrSpy = vi.spyOn(process.stderr, 'write');

  beforeEach(() => {
    Object.values(mocks).forEach((mockFn) => mockFn.mockReset());
    stdoutSpy.mockReset();
    stderrSpy.mockReset();

    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    stdoutSpy.mockImplementation(() => true);
    stderrSpy.mockImplementation(() => true);

    mocks.selectExportFormat.mockResolvedValue('json');
    mocks.confirmScan.mockResolvedValue(true);

    mocks.traceRun.mockResolvedValue('{"trace":"ok"}');
    mocks.pathRun.mockResolvedValue('{"path":"ok"}');
    mocks.explainRun.mockResolvedValue('{"explain":"ok"}');
    mocks.summaryRun.mockResolvedValue('{"summary":"ok"}');
    mocks.checkRun.mockResolvedValue('{"check":"ok"}');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('chains selected file from trace into check input', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('trace')
      .mockResolvedValueOnce('check')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction
      .mockResolvedValueOnce('newAnalysis')
      .mockResolvedValueOnce('quit');

    mocks.searchFile.mockResolvedValueOnce('src/index.ts');
    mocks.inputSymbol.mockResolvedValueOnce('main');

    const runtime = createRuntimeStub();
    await run(runtime as never);

    const expectedFile = path.resolve('/workspace', 'src/index.ts');

    expect(mocks.traceRun).toHaveBeenCalledWith(
      [`${expectedFile}#main`],
      runtime,
      'text',
    );
    expect(mocks.checkRun).toHaveBeenCalledWith([expectedFile], runtime, 'text');
  });

  it('chains selected file from trace into summary codemap input', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('trace')
      .mockResolvedValueOnce('summary')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction
      .mockResolvedValueOnce('newAnalysis')
      .mockResolvedValueOnce('quit');

    mocks.searchFile.mockResolvedValueOnce('src/index.ts');
    mocks.inputSymbol.mockResolvedValueOnce('handler');

    const runtime = createRuntimeStub();
    await run(runtime as never);

    const expectedFile = path.resolve('/workspace', 'src/index.ts');
    expect(mocks.summaryRun).toHaveBeenCalledWith([expectedFile], runtime, 'text');
  });

  it('does not execute drill-down when there is no file context', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('summary')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('drillDown');

    const runtime = createRuntimeStub();
    await run(runtime as never);

    expect(mocks.summaryRun).toHaveBeenCalledWith([], runtime, 'text');
    expect(mocks.traceRun).not.toHaveBeenCalled();
    expect(mocks.explainRun).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      'Drill-down unavailable for this result (no file context).\n',
    );
  });

  it('drill-down on path result reuses current file context and allows empty symbol fallback', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('path')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('drillDown');

    mocks.searchFile.mockResolvedValueOnce('src/utils.ts');
    mocks.inputSymbol.mockResolvedValueOnce('');

    const runtime = createRuntimeStub();
    await run(runtime as never);

    const expectedFile = path.resolve('/workspace', 'src/utils.ts');

    expect(mocks.pathRun).toHaveBeenCalledWith([expectedFile], runtime, 'text');
    expect(mocks.explainRun).toHaveBeenCalledWith([expectedFile], runtime, 'text');
  });

  it('reuses previous symbol as drill-down default input', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('trace')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('drillDown');

    mocks.searchFile.mockResolvedValueOnce('src/index.ts');
    mocks.inputSymbol
      .mockResolvedValueOnce('handler')
      .mockResolvedValueOnce('');

    const runtime = createRuntimeStub();
    await run(runtime as never);

    const expectedFile = path.resolve('/workspace', 'src/index.ts');
    const expectedRelative = path.relative('/workspace', expectedFile);

    expect(mocks.inputSymbol).toHaveBeenNthCalledWith(1, 'src/index.ts');
    expect(mocks.inputSymbol).toHaveBeenNthCalledWith(2, expectedRelative, 'handler');
    expect(mocks.explainRun).toHaveBeenCalledWith([expectedFile], runtime, 'text');
  });

  it('chains file context from explain fallback into check when trace symbol is empty', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('trace')
      .mockResolvedValueOnce('check')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction
      .mockResolvedValueOnce('newAnalysis')
      .mockResolvedValueOnce('quit');

    mocks.searchFile.mockResolvedValueOnce('src/utils.ts');
    mocks.inputSymbol.mockResolvedValueOnce('');

    const runtime = createRuntimeStub();
    await run(runtime as never);

    const expectedFile = path.resolve('/workspace', 'src/utils.ts');

    expect(mocks.explainRun).toHaveBeenCalledWith([expectedFile], runtime, 'text');
    expect(mocks.checkRun).toHaveBeenCalledWith([expectedFile], runtime, 'text');
  });
});
