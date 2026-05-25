/**
 * REPL end-to-end chaining tests.
 *
 * These tests execute the real REPL loop with mocked prompts/runtime/commands
 * to validate command chaining and input propagation between cycles.
 */

/// <reference types="node" />

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntime } from '../../src/cli/runtime';

const mocks = vi.hoisted(() => ({
  selectMainAction: vi.fn(),
  selectPostResultAction: vi.fn(),
  searchDirectory: vi.fn(),
  searchFile: vi.fn(),
  selectOrInputSymbol: vi.fn(),
  askTraceOptions: vi.fn(),
  askCheckDepsOptions: vi.fn(),
  askArchitectureOptions: vi.fn(),
  inputCommandLine: vi.fn(),
  inputSavePath: vi.fn(),
  selectExportFormat: vi.fn(),
  selectPreferredFormat: vi.fn(),
  confirmScan: vi.fn(),
  buildContextualPostResultEntries: vi.fn().mockReturnValue([]),

  traceRun: vi.fn(),
  pathRun: vi.fn(),
  pathInRun: vi.fn(),
  explainRun: vi.fn(),
  summaryRun: vi.fn(),
  architectureRun: vi.fn(),
  checkDependenciesRun: vi.fn(),
  cyclesRun: vi.fn(),
  checkRun: vi.fn(),
}));

