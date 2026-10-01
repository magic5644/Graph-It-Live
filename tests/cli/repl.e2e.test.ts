/**
 * REPL end-to-end chaining tests.
 *
 * The Ink UI is replaced by a stub that captures onSubmitCommand, so typed
 * command lines run through the real REPL command handler with mocked
 * runtime/commands to validate command chaining between submissions.
 */

/// <reference types="node" />

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntime } from '../../src/cli/runtime';
import type { InkReplCommandResponse } from '../../src/cli/repl/ink/ReplInkApp';

type SubmitCommand = (commandLine: string) => Promise<InkReplCommandResponse>;

const mocks = vi.hoisted(() => ({
  runInkReplSession: vi.fn(),

  traceRun: vi.fn(),
  pathRun: vi.fn(),
  pathInRun: vi.fn(),
  explainRun: vi.fn(),
  summaryRun: vi.fn(),
  architectureRun: vi.fn(),
  checkDependenciesRun: vi.fn(),
  cyclesRun: vi.fn(),
  checkRun: vi.fn(),
  toolRun: vi.fn(),
  contextRun: vi.fn(),
  reviewPrRun: vi.fn(),
}));

vi.mock('../../src/cli/repl/ink/ReplInkApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/repl/ink/ReplInkApp.js')>()),
  runInkReplSession: mocks.runInkReplSession,
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
vi.mock('../../src/cli/commands/tool.js', () => ({ run: mocks.toolRun }));
vi.mock('../../src/cli/commands/context.js', () => ({ run: mocks.contextRun }));
vi.mock('../../src/cli/commands/reviewPr.js', () => ({ run: mocks.reviewPrRun }));

import { run } from '../../src/cli/commands/repl';

function createRuntimeStub() {
  return {
    workspaceRoot: '/workspace',
    init: vi.fn().mockResolvedValue(undefined),
    ensureIndexed: vi.fn().mockResolvedValue({ filesIndexed: 2, durationMs: 1 }),
  };
}

