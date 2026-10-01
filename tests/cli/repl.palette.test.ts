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
  stepHistory,
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
