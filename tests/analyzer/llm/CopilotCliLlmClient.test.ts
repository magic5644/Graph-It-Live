/// <reference types="node" />

/**
 * Unit tests for CopilotCliLlmClient.
 *
 * `node:child_process` is mocked so no binary is ever spawned: the Copilot CLI
 * is not installed on CI, and hard-coding a real one (`/bin/echo`) would not
 * exist on Windows.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  // The client promisifies execFile, so expose the promisified form Node uses.
  execFile: Object.assign(
    () => {
      throw new Error('callback form of execFile is not used by the client');
    },
    { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execFileAsync },
  ),
}));

import {
  buildCopilotPrompt,
  cleanCopilotOutput,
  CopilotCliLlmClient,
} from '../../../src/analyzer/llm/CopilotCliLlmClient';

const COPILOT_OUTPUT = [
  '```json',
  '["call graph", "indexer"]',
  '```',
  '',
  'Changes    +0 -0',
  'AI Credits 2.47 (5s)',
  'Tokens     ↑ 20.7k • ↓ 310',
  'Resume     copilot --resume=b0102fdc',
].join('\n');

beforeEach(() => {
  mocks.execFileAsync.mockReset();
});

describe('cleanCopilotOutput', () => {
  it('strips the session trailer and code fences, keeping the answer', () => {
    expect(cleanCopilotOutput(COPILOT_OUTPUT)).toBe('["call graph", "indexer"]');
  });

  it('leaves plain output untouched apart from trimming', () => {
    expect(cleanCopilotOutput('  hello world \n')).toBe('hello world');
  });

  it('does not strip answer lines that merely mention a trailer word', () => {
    // "Tokens" only starts a trailer line; inside a sentence it must survive.
    expect(cleanCopilotOutput('The Tokens are counted here.')).toBe(
      'The Tokens are counted here.',
    );
  });
});

describe('buildCopilotPrompt', () => {
  it('flattens messages, tagging non-user roles', () => {
    const prompt = buildCopilotPrompt([
      { role: 'system', content: 'Return JSON only.' },
      { role: 'user', content: 'Question: how does X work' },
    ]);

    expect(prompt).toBe('[system] Return JSON only.\n\nQuestion: how does X work');
  });

  it('returns an empty string for no messages', () => {
    expect(buildCopilotPrompt([])).toBe('');
  });
});

describe('CopilotCliLlmClient.isAvailable', () => {
  it('is true when the binary answers --version', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '1.0.80\n', stderr: '' });

    expect(await new CopilotCliLlmClient('copilot').isAvailable()).toBe(true);
    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'copilot',
      ['--version'],
      expect.any(Object),
    );
  });

  it('is false when the binary cannot be spawned', async () => {
    mocks.execFileAsync.mockRejectedValueOnce(new Error('ENOENT'));

    expect(await new CopilotCliLlmClient('missing-binary').isAvailable()).toBe(false);
  });

  it('exposes the copilot-cli provider name', () => {
    expect(new CopilotCliLlmClient('copilot').providerName).toBe('copilot-cli');
  });

  it('defaults the binary to GRAPH_IT_COPILOT_BIN when set', async () => {
    const previous = process.env.GRAPH_IT_COPILOT_BIN;
    process.env.GRAPH_IT_COPILOT_BIN = 'custom-copilot';
    try {
      mocks.execFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await new CopilotCliLlmClient().isAvailable();
      expect(mocks.execFileAsync).toHaveBeenCalledWith(
        'custom-copilot',
        ['--version'],
        expect.any(Object),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.GRAPH_IT_COPILOT_BIN;
      } else {
        process.env.GRAPH_IT_COPILOT_BIN = previous;
      }
    }
  });
});

describe('CopilotCliLlmClient.complete', () => {
  it('returns the cleaned stdout of the binary', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: COPILOT_OUTPUT, stderr: '' });

    const result = await new CopilotCliLlmClient('copilot').complete([
      { role: 'user', content: 'extract keywords' },
    ]);

    expect(result.text).toBe('["call graph", "indexer"]');
    expect(result.tokensUsed).toBeUndefined();
  });

  it('passes the flattened prompt with tools disabled', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: 'ok', stderr: '' });

    await new CopilotCliLlmClient('copilot').complete([
      { role: 'system', content: 'Return JSON only.' },
      { role: 'user', content: 'extract keywords' },
    ]);

    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'copilot',
      ['-p', '[system] Return JSON only.\n\nextract keywords', '--available-tools', '--no-color'],
      expect.any(Object),
    );
  });

  it('runs outside the caller cwd so repository instructions are not loaded', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: 'ok', stderr: '' });

    await new CopilotCliLlmClient('copilot').complete([{ role: 'user', content: 'hi' }]);

    const options = mocks.execFileAsync.mock.calls[0][2] as { cwd?: string };
    expect(options.cwd).toBeDefined();
    expect(options.cwd).not.toBe(process.cwd());
    // Must live in the OS temp area, i.e. outside any git repository.
    expect(path.dirname(options.cwd as string)).toBe(path.resolve(os.tmpdir()));
  });

  it('rejects when the binary cannot be spawned', async () => {
    mocks.execFileAsync.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(
      new CopilotCliLlmClient('missing-binary').complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('ENOENT');
  });
});