/** Start the REPL, then submit each command line in order through the Ink bridge. */
async function typedSession(
  runtime: ReturnType<typeof createRuntimeStub>,
  ...commandLines: string[]
): Promise<InkReplCommandResponse[]> {
  let submit: SubmitCommand | undefined;
  mocks.runInkReplSession.mockImplementation(async (options: { onSubmitCommand: SubmitCommand }) => {
    submit = options.onSubmitCommand;
  });
  await run(runtime as unknown as CliRuntime);
  if (!submit) {
    throw new Error('runInkReplSession was not called');
  }
  const responses: InkReplCommandResponse[] = [];
  for (const commandLine of commandLines) {
    responses.push(await submit(commandLine));
  }
  return responses;
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

    mocks.traceRun.mockResolvedValue('{"trace":"ok"}');
    mocks.pathRun.mockResolvedValue('{"path":"ok"}');
    mocks.pathInRun.mockResolvedValue('{"pathIn":"ok"}');
    mocks.explainRun.mockResolvedValue('{"explain":"ok"}');
    mocks.summaryRun.mockResolvedValue('{"summary":"ok"}');
    mocks.architectureRun.mockResolvedValue('{"architecture":"ok"}');
    mocks.checkDependenciesRun.mockResolvedValue('{"outgoing":{},"incoming":{}}');
    mocks.cyclesRun.mockResolvedValue('{"cycleCount":0,"confirmedCycles":[]}');
    mocks.checkRun.mockResolvedValue('{"check":"ok"}');
    mocks.toolRun.mockResolvedValue('{"tool":"ok"}');
    mocks.contextRun.mockResolvedValue('{"context":"ok"}');
    mocks.reviewPrRun.mockResolvedValue('{"review":"ok"}');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints the no-TTY message and does not start the UI without a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await run(createRuntimeStub() as unknown as CliRuntime);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Interactive mode unavailable (no TTY).'));
    expect(mocks.runInkReplSession).not.toHaveBeenCalled();
  });

  it('reports a scan error and does not start the UI when indexing fails', async () => {
    const runtime = createRuntimeStub();
    runtime.ensureIndexed.mockRejectedValueOnce(new Error('disk full'));

    await run(runtime as unknown as CliRuntime);

    expect(stderrSpy).toHaveBeenCalledWith('Scan error: disk full\n');
    expect(mocks.runInkReplSession).not.toHaveBeenCalled();
  });

  it('says goodbye once the UI session ends', async () => {
    await typedSession(createRuntimeStub());

    expect(stdoutSpy).toHaveBeenCalledWith('\nGoodbye!\n');
  });

  it('runs /callers through query_call_graph and reuses the symbol for /impact', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/callers src/index.ts#main --depth=3', '/impact --includeTransitive=true');

    const filePath = path.resolve('/workspace', 'src/index.ts');
    expect(mocks.toolRun).toHaveBeenNthCalledWith(
      1,
      ['query_call_graph', '--args', JSON.stringify({ direction: 'callers', filePath, symbolName: 'main' }), '--depth=3'],
      runtime,
      'json',
    );
    expect(mocks.toolRun).toHaveBeenNthCalledWith(
      2,
      ['get_impact_analysis', '--args', JSON.stringify({ filePath, symbolName: 'main' }), '--includeTransitive=true'],
      runtime,
      'json',
    );
  });

  it('keeps backslashes of a Windows-style symbol target intact in the tool arguments', async () => {
    await typedSession(createRuntimeStub(), String.raw`/callers src\utils.ts#parse`);

    const [args] = mocks.toolRun.mock.calls[0] as [string[]];
    expect(JSON.parse(args[2])).toEqual({
      direction: 'callers',
      filePath: path.resolve('/workspace', String.raw`src\utils.ts`),
      symbolName: 'parse',
    });
  });

  it('asks for a symbol when /callers or /impact has no symbol context', async () => {
    const [, callers, impact] = await typedSession(createRuntimeStub(), '/file src/index.ts', '/callers', '/impact');

    expect(mocks.toolRun).not.toHaveBeenCalled();
    expect(callers.output).toContain('/callers needs a symbol');
    expect(impact.output).toContain('/impact needs a symbol');
  });

  it('runs /explain on the current file and keeps that file as context', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/file src/utils.ts', '/explain', '/summary');

    const filePath = path.resolve('/workspace', 'src/utils.ts');
    expect(mocks.explainRun).toHaveBeenCalledWith([filePath], runtime, 'json');
    expect(mocks.summaryRun).toHaveBeenCalledWith([filePath], runtime, 'json');
  });

  it('asks for a file when /explain has no file context', async () => {
    const [response] = await typedSession(createRuntimeStub(), '/explain');

    expect(mocks.explainRun).not.toHaveBeenCalled();
    expect(response.output).toContain('Explain needs a file');
  });

  it('passes a /context question through and seeds a bare /context with the current symbol', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/context how is the index built --detail compact', '/callers src/index.ts#main', '/context');

    expect(mocks.contextRun).toHaveBeenNthCalledWith(
      1,
      ['how', 'is', 'the', 'index', 'built', '--detail', 'compact'],
      runtime,
      'json',
    );
    expect(mocks.contextRun).toHaveBeenNthCalledWith(
      2,
      ['--seeds', `${path.resolve('/workspace', 'src/index.ts')}#main`],
      runtime,
      'json',
    );
  });

  it('asks for a question when /context has no symbol context', async () => {
    const [response] = await typedSession(createRuntimeStub(), '/context');

    expect(mocks.contextRun).not.toHaveBeenCalled();
    expect(response.output).toContain('Context needs a question or a symbol');
  });

  it('runs /review-pr with its flags', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/review-pr --base origin/main');

    expect(mocks.reviewPrRun).toHaveBeenCalledWith(['--base', 'origin/main'], runtime, 'json');
  });

  it('chains the traced file and symbol into /check and /callers', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/trace src/index.ts#main --maxDepth=10', '/check', '/callers');

    const expectedFile = path.resolve('/workspace', 'src/index.ts');
    expect(mocks.traceRun).toHaveBeenCalledWith([`${expectedFile}#main`, '--maxDepth', '10'], runtime, 'json');
    expect(mocks.checkRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
    expect(JSON.parse((mocks.toolRun.mock.calls[0] as [string[]])[0][2])).toMatchObject({
      filePath: expectedFile,
      symbolName: 'main',
    });
  });

  it('keeps the file context across /format, /help and usage messages', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/file src/utils.ts', '/format json', '/help', '/callers', '/summary');

    expect(mocks.summaryRun).toHaveBeenCalledWith([path.resolve('/workspace', 'src/utils.ts')], runtime, 'json');
  });

  it('drops the symbol when a command moves the context to another file', async () => {
    const [, , callers] = await typedSession(
      createRuntimeStub(),
      '/trace src/index.ts#main',
      '/check-dependencies src/utils.ts',
      '/callers',
    );

    expect(mocks.toolRun).not.toHaveBeenCalled();
    expect(callers.output).toContain('/callers needs a symbol');
  });

  it('explains the file when /trace has no symbol and keeps the file for /summary', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/trace src/utils.ts', '/summary');

    const expectedFile = path.resolve('/workspace', 'src/utils.ts');
    expect(mocks.traceRun).not.toHaveBeenCalled();
    expect(mocks.explainRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
    expect(mocks.summaryRun).toHaveBeenCalledWith([expectedFile], runtime, 'json');
  });

  it('asks for a file context when /trace has none', async () => {
    const [response] = await typedSession(createRuntimeStub(), '/trace');

    expect(mocks.traceRun).not.toHaveBeenCalled();
    expect(response.output).toContain('Trace needs a file context');
  });

  it('runs /architecture without arguments and passes --maxFiles=N as two arguments', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/architecture', '/architecture --maxFiles=100');

    expect(mocks.architectureRun).toHaveBeenNthCalledWith(1, [], runtime, 'json');
    expect(mocks.architectureRun).toHaveBeenNthCalledWith(2, ['--maxFiles', '100'], runtime, 'json');
  });

  it('uses the session format set with /format on the next command', async () => {
    mocks.summaryRun.mockResolvedValue('{"filesIndexed":2}');

    const [, summary] = await typedSession(createRuntimeStub(), '/format mermaid', '/summary');

    expect(summary.output).toContain('graph TD');
    expect(stdoutSpy).not.toHaveBeenCalledWith(
      'Rendered in text (default mermaid unsupported for this command).\n',
    );
  });

  it('renders a typed --format override and strips the graph-it prefix', async () => {
    const runtime = createRuntimeStub();
    mocks.architectureRun.mockResolvedValueOnce(
      '{"nodes":[{"id":"a","relativePath":"src/a.ts"}],"edges":[]}',
    );

    const [response] = await typedSession(runtime, 'graph-it architecture --format mermaid');

    expect(mocks.architectureRun).toHaveBeenCalledWith([], runtime, 'json');
    expect(response.output).toContain('graph LR');
  });

  it('warns when an unknown or missing --format value is given', async () => {
    mocks.architectureRun.mockResolvedValue('{"nodes":[],"edges":[]}');

    await typedSession(createRuntimeStub(), '/architecture --format banana', '/architecture --format');

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown format "banana"'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown format "(missing value)"'));
  });

  it('supports quoted file paths in typed slash commands', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/check-dependencies "src/my file.ts"');

    expect(mocks.checkDependenciesRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/my file.ts')],
      runtime,
      'json',
    );
  });

  it('executes cycles slash command', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/cycles src/index.ts');

    expect(mocks.cyclesRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/index.ts')],
      runtime,
      'json',
    );
  });

  it('routes /check-dependencies --outgoing to path and --incoming to path-in', async () => {
    const runtime = createRuntimeStub();
    await typedSession(runtime, '/check-dependencies src/index.ts --outgoing', '/deps src/utils.ts --in');

    expect(mocks.pathRun).toHaveBeenCalledWith([path.resolve('/workspace', 'src/index.ts')], runtime, 'json');
    expect(mocks.pathInRun).toHaveBeenCalledWith([path.resolve('/workspace', 'src/utils.ts')], runtime, 'json');
    expect(mocks.checkDependenciesRun).not.toHaveBeenCalled();
  });

  it('asks for a file when /check-dependencies has no file context', async () => {
    const [response] = await typedSession(createRuntimeStub(), '/check-dependencies');

    expect(mocks.checkDependenciesRun).not.toHaveBeenCalled();
    expect(response.output).toContain('check-dependencies needs a file path');
  });

  it('sets current file context with /file and reuses it for summary', async () => {
    const runtime = createRuntimeStub();
    const [file] = await typedSession(runtime, '/file src/index.ts', '/summary');

    expect(file.output).toBe(`Current file context set to ${path.join('src', 'index.ts')}.`);
    expect(mocks.summaryRun).toHaveBeenCalledWith(
      [path.resolve('/workspace', 'src/index.ts')],
      runtime,
      'json',
    );
  });

  it('shows the current file context or usage for a bare /file', async () => {
    const [none, , current] = await typedSession(createRuntimeStub(), '/file', '/file src/index.ts', '/file');

    expect(none.output).toBe('No file context set. Usage: /file <path>');
    expect(current.output).toBe(`Current file context: ${path.join('src', 'index.ts')}. Usage: /file <path>`);
  });

  it('shows slash help', async () => {
    const [response] = await typedSession(createRuntimeStub(), '/help');

    expect(response.output).toContain('Slash commands');
    expect(response.output).toContain('/trace');
    expect(response.output).toContain('/scan');
  });

  it('quits on /quit and reports empty, invalid and unknown command lines', async () => {
    const [quit, empty, prefixOnly, invalid, unknown] = await typedSession(
      createRuntimeStub(),
      '/quit',
      '   ',
      'graph-it',
      '/file "unterminated',
      '/bogus',
    );

    expect(quit.shouldQuit).toBe(true);
    expect(empty.output).toContain('Empty command.');
    expect(prefixOnly.output).toBe('No command provided after graph-it prefix.');
    expect(invalid.output).toContain('Invalid command line:');
    expect(unknown.output).toContain('Unknown REPL command "bogus"');
  });
});
