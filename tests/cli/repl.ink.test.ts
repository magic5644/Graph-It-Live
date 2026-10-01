/**
 * Ink REPL session bridge tests.
 *
 * The Ink UI is replaced by a stub that captures the options passed to
 * runInkReplSession, so the onSubmitCommand bridge can be driven directly.
 */

/// <reference types="node" />

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntime } from '../../src/cli/runtime';
import type { InkReplCommandResponse } from '../../src/cli/repl/ink/ReplInkApp';

type SubmitCommand = (commandLine: string) => Promise<InkReplCommandResponse>;

const mocks = vi.hoisted(() => ({
  runInkReplSession: vi.fn(),
  explainRun: vi.fn(),
}));

vi.mock('../../src/cli/commands/explain.js', () => ({ run: mocks.explainRun }));

vi.mock('../../src/cli/repl/ink/ReplInkApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/repl/ink/ReplInkApp.js')>()),
  runInkReplSession: mocks.runInkReplSession,
}));

vi.mock('../../src/analyzer/SourceFileCollector.js', () => ({
  SourceFileCollector: class {
    collectAllSourceFiles = vi.fn().mockResolvedValue([path.resolve('/workspace', 'src/index.ts')]);
  },
}));

import { run } from '../../src/cli/commands/repl';

interface InkSession {
  preferredFormat: string;
  submit: SubmitCommand;
  listFileSymbols?: (absoluteFile: string) => Promise<string[]>;
}

async function startInkSession(workspaceRoot = '/workspace'): Promise<InkSession> {
  let captured: {
    preferredFormat: string;
    onSubmitCommand: SubmitCommand;
    listFileSymbols?: (absoluteFile: string) => Promise<string[]>;
  } | undefined;
  mocks.runInkReplSession.mockImplementation(async (options) => {
    captured = options;
  });
  const runtime = {
    workspaceRoot,
    init: vi.fn().mockResolvedValue(undefined),
    ensureIndexed: vi.fn().mockResolvedValue({ filesIndexed: 1, durationMs: 1 }),
  };
  await run(runtime as unknown as CliRuntime);
  if (!captured) {
    throw new Error('runInkReplSession was not called');
  }
  return {
    preferredFormat: captured.preferredFormat,
    submit: captured.onSubmitCommand,
    listFileSymbols: captured.listFileSymbols,
  };
}

describe('Ink REPL session context', () => {
  beforeEach(() => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('GRAPH_IT_REPL_LEGACY', '');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mocks.runInkReplSession.mockReset();
    mocks.explainRun.mockReset();
  });

  it('reports the new preferred format after /format so the header can refresh', async () => {
    const session = await startInkSession();
    expect(session.preferredFormat).toBe('text');

    const response = await session.submit('/format markdown');

    expect(response.output).toBe('Default format set to markdown.');
    expect(response.updatedContext).toEqual({ preferredFormat: 'markdown' });
  });

  it('sends no context update when /format gets an unknown value', async () => {
    const session = await startInkSession();

    const response = await session.submit('/format bogus');

    expect(response.output).toContain('Unknown format "bogus"');
    expect(response.updatedContext).toBeUndefined();
  });

  it('sets the workspace scope with /scope and with the hidden /path alias', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-scope-'));
    try {
      await fs.mkdir(path.join(workspaceRoot, 'src'));
      const session = await startInkSession(workspaceRoot);

      const aliased = await session.submit('/path src');
      // Relative to the current scope, so '.' keeps src.
      const scoped = await session.submit('/scope .');

      expect(aliased.output).toBe('Session workspace set to src.');
      expect(scoped.output).toBe('Session workspace set to src.');

      // An absolute path keeps its separators, backslashes included on Windows.
      const absolute = await session.submit(`/scope ${path.join(workspaceRoot, 'src')}`);
      expect(absolute.output).toBe('Session workspace set to src.');
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('shows /scope usage without an argument and refuses a directory outside the root', async () => {
    const session = await startInkSession();

    const usage = await session.submit('/scope');
    const outside = await session.submit('/scope ..');

    expect(usage.output).toContain('Usage: /scope <directory>');
    expect(outside.output).toBe('Refusing to set workspace scope outside project root.');
  });

  it('sends no context update when /format sets the current format again', async () => {
    const session = await startInkSession();

    const response = await session.submit('/format text');

    expect(response.updatedContext).toBeUndefined();
  });

  it('lists file symbols for # completion, sorted and deduplicated', async () => {
    mocks.explainRun.mockResolvedValue(JSON.stringify({
      nodes: [{ symbolName: 'run' }, { symbolName: 'Helper.method' }],
      symbols: [{ name: 'run' }],
    }));
    const session = await startInkSession();
    const file = path.resolve('/workspace', 'src/index.ts');

    await expect(session.listFileSymbols?.(file)).resolves.toEqual(['Helper.method', 'run']);
    expect(mocks.explainRun).toHaveBeenCalledWith([file], expect.anything(), 'json');
  });

  it('lists no symbols when extraction fails', async () => {
    mocks.explainRun.mockRejectedValue(new Error('parse failed'));
    const session = await startInkSession();

    await expect(session.listFileSymbols?.(path.resolve('/workspace', 'src/index.ts'))).resolves.toEqual([]);
  });
});
