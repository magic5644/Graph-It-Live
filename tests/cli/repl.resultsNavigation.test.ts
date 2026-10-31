import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn, spawnSync: vi.fn(() => ({ status: 0 })) }));

import {
  AUTO_EXPANDED_BLOCKS,
  blockTitleIndex,
  buildResultActions,
  countBlockLines,
  cursorIndexOf,
  extractResultTarget,
  findMatches,
  focusTargetIndex,
  foldedBlocks,
  highlightMatches,
  isInsideWorkspace,
  selectPanelLines,
  openInEditor,
  resolveEditorLaunch,
  stepMatch,
  toVisibleLines,
  type OutputLine,
  type ResultTarget,
} from '../../src/cli/repl/resultsNavigation';
import {
  decorateTitle,
  resolveFocusCommand,
  resolveFocusMove,
  scrollToCursor,
  toLines,
  wrapLines,
} from '../../src/cli/repl/ink/ReplInkApp';

const root = path.resolve('/workspace');
const fileA = path.join(root, 'src', 'a.ts');
const fileB = path.join(root, 'src', 'lib', 'b.ts');
const spaced = path.join(root, 'src', 'my file.ts');
const allFiles = [fileA, fileB, spaced];

const blocks = (...bodies: string[]) => toLines(bodies.map((body, index) => ({ title: `/cmd${index}`, body })));
const titles = (lines: OutputLine[]) => lines.filter((line) => line.lineIndex === 0).map((line) => line.blockIndex);

afterEach(() => {
  spawn.mockReset();
});

describe('folding', () => {
  it('folds nothing without blocks and keeps a single block expanded', () => {
    expect(foldedBlocks(0, new Map())).toEqual(new Set());
    expect(toVisibleLines([], new Set([0]))).toEqual([]);
    const lines = blocks('a\nb');
    expect(toVisibleLines(lines, foldedBlocks(1, new Map()))).toBe(lines);
  });

  it('auto-folds blocks older than the newest ones unless the user expanded them', () => {
    const count = AUTO_EXPANDED_BLOCKS + 2;
    expect(foldedBlocks(count, new Map())).toEqual(new Set([0, 1]));
    expect(foldedBlocks(count, new Map([[0, false]]))).toEqual(new Set([1]));
    expect(foldedBlocks(count, new Map([[count - 1, true]]))).toEqual(new Set([0, 1, count - 1]));
  });

  it('keeps the user fold state when new results arrive', () => {
    const overrides = new Map([[0, false], [2, true]]);
    expect(foldedBlocks(3, overrides)).toEqual(new Set([2]));
    expect(foldedBlocks(6, overrides)).toEqual(new Set([1, 2]));
  });

  it.each([
    ['first', 0],
    ['middle', 1],
    ['last', 2],
  ])('reduces the %s folded block to its title row', (_label, folded) => {
    const lines = blocks('a\nb', 'c\nd', 'e\nf');
    const visible = toVisibleLines(lines, new Set([folded]));
    expect(titles(visible)).toEqual([0, 1, 2]);
    expect(visible.filter((line) => line.blockIndex === folded)).toEqual([{ text: `$ /cmd${folded}`, blockIndex: folded, lineIndex: 0 }]);
    expect(visible).toHaveLength(lines.length - 3);
  });

  it('folds and unfolds every block', () => {
    const lines = blocks('a', 'b', 'c');
    expect(toVisibleLines(lines, new Set([0, 1, 2])).map((line) => line.text)).toEqual(['$ /cmd0', '$ /cmd1', '$ /cmd2']);
    expect(toVisibleLines(lines, new Set())).toBe(lines);
  });

  it('hides a search match inside a folded block until that block unfolds', () => {
    const lines = blocks('needle', 'other');
    const [match] = findMatches(lines, 'needle');
    expect(toVisibleLines(lines, new Set([0]))).not.toContain(lines[match]);
    expect(toVisibleLines(lines, foldedBlocks(2, new Map([[0, false]])))).toContain(lines[match]);
  });

  it('keeps folded blocks folded across a resize', () => {
    const visible = toVisibleLines(blocks('x'.repeat(50), 'short'), new Set([0]));
    expect(wrapLines(visible, 80).filter((row) => row.blockIndex === 0)).toHaveLength(1);
    expect(wrapLines(visible, 10).filter((row) => row.blockIndex === 0)).toHaveLength(1);
  });

  it('keeps every filtered match visible, even in a folded block', () => {
    const lines = blocks('needle\nhay', 'other');
    const matches = findMatches(lines, 'needle');
    const filtered = selectPanelLines(lines, new Set([0]), matches, true);
    expect(filtered.visible.map((line) => line.text)).toEqual(['needle']);
    expect(filtered.copy).toBe(filtered.visible);
    const unfiltered = selectPanelLines(lines, new Set([0]), matches, false);
    expect(unfiltered.visible.map((line) => line.text)).toEqual(['$ /cmd0', '$ /cmd1', 'other', '']);
    expect(unfiltered.copy).toBe(lines);
  });

  it('counts body lines per block', () => {
    expect(countBlockLines(blocks('a\nb\nc', ''))).toEqual(new Map([[0, 3], [1, 1]]));
  });
});

