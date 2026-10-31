/**
 * Ink REPL slash palette tests: canonical commands only, grouped by intent,
 * hidden aliases still resolved for argument completion.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendTypedInput,
  cycleNextStepHint,
  filterSlashCommands,
  findSymbolCompletionFile,
  getNextStepHints,
  getSlashCommandHelpLines,
  nextScrollTop,
  resolveArrowTarget,
  stepHistory,
  toLines,
  wrapLines,
} from '../../src/cli/repl/ink/ReplInkApp';

const HIDDEN_ALIASES = ['/path', '/deps', '/dependencies', '/deps-in', '/deps-out', '/path-in', '/path-out', '/cycle'];

const workspaceRoot = path.resolve('/workspace');
const allFiles = [
  path.join(workspaceRoot, 'src', 'cli', 'index.ts'),
  path.join(workspaceRoot, 'src', 'shared', 'path.ts'),
];

describe('Ink slash palette', () => {
  it('lists only canonical commands, grouped by intent', () => {
    const entries = filterSlashCommands('/', allFiles, workspaceRoot);
    const commands = entries.map((entry) => entry.command);

    expect(commands).toContain('/scope');
    expect(commands).not.toContain('/command');
    for (const alias of HIDDEN_ALIASES) {
      expect(commands).not.toContain(alias);
    }

    const groups = entries.map((entry) => entry.group);
    expect([...new Set(groups)]).toEqual(['Navigate', 'Understand', 'Relations', 'Workspace', 'Output', 'Session']);
    // Each group is contiguous: no group appears again after another one.
    const firstIndexOfEachGroup = [...new Set(groups)].map((group) => groups.indexOf(group));
    expect(firstIndexOfEachGroup).toEqual([...firstIndexOfEachGroup].sort((left, right) => left - right));
    expect(groups.lastIndexOf('Navigate')).toBeLessThan(groups.indexOf('Understand'));
  });

  it('suggests directories for the /path alias as for /scope', () => {
    const scope = filterSlashCommands('/scope src', allFiles, workspaceRoot).map((entry) => entry.command);
    const alias = filterSlashCommands('/path src', allFiles, workspaceRoot).map((entry) => entry.command);

    expect(scope).toEqual(['src', 'src/cli', 'src/shared']);
    expect(alias).toEqual(scope);
  });

  it('suggests files for a typed dependency alias', () => {
    const suggestions = filterSlashCommands('/deps src/cli', allFiles, workspaceRoot);

    expect(suggestions.map((entry) => entry.command)).toContain('src/cli/index.ts');
  });

  it('returns no argument suggestions for an unknown command', () => {
    expect(filterSlashCommands('/unknown src', allFiles, workspaceRoot)).toEqual([]);
  });

  it('builds forward-slash directory suggestions from Windows-style paths', () => {
    const windowsRoot = String.raw`C:\repo`;
    const windowsFiles = [String.raw`C:\repo\src\cli\index.ts`];

    const suggestions = [
      ...filterSlashCommands('/scope ', windowsFiles, windowsRoot),
      ...filterSlashCommands('/path-in ', windowsFiles, windowsRoot),
    ].map((entry) => entry.command);

    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion).not.toContain('\\');
    }
  });

  it('prints group headings and the alias list in help', () => {
    const lines = getSlashCommandHelpLines();
    const text = lines.join('\n');

    expect(text).toContain('Navigate');
    expect(text).toContain('/scope <directory>');
    expect(text).toContain('/check-architecture [--config <file>] [--baseline <file>] [--update-baseline]');
    expect(text).toContain('/path → /scope');
    expect(text).toContain('/deps-in → /check-dependencies');
    expect(lines.some((line) => line.trimStart().startsWith('/command'))).toBe(false);
    expect(lines.some((line) => line.trimStart().startsWith('/deps '))).toBe(false);
  });
});

describe('Ink symbol completion after #', () => {
  const indexFile = allFiles[0];
  const symbols = new Map([[indexFile, ['main', 'parseArgs', 'Runner.start']]]);
  const getFileSymbols = (absoluteFile: string): string[] | undefined => symbols.get(absoluteFile);

  it('suggests the symbols of the file before #, filtered by the typed prefix', () => {
    const all = filterSlashCommands('/trace src/cli/index.ts#', allFiles, workspaceRoot, getFileSymbols);
    const filtered = filterSlashCommands('/callers src/cli/index.ts#par', allFiles, workspaceRoot, getFileSymbols);

    expect(all.map((entry) => entry.command)).toEqual([
      'src/cli/index.ts#main',
      'src/cli/index.ts#parseArgs',
      'src/cli/index.ts#Runner.start',
    ]);
    expect(filtered).toEqual([expect.objectContaining({
      command: 'src/cli/index.ts#parseArgs',
      insertText: 'src/cli/index.ts#parseArgs',
      targetCommand: '/callers',
      isArgument: true,
    })]);
  });

  it('suggests nothing while symbols are not loaded or the file is unknown', () => {
    expect(filterSlashCommands('/impact src/cli/index.ts#', allFiles, workspaceRoot)).toEqual([]);
    expect(filterSlashCommands('/trace src/missing.ts#', allFiles, workspaceRoot, getFileSymbols)).toEqual([]);
  });

  it('keeps # literal for commands without a symbol argument', () => {
    expect(findSymbolCompletionFile('/explain src/cli/index.ts#', allFiles, workspaceRoot)).toBeUndefined();
    expect(filterSlashCommands('/explain src/cli/index.ts#', allFiles, workspaceRoot, getFileSymbols)
      .some((entry) => entry.command.includes('#'))).toBe(false);
  });

  it('finds the file to load only while a file#symbol token is being typed', () => {
    expect(findSymbolCompletionFile('/trace src/cli/index.ts#ma', allFiles, workspaceRoot)).toBe(indexFile);
    expect(findSymbolCompletionFile('/trace src/cli/index.ts#ma ', allFiles, workspaceRoot)).toBeUndefined();
    expect(findSymbolCompletionFile('/trace #main', allFiles, workspaceRoot)).toBeUndefined();
    expect(findSymbolCompletionFile('/trace src/cli/nope.ts#', allFiles, workspaceRoot)).toBeUndefined();
  });

  it('matches Windows-style relative and absolute paths before #', () => {
    const windowsRoot = String.raw`C:\repo`;
    const windowsFile = String.raw`C:\repo\src\cli\index.ts`;

    expect(findSymbolCompletionFile(String.raw`/trace src\cli\index.ts#`, allFiles, workspaceRoot)).toBe(indexFile);
    expect(findSymbolCompletionFile(String.raw`/trace c:\repo\src\cli\index.ts#`, [windowsFile], windowsRoot))
      .toBe(windowsFile);
  });

  it('joins a # typed after a completed file argument', () => {
    expect(appendTypedInput('/trace src/cli/index.ts ', '#')).toBe('/trace src/cli/index.ts#');
    expect(appendTypedInput('/trace ', '#')).toBe('/trace #');
    expect(appendTypedInput('/query what is ', '#')).toBe('/query what is #');
    expect(appendTypedInput('/trace src', 'x')).toBe('/trace srcx');
  });
});

describe('Ink exact argument match', () => {
  it('ranks the exact symbol first so Enter on a complete argument runs it', () => {
    const symbols = (): string[] => ['parseFoo', 'foo'];
    const entries = filterSlashCommands('/callers src/cli/index.ts#foo', allFiles, workspaceRoot, symbols);

    expect(entries.map((entry) => entry.command)).toEqual(['src/cli/index.ts#foo', 'src/cli/index.ts#parseFoo']);
  });

  it('ranks the exact file first among files containing it', () => {
    const files = [path.join(workspaceRoot, 'src', 'a.tsx'), path.join(workspaceRoot, 'src', 'a.ts')];
    const entries = filterSlashCommands('/explain src/a.ts', files, workspaceRoot);

    expect(entries[0]?.command).toBe('src/a.ts');
  });
});

describe('Ink command history', () => {
  const history = ['/impact a.ts#x', '/summary'];

  it('recalls older commands up to the oldest one', () => {
    expect(stepHistory(history, null, 'older')).toEqual({ index: 0, line: '/impact a.ts#x' });
    expect(stepHistory(history, 0, 'older')).toEqual({ index: 1, line: '/summary' });
    expect(stepHistory(history, 1, 'older')).toEqual({ index: 1, line: '/summary' });
  });

  it('goes back to newer commands, then to an empty line', () => {
    expect(stepHistory(history, 1, 'newer')).toEqual({ index: 0, line: '/impact a.ts#x' });
    expect(stepHistory(history, 0, 'newer')).toEqual({ index: null, line: '' });
  });

  it('does nothing with an empty history or on a fresh line going newer', () => {
    expect(stepHistory([], null, 'older')).toBeUndefined();
    expect(stepHistory(history, null, 'newer')).toBeUndefined();
  });
});

describe('Ink next-step hints', () => {
  it('suggests symbol follow-ups when a symbol is known', () => {
    expect(getNextStepHints('src/a.ts', 'run')).toEqual([
      '/callers src/a.ts#run',
      '/impact src/a.ts#run',
      '/trace src/a.ts#run',
    ]);
  });

  it('suggests file follow-ups with forward slashes for a Windows-style path', () => {
    expect(getNextStepHints(String.raw`src\cli\index.ts`, 'none')).toEqual([
      '/explain src/cli/index.ts',
      '/check-dependencies src/cli/index.ts',
      '/cycles src/cli/index.ts',
    ]);
  });

  it('falls back to workspace commands without a file', () => {
    expect(getNextStepHints('none', 'run')).toEqual(['/summary', '/architecture', '/check']);
  });

  it('cycles through hints with Tab, and only from an empty line or a hint', () => {
    const hints = ['/summary', '/architecture', '/check'];

    expect(cycleNextStepHint(hints, '')).toBe('/summary');
    expect(cycleNextStepHint(hints, '/summary')).toBe('/architecture');
    expect(cycleNextStepHint(hints, '/check')).toBe('/summary');
    expect(cycleNextStepHint(hints, '/sum')).toBeUndefined();
    expect(cycleNextStepHint([], '')).toBeUndefined();
  });
});

describe('Ink arrow key routing', () => {
  const idle = {
    commandLine: '',
    historyIndex: null,
    hasSuggestions: false,
    hasOutput: true,
    isSearchMode: false,
    isPickerOpen: false,
  };

  it('scrolls the results from an empty prompt once there is output', () => {
    expect(resolveArrowTarget(idle)).toBe('scroll');
  });

  it('recalls history from an empty prompt before any output', () => {
    expect(resolveArrowTarget({ ...idle, hasOutput: false })).toBe('history');
  });

  it('keeps browsing history once a command was recalled, even a slash command', () => {
    expect(resolveArrowTarget({ ...idle, historyIndex: 0, commandLine: '/summary', hasSuggestions: true })).toBe('history');
  });

  it('moves in the slash palette while typing', () => {
    expect(resolveArrowTarget({ ...idle, commandLine: '/ch', hasSuggestions: true })).toBe('suggestions');
  });

  it('recalls history on a line with text but no suggestion', () => {
    expect(resolveArrowTarget({ ...idle, commandLine: 'hello' })).toBe('history');
  });

  it('scrolls the results in search mode', () => {
    expect(resolveArrowTarget({ ...idle, isSearchMode: true, historyIndex: 0 })).toBe('scroll');
  });

  it('leaves arrows to an open picker', () => {
    expect(resolveArrowTarget({ ...idle, isPickerOpen: true, isSearchMode: true, hasSuggestions: true })).toBe('picker');
  });
});

describe('Ink results scrolling', () => {
  const tail = Number.MAX_SAFE_INTEGER;

  it('moves one row with the arrows and a page with PgUp/PgDn', () => {
    expect(nextScrollTop({ upArrow: true }, 5, 10, 20)).toBe(4);
    expect(nextScrollTop({ downArrow: true }, 5, 10, 20)).toBe(6);
    expect(nextScrollTop({ pageUp: true }, 15, 10, 20)).toBe(5);
    expect(nextScrollTop({ pageDown: true }, 5, 10, 20)).toBe(15);
    expect(nextScrollTop({ home: true }, 5, 10, 20)).toBe(0);
  });

  it('sticks to the last row when reaching the end', () => {
    expect(nextScrollTop({ end: true }, 5, 10, 20)).toBe(tail);
    expect(nextScrollTop({ downArrow: true }, 19, 10, 20)).toBe(tail);
    expect(nextScrollTop({ pageDown: true }, 15, 10, 20)).toBe(tail);
  });

  it('steps up from the end instead of from the follow-tail marker', () => {
    expect(nextScrollTop({ upArrow: true }, tail, 10, 20)).toBe(19);
    expect(nextScrollTop({ pageUp: true }, tail, 10, 20)).toBe(10);
  });

  it('never goes above the first row', () => {
    expect(nextScrollTop({ upArrow: true }, 0, 10, 20)).toBe(0);
    expect(nextScrollTop({ pageUp: true }, 3, 10, 20)).toBe(0);
  });

  it('follows the tail when everything fits', () => {
    expect(nextScrollTop({ downArrow: true }, 0, 10, 0)).toBe(tail);
  });

  it('ignores keys that do not scroll', () => {
    expect(nextScrollTop({}, 5, 10, 20)).toBeUndefined();
  });
});

describe('Ink result rows', () => {
  const line = (text: string) => ({ text, blockIndex: 0, lineIndex: 1 });
  const rows = (text: string, width: number) => wrapLines([line(text)], width).map((row) => row.row);

  it('numbers lines per block from the command title', () => {
    expect(toLines([{ title: '/summary', body: 'a\r\nb' }, { title: '/check', body: '' }])).toEqual([
      { text: '$ /summary', blockIndex: 0, lineIndex: 0 },
      { text: 'a', blockIndex: 0, lineIndex: 1 },
      { text: 'b', blockIndex: 0, lineIndex: 2 },
      { text: '', blockIndex: 0, lineIndex: 3 },
      { text: '$ /check', blockIndex: 1, lineIndex: 0 },
      { text: '(no output)', blockIndex: 1, lineIndex: 1 },
      { text: '', blockIndex: 1, lineIndex: 2 },
    ]);
  });

  it('hard-wraps a long line and keeps its source on every row', () => {
    expect(wrapLines([line('abcdef')], 4)).toEqual([
      { text: 'abcdef', blockIndex: 0, lineIndex: 1, row: 'abcd' },
      { text: 'abcdef', blockIndex: 0, lineIndex: 1, row: 'ef' },
    ]);
  });

  it('keeps a line of exactly the width on one row', () => {
    expect(rows('abcd', 4)).toEqual(['abcd']);
  });

  it('keeps an empty line as one empty row', () => {
    expect(rows('', 4)).toEqual(['']);
  });

  it('wraps ANSI-colored text by visible width and recolors each row', () => {
    expect(rows('\u001b[31mabcdef\u001b[39m', 4)).toEqual(['\u001b[31mabcd\u001b[39m', '\u001b[31mef\u001b[39m']);
  });

  it('counts wide characters and emoji as two cells', () => {
    expect(rows('日本語x', 4)).toEqual(['日本', '語x']);
    expect(rows('ab😀cd', 4)).toEqual(['ab😀', 'cd']);
  });

  it('puts one character per row at width 1, and clamps smaller widths to 1', () => {
    expect(rows('abc', 1)).toEqual(['a', 'b', 'c']);
    expect(rows('abc', 0)).toEqual(['a', 'b', 'c']);
  });
});
