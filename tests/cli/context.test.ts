import { describe, expect, it, vi } from 'vitest';
import { CliError, ExitCode } from '../../src/cli/errors.js';

const executeGraphContext = vi.hoisted(() => vi.fn());

vi.mock('../../src/mcp/tools', () => ({ executeGraphContext }));

import { run } from '../../src/cli/commands/context.js';

const runtime = {
  workspaceRoot: '/workspace',
  ensureIndexed: vi.fn().mockResolvedValue(undefined),
} as never;

describe('context command', () => {
  it('parses a question request and forwards context options', async () => {
    executeGraphContext.mockResolvedValueOnce({ mode: 'search', nodes: [], edges: [] });

    await run(
      ['how does authentication reach the database', '--mode', 'search', '--scope', 'src/**', '--depth', '2', '--token-budget', '2000', '--format', 'toon'],
      runtime,
      'text',
    );

    expect(executeGraphContext).toHaveBeenCalledWith({
      question: 'how does authentication reach the database',
      mode: 'search',
      scope: 'src/**',
      depth: 2,
      tokenBudget: 2000,
      format: 'toon',
    });
  });

  it('parses endpoint symbols for path mode', async () => {
    executeGraphContext.mockResolvedValueOnce({ mode: 'path', nodes: [], edges: [] });

    await run(
      ['--from', 'src/api/controller.ts#UserController', '--to', 'DatabasePool', '--mode', 'path', '--format', 'json'],
      runtime,
      'text',
    );

    expect(executeGraphContext).toHaveBeenCalledWith({
      from: { filePath: 'src/api/controller.ts', symbolName: 'UserController' },
      to: { symbolName: 'DatabasePool' },
      mode: 'path',
      format: 'json',
    });
  });

  it('forwards repeatable seeds, relations, directed traversal, cursor, and accepts workspace', async () => {
    executeGraphContext.mockResolvedValueOnce({ mode: 'neighbors', nodes: [], edges: [] });

    await run(
      [
        '--seeds', 'src/api/controller.ts#UserController',
        '--seeds', 'DatabasePool',
        '--relations', 'CALLS',
        '--relations', 'IMPORTS',
        '--directed',
        '--cursor', 'next-page',
        '--workspace', '/workspace',
      ],
      runtime,
      'text',
    );

    expect(executeGraphContext).toHaveBeenCalledWith({
      seeds: [
        { filePath: 'src/api/controller.ts', symbolName: 'UserController' },
        { symbolName: 'DatabasePool' },
      ],
      relations: ['CALLS', 'IMPORTS'],
      directed: true,
      cursor: 'next-page',
      format: 'toon',
    });
  });

  it.each([
    ['missing question and endpoints', []],
    ['only one endpoint', ['--from', 'src/a.ts#A']],
    ['path mode without endpoints', ['question', '--mode', 'path']],
  ])('rejects %s', async (_name, args) => {
    await expect(run(args, runtime, 'text')).rejects.toMatchObject({
      name: CliError.name,
      exitCode: ExitCode.GENERAL_ERROR,
    });
  });
});