describe('cursor', () => {
  const lines = blocks('a\nb\nc', 'd\ne');

  it('maps a hidden line to its block title and a vanished one to the last line', () => {
    expect(cursorIndexOf(lines, { blockIndex: 1, lineIndex: 2 })).toBe(7);
    const visible = toVisibleLines(lines, new Set([1]));
    expect(cursorIndexOf(visible, { blockIndex: 1, lineIndex: 2 })).toBe(5);
    expect(cursorIndexOf(visible, { blockIndex: 9, lineIndex: 0 })).toBe(5);
  });

  it('finds the previous and next block titles', () => {
    expect(blockTitleIndex(lines, 2, -1)).toBe(0);
    expect(blockTitleIndex(lines, 2, 1)).toBe(5);
    expect(blockTitleIndex(lines, 5, 1)).toBeUndefined();
    expect(blockTitleIndex(lines, 0, -1)).toBeUndefined();
  });

  it('moves by line, page, half page, ends and block, clamped', () => {
    expect(focusTargetIndex('up', lines, 0, 4)).toBe(0);
    expect(focusTargetIndex('down', lines, 0, 4)).toBe(1);
    expect(focusTargetIndex('pageDown', lines, 0, 4)).toBe(4);
    expect(focusTargetIndex('pageUp', lines, 2, 4)).toBe(0);
    expect(focusTargetIndex('halfDown', lines, 0, 4)).toBe(2);
    expect(focusTargetIndex('halfUp', lines, 3, 1)).toBe(2);
    expect(focusTargetIndex('top', lines, 5, 4)).toBe(0);
    expect(focusTargetIndex('bottom', lines, 0, 4)).toBe(lines.length - 1);
    expect(focusTargetIndex('nextBlock', lines, 1, 4)).toBe(5);
    expect(focusTargetIndex('prevBlock', lines, 6, 4)).toBe(5);
    expect(focusTargetIndex('nextBlock', lines, 6, 4)).toBe(6);
  });

  it('scrolls to show the cursor rows, or puts them on top for block jumps', () => {
    expect(scrollToCursor(10, 12, 12, 5, 50, false)).toBe(10);
    expect(scrollToCursor(10, 4, 4, 5, 50, false)).toBe(4);
    expect(scrollToCursor(10, 16, 17, 5, 50, false)).toBe(13);
    expect(scrollToCursor(10, 12, 12, 5, 50, true)).toBe(12);
    expect(scrollToCursor(10, 60, 60, 5, 50, false)).toBe(Number.MAX_SAFE_INTEGER);
    expect(scrollToCursor(Number.MAX_SAFE_INTEGER, 52, 52, 5, 50, false)).toBe(Number.MAX_SAFE_INTEGER);
    expect(scrollToCursor(Number.MAX_SAFE_INTEGER, 49, 49, 5, 50, false)).toBe(49);
  });

  it('maps focus keys to moves and commands', () => {
    expect(resolveFocusMove('', { upArrow: true })).toBe('up');
    expect(resolveFocusMove('j', {})).toBe('down');
    expect(resolveFocusMove('u', { ctrl: true })).toBe('halfUp');
    expect(resolveFocusMove(']', {})).toBe('nextBlock');
    expect(resolveFocusMove('x', {})).toBeUndefined();
    expect(resolveFocusMove('constructor', {})).toBeUndefined();
    expect(resolveFocusCommand('', { escape: true })).toBe('leave');
    expect(resolveFocusCommand('', { return: true })).toBe('actions');
    expect(resolveFocusCommand('y', { ctrl: true })).toBe('copyAll');
    expect(resolveFocusCommand('l', { ctrl: true })).toBeUndefined();
    expect(resolveFocusCommand('y', {})).toBe('copyLine');
    expect(resolveFocusCommand(' ', {})).toBe('toggleFold');
    expect(resolveFocusCommand('N', {})).toBe('previousMatch');
  });
});

