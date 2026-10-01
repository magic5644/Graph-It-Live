/**
 * Ink REPL session bridge tests.
 *
 * The Ink UI is replaced by a stub that captures the options passed to
 * runInkReplSession, so the onSubmitCommand bridge can be driven directly.
 */

/// <reference types="node" />

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntime } from '../../src/cli/runtime';
import type { InkReplCommandResponse } from '../../src/cli/repl/ink/ReplInkApp';

type SubmitCommand = (commandLine: string) => Promise<InkReplCommandResponse>;

const mocks = vi.hoisted(() => ({
  runInkReplSession: vi.fn(),
}));

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

async function startInkSession(): Promise<{ preferredFormat: string; submit: SubmitCommand }> {
  let captured: { preferredFormat: string; onSubmitCommand: SubmitCommand } | undefined;
  mocks.runInkReplSession.mockImplementation(async (options) => {
    captured = options;
  });
  const runtime = {
    workspaceRoot: '/workspace',
    init: vi.fn().mockResolvedValue(undefined),
    ensureIndexed: vi.fn().mockResolvedValue({ filesIndexed: 1, durationMs: 1 }),
  };
  await run(runtime as unknown as CliRuntime);
  if (!captured) {
    throw new Error('runInkReplSession was not called');
  }
  return { preferredFormat: captured.preferredFormat, submit: captured.onSubmitCommand };
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

  it('sends no context update when /format sets the current format again', async () => {
    const session = await startInkSession();

    const response = await session.submit('/format text');

    expect(response.updatedContext).toBeUndefined();
  });
});
