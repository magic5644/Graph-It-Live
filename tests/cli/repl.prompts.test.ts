import { describe, expect, it } from 'vitest';
import {
  buildMainActionChoices,
  buildDirectoryBrowserChoices,
  buildPostResultChoices,
  buildFileBrowserChoices,
  handleDirectorySelection,
  resolveJumpTarget,
} from '../../src/cli/repl/prompts';
import { sanitizeTerminalText } from '../../src/cli/repl/terminal';

describe('buildMainActionChoices', () => {
  it('stays quiet for empty input until the user types slash', () => {
    const choices = buildMainActionChoices('');
    expect(choices).toEqual([]);
  });

  it('prepends a typed command action when the user enters a command line', () => {
    const choices = buildMainActionChoices('/architecture --format mermaid');
    expect(choices[0]).toMatchObject({
      name: expect.stringContaining('Run typed command'),
      value: { kind: 'typed', commandLine: '/architecture --format mermaid' },
    });
  });

  it('sanitizes control characters in the typed command preview', () => {
    const choices = buildMainActionChoices('/trace \u001b]8;;https://evil.test\u0007boom');
    expect(choices[0]?.name).not.toContain('\u001b');
    expect(choices[0]?.name).not.toContain('\u0007');
    expect(choices[0]?.name).toContain('/trace');
  });

  it('stays quiet for plain text queries without slash', () => {
    const choices = buildMainActionChoices('arch');
    expect(choices).toEqual([]);
  });

  it('shows slash suggestions when slash is typed', () => {
    const choices = buildMainActionChoices('/a');
    expect(choices.some((choice) => choice.name.includes('/architecture'))).toBe(true);
  });

  it('includes check-dependencies slash entry', () => {
    const choices = buildMainActionChoices('/check-d');
    expect(choices.some((choice) => choice.name.includes('/check-dependencies'))).toBe(true);
  });
});

describe('buildPostResultChoices', () => {
  it('stays quiet for follow-up actions until slash is typed', () => {
    const choices = buildPostResultChoices('');
    expect(choices).toEqual([]);
  });

  it('shows slash-style follow-up actions once slash is typed', () => {
    const choices = buildPostResultChoices('/');
    expect(choices.some((choice) => choice.name.includes('/save'))).toBe(true);
    expect(choices.some((choice) => choice.name.includes('/export'))).toBe(true);
  });
});

describe('buildFileBrowserChoices', () => {
  it('shows top-level directories and files', () => {
    const choices = buildFileBrowserChoices(
      [
        'src/index.ts',
        'src/cli/repl.ts',
        'README.md',
      ],
      '',
    );

    expect(choices[0]).toMatchObject({ value: '__jump__' });
    expect(choices.some((choice) => choice.value === 'dir:src')).toBe(true);
    expect(choices.some((choice) => choice.value === 'file:README.md')).toBe(true);
  });

  it('shows parent navigation and nested entries in subdirectories', () => {
    const choices = buildFileBrowserChoices(
      [
        'src/index.ts',
        'src/cli/repl.ts',
        'src/cli/prompts.ts',
        'src/shared/path.ts',
      ],
      'src',
    );

    expect(choices[0]).toMatchObject({ value: '__jump__' });
    expect(choices[1]).toMatchObject({ value: '__up__' });
    expect(choices.some((choice) => choice.value === 'dir:src/cli')).toBe(true);
    expect(choices.some((choice) => choice.value === 'file:src/index.ts')).toBe(true);
  });

  it('shows an empty-state message for directories without files', () => {
    const choices = buildFileBrowserChoices(['src/index.ts'], 'docs');
    expect(choices).toEqual([
      {
        name: '⌨ Jump to path…',
        value: '__jump__',
      },
      {
        name: '↩ Go to parent directory',
        value: '__up__',
      },
      {
        name: 'No files found in this directory',
        value: '__empty__',
        disabled: true,
      },
    ]);
  });
});

describe('buildDirectoryBrowserChoices', () => {
  it('shows select-current first for fast Enter validation', () => {
    const choices = buildDirectoryBrowserChoices(['src/index.ts', 'src/cli/repl.ts'], 'src');
    expect(choices[0]).toMatchObject({ value: '__select_current__' });
    expect(choices[1]).toMatchObject({ value: '__jump__' });
  });
});

describe('handleDirectorySelection', () => {
  it('selects a directory when choosing a directory entry', async () => {
    const result = await handleDirectorySelection(
      'dir:src/cli',
      ['src/index.ts', 'src/cli/repl.ts'],
      'src',
    );

    expect(result).toEqual({ selectedDirectory: 'src/cli' });
  });

  it('keeps support for selecting current directory quickly', async () => {
    const result = await handleDirectorySelection(
      '__select_current__',
      ['src/index.ts'],
      'src',
    );

    expect(result).toEqual({ selectedDirectory: 'src' });
  });
});

describe('sanitizeTerminalText', () => {
  it('removes ANSI, control and bidi characters', () => {
    const raw = 'hello\u001b[31m world\u202Eevil\u009bboom';
    expect(sanitizeTerminalText(raw)).toBe('hello [31m world evil boom');
  });
});

describe('resolveJumpTarget', () => {
  const relativeFiles = [
    'src/index.ts',
    'src/cli/repl.ts',
    'src/shared/path.ts',
    'README.md',
  ];

  it('resolves exact file from workspace-relative input', () => {
    expect(resolveJumpTarget(relativeFiles, '', 'src/index.ts')).toEqual({
      kind: 'file',
      value: 'src/index.ts',
    });
  });

  it('resolves file relative to current directory', () => {
    expect(resolveJumpTarget(relativeFiles, 'src', 'cli/repl.ts')).toEqual({
      kind: 'file',
      value: 'src/cli/repl.ts',
    });
  });

  it('resolves directory target for quick navigation', () => {
    expect(resolveJumpTarget(relativeFiles, '', 'src/cli')).toEqual({
      kind: 'directory',
      value: 'src/cli',
    });
  });

  it('returns suggestions when path does not exist', () => {
    const resolution = resolveJumpTarget(relativeFiles, '', 'path');
    expect(resolution.kind).toBe('none');
    if (resolution.kind !== 'none') {
      throw new Error('Expected not-found resolution');
    }
    expect(resolution.suggestions.length).toBeGreaterThan(0);
  });
});