describe('search', () => {
  const lines = blocks('Alpha\n\u001b[31mbeta\u001b[0m\nalphabet', 'gamma');

  it('finds case-insensitive matches, ignoring ANSI codes', () => {
    expect(findMatches(lines, 'ALPHA')).toEqual([1, 3]);
    expect(findMatches(lines, 'BET')).toEqual([2, 3]);
    expect(findMatches(lines, '31m')).toEqual([]);
    expect(findMatches(lines, 'zzz')).toEqual([]);
  });

  it('matches nothing for an empty query', () => {
    expect(findMatches(lines, '')).toEqual([]);
    expect(findMatches(lines, '   ')).toEqual([]);
  });

  it('steps through matches and wraps around', () => {
    expect(stepMatch([], 0, 1)).toBeUndefined();
    expect(stepMatch([2, 5, 9], 2, 1)).toBe(1);
    expect(stepMatch([2, 5, 9], 2, 1, true)).toBe(0);
    expect(stepMatch([2, 5, 9], 9, 1)).toBe(0);
    expect(stepMatch([2, 5, 9], 2, -1)).toBe(2);
    expect(stepMatch([2, 5, 9], 6, -1)).toBe(1);
    expect(stepMatch([2, 5, 9], 5, -1, true)).toBe(1);
    expect(stepMatch([2, 5, 9], -1, 1)).toBe(0);
  });

  it('highlights every match on the text without escape codes', () => {
    expect(highlightMatches('a-A-b', 'a')).toBe('\u001b[7ma\u001b[27m-\u001b[7mA\u001b[27m-b');
    expect(highlightMatches('\u001b[31mbeta\u001b[0m', 'et')).toBe('b\u001b[7met\u001b[27ma');
    expect(highlightMatches('\u001b[31mbeta\u001b[0m', 'zz')).toBe('\u001b[31mbeta\u001b[0m');
    expect(highlightMatches('beta', '')).toBe('beta');
    expect(highlightMatches('İstanbul i', 'i')).toBe('İstanbul i');
  });
});

describe('extractResultTarget', () => {
  const extract = (text: string) => extractResultTarget(text, root, allFiles);

  it('reads a relativePath: row', () => {
    expect(extract('  relativePath: src/a.ts')).toEqual({ file: fileA, relativePath: 'src/a.ts' });
  });

  it('accepts an absolute path inside the workspace and rejects one outside', () => {
    expect(extract(`  path: ${fileB}`)?.file).toBe(fileB);
    const outside = path.resolve('/elsewhere/src/a.ts');
    expect(extractResultTarget(`path: ${outside}`, root, [...allFiles, outside])).toBeUndefined();
  });

  it('reads file#Symbol and file:line', () => {
    expect(extract('see src/a.ts#main for details')).toEqual({ file: fileA, relativePath: 'src/a.ts', symbol: 'main' });
    expect(extract('src/a.ts#not-a-symbol')).toEqual({ file: fileA, relativePath: 'src/a.ts' });
    expect(extract('src/lib/b.ts:12:4 unused export')).toEqual({ file: fileB, relativePath: 'src/lib/b.ts', line: 12 });
    expect(extract(`id: ${fileA}:tokenizeCommandLine`)).toEqual({ file: fileA, relativePath: 'src/a.ts', symbol: 'tokenizeCommandLine' });
  });

  it('normalizes Windows separators', () => {
    expect(extract(String.raw`src\lib\b.ts:7`)).toEqual({ file: fileB, relativePath: 'src/lib/b.ts', line: 7 });
  });

  it('rejects paths missing from the index', () => {
    expect(extract('relativePath: src/missing.ts')).toBeUndefined();
    expect(extract('/etc/passwd ../../secret')).toBeUndefined();
  });

  it('ignores ANSI colors and JSON punctuation', () => {
    expect(extract('\u001b[36msrc/a.ts\u001b[0m')?.file).toBe(fileA);
    expect(extract('  "relativePath": "src/lib/b.ts",')?.file).toBe(fileB);
  });

  it('returns nothing for a row without a target', () => {
    expect(extract('Summary: 3 files')).toBeUndefined();
    expect(extract('')).toBeUndefined();
  });

  it('takes the first path when a row has two', () => {
    expect(extract('src/lib/b.ts -> src/a.ts')?.file).toBe(fileB);
  });
});