vi.mock('../../src/cli/repl/prompts.js', () => ({
  selectMainAction: mocks.selectMainAction,
  selectPostResultAction: mocks.selectPostResultAction,
  searchDirectory: mocks.searchDirectory,
  searchFile: mocks.searchFile,
  inputSavePath: mocks.inputSavePath,
  selectOrInputSymbol: mocks.selectOrInputSymbol,
  askTraceOptions: mocks.askTraceOptions,
  askCheckDepsOptions: mocks.askCheckDepsOptions,
  askArchitectureOptions: mocks.askArchitectureOptions,
  inputCommandLine: mocks.inputCommandLine,
  selectExportFormat: mocks.selectExportFormat,
  selectPreferredFormat: mocks.selectPreferredFormat,
  confirmScan: mocks.confirmScan,
  buildContextualPostResultEntries: mocks.buildContextualPostResultEntries,
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
vi.mock('../../src/cli/commands/pathIn.js', () => ({ run: mocks.pathInRun }));
vi.mock('../../src/cli/commands/explain.js', () => ({ run: mocks.explainRun }));
vi.mock('../../src/cli/commands/summary.js', () => ({ run: mocks.summaryRun }));
vi.mock('../../src/cli/commands/architecture.js', () => ({ run: mocks.architectureRun }));
vi.mock('../../src/cli/commands/checkDependencies.js', () => ({ run: mocks.checkDependenciesRun }));
vi.mock('../../src/cli/commands/cycles.js', () => ({ run: mocks.cyclesRun }));
vi.mock('../../src/cli/commands/check.js', () => ({ run: mocks.checkRun }));

import { run } from '../../src/cli/commands/repl';

function createRuntimeStub() {
  return {
    workspaceRoot: '/workspace',
    init: vi.fn().mockResolvedValue(undefined),
    ensureIndexed: vi.fn().mockResolvedValue({ filesIndexed: 2, durationMs: 1 }),
  };
}

async function runWithRuntimeStub(runtime: ReturnType<typeof createRuntimeStub>): Promise<void> {
  await run(runtime as unknown as CliRuntime);
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
    mocks.selectPreferredFormat.mockResolvedValue('json');
    mocks.inputSavePath.mockResolvedValue('.graph-it/exports/repl-output.txt');
    mocks.inputCommandLine.mockResolvedValue('');
    mocks.searchDirectory.mockResolvedValue('src');
    mocks.confirmScan.mockResolvedValue(true);
    mocks.selectOrInputSymbol.mockResolvedValue('');
    mocks.askTraceOptions.mockResolvedValue({ maxDepth: 10 });
    mocks.askCheckDepsOptions.mockResolvedValue({ direction: 'both' });
    mocks.askArchitectureOptions.mockResolvedValue({ maxFiles: undefined });

    mocks.traceRun.mockResolvedValue('{"trace":"ok"}');
    mocks.pathRun.mockResolvedValue('{"path":"ok"}');
    mocks.explainRun.mockResolvedValue('{"explain":"ok"}');
    mocks.summaryRun.mockResolvedValue('{"summary":"ok"}');
    mocks.architectureRun.mockResolvedValue('{"architecture":"ok"}');
    mocks.checkDependenciesRun.mockResolvedValue('{"outgoing":{},"incoming":{}}');
    mocks.cyclesRun.mockResolvedValue('{"cycleCount":0,"confirmedCycles":[]}');
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
    mocks.selectOrInputSymbol.mockResolvedValueOnce('main');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const expectedFile = path.resolve('/workspace', 'src/index.ts');

    expect(mocks.traceRun).toHaveBeenCalledWith(
      [`${expectedFile}#main`, '--maxDepth=10'],
      runtime,
      'json',
    );
    expect(mocks.checkRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
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
    mocks.selectOrInputSymbol.mockResolvedValueOnce('handler');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const expectedFile = path.resolve('/workspace', 'src/index.ts');
    expect(mocks.summaryRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
  });

  it('does not execute drill-down when there is no file context', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('summary')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('drillDown');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.summaryRun).toHaveBeenCalledWith([], runtime, 'json');
    expect(mocks.traceRun).not.toHaveBeenCalled();
    expect(mocks.explainRun).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      'Drill-down unavailable for this result (no file context).\n',
    );
  });

  it('drill-down on dependency result reuses current file context and allows empty symbol fallback', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('checkDependencies')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('drillDown');

    mocks.searchFile.mockResolvedValueOnce('src/utils.ts');
    mocks.selectOrInputSymbol.mockResolvedValueOnce('');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const expectedFile = path.resolve('/workspace', 'src/utils.ts');

    expect(mocks.checkDependenciesRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
    expect(mocks.explainRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
  });

  it('reuses previous symbol as drill-down default input', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('trace')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('drillDown');

    mocks.searchFile.mockResolvedValueOnce('src/index.ts');
    mocks.selectOrInputSymbol
      .mockResolvedValueOnce('handler')
      .mockResolvedValueOnce('');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const expectedFile = path.resolve('/workspace', 'src/index.ts');
    const expectedRelative = path.relative('/workspace', expectedFile);

    expect(mocks.selectOrInputSymbol).toHaveBeenNthCalledWith(
      1,
      'src/index.ts',
      expect.any(Array),
      expect.any(Number),
      expect.any(String),
    );
    expect(mocks.selectOrInputSymbol).toHaveBeenNthCalledWith(
      2,
      expectedRelative,
      expect.any(Array),
      expect.any(Number),
      'handler',
    );
    expect(mocks.explainRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
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
    mocks.selectOrInputSymbol.mockResolvedValueOnce('');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const expectedFile = path.resolve('/workspace', 'src/utils.ts');

    expect(mocks.explainRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
    expect(mocks.checkRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
  });

  it('runs full architecture action from REPL main menu', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('architecture')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('quit');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    // Architecture called with no args when unlimited (no maxFiles)
    expect(mocks.architectureRun).toHaveBeenCalledWith([], runtime, 'json');
  });

  it('passes --maxFiles arg to architecture when cap is configured', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('architecture')
      .mockResolvedValueOnce('quit');
    mocks.selectPostResultAction.mockResolvedValueOnce('quit');
    mocks.askArchitectureOptions.mockResolvedValueOnce({ maxFiles: 100 });

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.architectureRun).toHaveBeenCalledWith(['--maxFiles=100'], runtime, 'json');
  });

  it('does not print the header as standalone scrollback before the prompt loop', async () => {
    mocks.selectMainAction.mockResolvedValueOnce({ kind: 'quit' });

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('Type / to browse commands'));
    expect(stdoutSpy).toHaveBeenCalledWith('\nGoodbye!\n');
  });

  it('changes preferred format and uses it on next command', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('summary')
      .mockResolvedValueOnce('summary')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction
      .mockResolvedValueOnce('setFormat')
      .mockResolvedValueOnce('quit');

    mocks.selectPreferredFormat.mockResolvedValueOnce('json');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.summaryRun).toHaveBeenNthCalledWith(1, [], runtime, 'json');
    expect(mocks.summaryRun).toHaveBeenNthCalledWith(2, [], runtime, 'json');
  });

  it('exports using structured raw data even when display format is text', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('checkDependencies')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('export');
    mocks.selectExportFormat.mockResolvedValueOnce('json');
    mocks.searchFile.mockResolvedValueOnce('src/utils.ts');
    mocks.checkDependenciesRun.mockResolvedValueOnce('{"outgoing":{"dependencyCount":1},"incoming":{"referencingFileCount":2}}');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('"outgoing"'));
  });

  it('keeps mermaid output when preferred format is mermaid', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('summary')
      .mockResolvedValueOnce('summary')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction
      .mockResolvedValueOnce('setFormat')
      .mockResolvedValueOnce('quit');

    mocks.selectPreferredFormat.mockResolvedValueOnce('mermaid');
    mocks.summaryRun
      .mockResolvedValueOnce('{"filesIndexed":2}')
      .mockResolvedValueOnce('{"filesIndexed":2}');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('graph TD'));
    expect(stdoutSpy).not.toHaveBeenCalledWith(
      'Rendered in text (default mermaid unsupported for this command).\n',
    );
  });

  it('executes a free-form command from REPL command input', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('command')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('quit');
    mocks.inputCommandLine.mockResolvedValueOnce('architecture --format mermaid');
    mocks.architectureRun.mockResolvedValueOnce(
      '{"nodes":[{"id":"a","relativePath":"src/a.ts"}],"edges":[]}',
    );

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.architectureRun).toHaveBeenCalledWith([], runtime, 'json');
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('graph LR'));
  });

  it('warns user when an unknown --format value is given in free-form command', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('command')
      .mockResolvedValueOnce('quit');

    mocks.selectPostResultAction.mockResolvedValueOnce('quit');
    mocks.inputCommandLine.mockResolvedValueOnce('architecture --format banana');
    mocks.architectureRun.mockResolvedValueOnce('{"nodes":[],"edges":[]}');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown format "banana"'),
    );
  });

  it('warns user when --format is provided without a value', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'typed', commandLine: '/architecture --format' })
      .mockResolvedValueOnce({ kind: 'quit' });

    mocks.selectPostResultAction.mockResolvedValueOnce('quit');
    mocks.architectureRun.mockResolvedValueOnce('{"nodes":[],"edges":[]}');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown format "(missing value)"'),
    );
  });

  it('supports quoted file paths in typed slash commands', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'typed', commandLine: '/check-dependencies "src/my file.ts"' })
      .mockResolvedValueOnce({ kind: 'quit' });

    mocks.selectPostResultAction.mockResolvedValueOnce('quit');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.checkDependenciesRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/my file.ts')],
      runtime,
      'json',
    );
  });

  it('executes cycles slash command', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'typed', commandLine: '/cycles src/index.ts' })
      .mockResolvedValueOnce({ kind: 'quit' });

    mocks.selectPostResultAction.mockResolvedValueOnce('quit');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.cyclesRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/index.ts')],
      runtime,
      'json',
    );
  });

  it('check-dependencies uses path command when direction is outgoing-only', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('checkDependencies')
      .mockResolvedValueOnce('quit');
    mocks.selectPostResultAction.mockResolvedValueOnce('quit');
    mocks.searchFile.mockResolvedValueOnce('src/index.ts');
    mocks.askCheckDepsOptions.mockResolvedValueOnce({ direction: 'outgoing' });

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.pathRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/index.ts')],
      runtime,
      'json',
    );
    expect(mocks.checkDependenciesRun).not.toHaveBeenCalled();
  });

  it('check-dependencies uses pathIn command when direction is incoming-only', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('checkDependencies')
      .mockResolvedValueOnce('quit');
    mocks.selectPostResultAction.mockResolvedValueOnce('quit');
    mocks.searchFile.mockResolvedValueOnce('src/utils.ts');
    mocks.askCheckDepsOptions.mockResolvedValueOnce({ direction: 'incoming' });

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.pathInRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/utils.ts')],
      runtime,
      'json',
    );
    expect(mocks.checkDependenciesRun).not.toHaveBeenCalled();
  });

  it('post-result followUpDeps runs check-dependencies on last context file', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('trace')
      .mockResolvedValueOnce('quit');
    mocks.selectPostResultAction.mockResolvedValueOnce('followUpDeps');
    mocks.searchFile.mockResolvedValueOnce('src/index.ts');
    mocks.selectOrInputSymbol.mockResolvedValueOnce('myFn');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const expectedFile = path.resolve('/workspace', 'src/index.ts');
    expect(mocks.traceRun).toHaveBeenCalledWith(
      [`${expectedFile}#myFn`, '--maxDepth=10'],
      runtime,
      'json',
    );
    expect(mocks.checkDependenciesRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
  });

  it('post-result followUpCycles runs cycles on last context file', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce('trace')
      .mockResolvedValueOnce('quit');
    mocks.selectPostResultAction.mockResolvedValueOnce('followUpCycles');
    mocks.searchFile.mockResolvedValueOnce('src/utils.ts');
    mocks.selectOrInputSymbol.mockResolvedValueOnce('parse');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const expectedFile = path.resolve('/workspace', 'src/utils.ts');
    expect(mocks.cyclesRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
  });

  it('sets current file context with /file and reuses it for summary', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'typed', commandLine: '/file src/index.ts' })
      .mockResolvedValueOnce({ kind: 'typed', commandLine: '/summary' })
      .mockResolvedValueOnce({ kind: 'quit' });

    mocks.selectPostResultAction
      .mockResolvedValueOnce('newAnalysis')
      .mockResolvedValueOnce('quit');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.summaryRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/index.ts')],
      runtime,
      'json',
    );
  });

  it('executes a typed slash command selected directly from the palette', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'typed', commandLine: '/architecture --format mermaid' })
      .mockResolvedValueOnce({ kind: 'quit' });

    mocks.selectPostResultAction.mockResolvedValueOnce('quit');
    mocks.architectureRun.mockResolvedValueOnce(
      '{"nodes":[{"id":"a","relativePath":"src/a.ts"}],"edges":[]}',
    );

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.architectureRun).toHaveBeenCalledWith([], runtime, 'json');
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('graph LR'));
  });

  it('shows slash help without opening a post-result menu', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'action', action: 'help' })
      .mockResolvedValueOnce({ kind: 'quit' });

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Slash commands'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('/trace'));
    expect(mocks.selectPostResultAction).not.toHaveBeenCalled();
  });

  it('changes the default format from the slash palette action', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'action', action: 'format' })
      .mockResolvedValueOnce('quit');

    mocks.selectPreferredFormat.mockResolvedValueOnce('markdown');

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    expect(mocks.selectPreferredFormat).toHaveBeenCalledWith('text');
    expect(stdoutSpy).toHaveBeenCalledWith('Default format set to markdown.\n');
  });

  it('uses .mmd as default save extension for mermaid results', async () => {
    mocks.selectMainAction
      .mockResolvedValueOnce({ kind: 'typed', commandLine: '/architecture --format mermaid' })
      .mockResolvedValueOnce({ kind: 'quit' });

    mocks.selectPostResultAction.mockResolvedValueOnce('saveToFile');
    mocks.architectureRun.mockResolvedValueOnce(
      '{"nodes":[{"id":"a","relativePath":"src/a.ts"}],"edges":[]}',
    );

    const runtime = createRuntimeStub();
    await runWithRuntimeStub(runtime);

    const exportDir = path.join('.graph-it', 'exports', '');
    const escapedDir = exportDir.replaceAll('\\', '\\\\');
    expect(mocks.inputSavePath).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(String.raw`${escapedDir}.*-architecture\.mmd$`)),
    );
  });
});