describe('result actions', () => {
  it('lists file commands, then the editor', () => {
    expect(buildResultActions({ file: fileA, relativePath: 'src/a.ts' }).map((action) => action.commandLine)).toEqual([
      '/explain src/a.ts',
      '/check-dependencies src/a.ts',
      '/cycles src/a.ts',
      '/file src/a.ts',
      undefined,
    ]);
  });

  it('lists symbol commands for file#Symbol and quotes paths with spaces', () => {
    expect(buildResultActions({ file: fileA, relativePath: 'src/a.ts', symbol: 'main' }).map((action) => action.label)).toEqual([
      '/trace src/a.ts#main',
      '/callers src/a.ts#main',
      '/impact src/a.ts#main',
      'Open in editor',
    ]);
    expect(buildResultActions({ file: spaced, relativePath: 'src/my file.ts' })[0].commandLine).toBe('/explain "src/my file.ts"');
  });
});

describe('editor launch', () => {
  const target: ResultTarget = { file: fileA, relativePath: 'src/a.ts', line: 3 };

  it('uses VISUAL, then EDITOR, with goto for the VS Code family', () => {
    expect(resolveEditorLaunch(target, { VISUAL: 'code -w' }, 'darwin')).toEqual({ command: 'code', args: ['-w', '-g', `${fileA}:3`] });
    expect(resolveEditorLaunch(target, { EDITOR: 'subl' }, 'linux')).toEqual({ command: 'subl', args: [fileA] });
    expect(resolveEditorLaunch({ ...target, line: undefined }, { EDITOR: 'cursor' }, 'linux')?.args).toEqual(['-g', fileA]);
  });

  it('skips terminal editors and falls back to code in the VS Code terminal', () => {
    expect(resolveEditorLaunch(target, { EDITOR: 'vim' }, 'linux')).toBeUndefined();
    expect(resolveEditorLaunch(target, { VISUAL: 'nvim', EDITOR: 'subl' }, 'linux')?.command).toBe('subl');
    expect(resolveEditorLaunch(target, { EDITOR: 'vim', TERM_PROGRAM: 'vscode' }, 'darwin')).toEqual({ command: 'code', args: ['-g', `${fileA}:3`] });
  });

  it('never uses .cmd launchers on Windows', () => {
    expect(resolveEditorLaunch(target, { EDITOR: 'code.cmd', TERM_PROGRAM: 'vscode' }, 'win32')).toBeUndefined();
    expect(resolveEditorLaunch(target, { EDITOR: String.raw`C:\Tools\Code.exe` }, 'win32')?.command).toBe(String.raw`C:\Tools\Code.exe`);
  });

  it('refuses files outside the workspace without spawning', async () => {
    await expect(openInEditor({ file: path.resolve('/etc/passwd'), relativePath: 'x' }, root, { EDITOR: 'code' }, 'linux'))
      .resolves.toContain('outside the workspace');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a missing editor without spawning', async () => {
    await expect(openInEditor(target, root, {}, 'linux')).resolves.toContain('No GUI editor found');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns the editor detached without a shell', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValue(child);
    const notice = openInEditor(target, root, { EDITOR: 'code' }, 'linux');
    child.emit('spawn');
    await expect(notice).resolves.toBe('Opened src/a.ts in code');
    expect(spawn).toHaveBeenCalledWith('code', ['-g', `${fileA}:3`], { shell: false, detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('reports a spawn failure', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValue(child);
    const notice = openInEditor(target, root, { EDITOR: 'nope' }, 'linux');
    child.emit('error', new Error('spawn nope ENOENT'));
    await expect(notice).resolves.toBe('Editor failed: spawn nope ENOENT');
  });

  it('hints at an .exe editor when a bare launcher fails on Windows', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValue(child);
    const notice = openInEditor(target, root, { EDITOR: 'code' }, 'win32');
    child.emit('error', new Error('spawn code ENOENT'));
    await expect(notice).resolves.toBe('Editor failed: spawn code ENOENT (on Windows, set VISUAL or EDITOR to an .exe editor)');
    expect(spawn).toHaveBeenCalledWith('code', ['-g', `${fileA}:3`], { shell: false, detached: true, stdio: 'ignore' });
  });
});

describe('workspace boundary and title markers', () => {
  it('keeps only files strictly inside the root', () => {
    expect(isInsideWorkspace(fileA, root)).toBe(true);
    expect(isInsideWorkspace(path.join(root, '..foo', 'x.ts'), root)).toBe(true);
    expect(isInsideWorkspace(root, root)).toBe(false);
    expect(isInsideWorkspace(path.join(root, '..', 'x.ts'), root)).toBe(false);
  });

  it('marks a title with status, fold arrow and size', () => {
    expect(decorateTitle('$ /a', false, false, 41)).toBe('\u001b[32m●\u001b[0m ▾ $ /a \u001b[2m(41 lines)\u001b[0m');
    expect(decorateTitle('$ /a', true, true, 1)).toBe('\u001b[31m●\u001b[0m ▸ $ /a \u001b[2m(1 line)\u001b[0m');
  });
});
