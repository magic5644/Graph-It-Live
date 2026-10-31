/**
 * Clickable result links (OSC 8) and optional mouse tracking of the REPL: terminal detection,
 * file URIs, link wrapping, SGR mouse parsing, hit tests and the terminal cleanup.
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  enableMouseTracking,
  findWorkspaceFile,
  hintAt,
  hitMouseRegion,
  isDoubleClick,
  linkResultTarget,
  MOUSE_ON_MESSAGE,
  MOUSE_TRACKING_OFF,
  MOUSE_TRACKING_ON,
  parseSgrMouse,
  resolveMouseCommand,
  stripStylesKeepLinks,
  supportsHyperlinks,
  toFileUri,
  type MouseReport,
} from '../../src/cli/repl/resultsNavigation';
import {
  buildMouseRegions,
  handleMouseEvent,
  wrapLines,
  type MouseContext,
  type MouseLayout,
} from '../../src/cli/repl/ink/ReplInkApp';

const root = path.resolve('/workspace');
const fileA = path.join(root, 'src', 'a.ts');
const fileB = path.join(root, 'src', 'lib', 'b.ts');
const allFiles = [fileA, fileB];
const OSC8 = '\u001b]8;;';
const BEL = '\u0007';

describe('supportsHyperlinks', () => {
  it.each([
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }],
    ['VS Code', { TERM_PROGRAM: 'vscode' }],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }],
    ['Ghostty', { TERM_PROGRAM: 'ghostty' }],
    ['Windows Terminal', { WT_SESSION: 'a1b2' }],
    ['GNOME VTE', { VTE_VERSION: '7200' }],
    ['kitty', { KITTY_WINDOW_ID: '1' }],
  ])('enables links in %s', (_name, env) => {
    expect(supportsHyperlinks(env, true)).toBe(true);
  });

  it.each([
    ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal' }],
    ['old VTE', { VTE_VERSION: '4999' }],
    ['an unknown terminal', { TERM: 'xterm-256color' }],
    ['NO_COLOR', { TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' }],
    ['TERM=dumb', { TERM_PROGRAM: 'vscode', TERM: 'dumb' }],
  ])('disables links in %s', (_name, env) => {
    expect(supportsHyperlinks(env, true)).toBe(false);
  });

  it('disables links when the output is not a TTY', () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: 'iTerm.app' }, false)).toBe(false);
  });

  it('follows FORCE_HYPERLINK over detection', () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: 'iTerm.app', FORCE_HYPERLINK: '0' }, true)).toBe(false);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: '1' }, false)).toBe(true);
  });
});

describe('toFileUri', () => {
  it('percent-encodes spaces, # and characters ANSI parsers reject', () => {
    expect(toFileUri('/a b/c#d(1);e.ts', 'darwin')).toBe('file:///a%20b/c%23d%281%29%3Be.ts');
    expect(toFileUri('/src/café.ts', 'linux')).toBe('file:///src/caf%C3%A9.ts');
  });

  it('builds file:///C:/… URIs for Windows paths', () => {
    expect(toFileUri(String.raw`C:\repo\my file#1.ts`, 'win32')).toBe('file:///C:/repo/my%20file%231.ts');
  });
});

describe('linkResultTarget', () => {
  const link = (text: string) => linkResultTarget(text, root, allFiles, 'linux');
  const uriA = toFileUri(fileA, 'linux');

  it('wraps the target token in an OSC 8 link and keeps the visible text', () => {
    const linked = link('  relativePath: src/a.ts#main');
    expect(linked).toBe(`  relativePath: ${OSC8}${uriA}${BEL}src/a.ts#main${OSC8}${BEL}`);
    expect(stripVTControlCharacters(linked)).toBe('  relativePath: src/a.ts#main');
  });

  it('links the token found in the plain text, not an earlier lookalike', () => {
    expect(link('lib/src/a.ts src/a.ts')).toBe(`lib/src/a.ts ${OSC8}${uriA}${BEL}src/a.ts${OSC8}${BEL}`);
  });

  it('links a token typed with Windows separators', () => {
    expect(link(String.raw`src\lib\b.ts:7 unused`)).toBe(`${OSC8}${toFileUri(fileB, 'linux')}${BEL}${String.raw`src\lib\b.ts:7`}${OSC8}${BEL} unused`);
  });

  it('links inside colored text', () => {
    expect(link('\u001b[36msrc/a.ts:3\u001b[0m')).toBe(`\u001b[36m${OSC8}${uriA}${BEL}src/a.ts:3${OSC8}${BEL}\u001b[0m`);
  });

  it('leaves rows without a target, or with a token split by styling, unchanged', () => {
    expect(link('Summary: 3 files')).toBe('Summary: 3 files');
    expect(link('src/\u001b[7ma.ts\u001b[27m')).toBe('src/\u001b[7ma.ts\u001b[27m');
  });

  it('keeps the wrapped width of a linked row', () => {
    const text = `path: ${fileB} unused export in a long result row`;
    const plainRows = wrapLines([{ text, blockIndex: 0, lineIndex: 1 }], 20).map((row) => row.row);
    const linkedRows = wrapLines([{ text: link(text), blockIndex: 0, lineIndex: 1 }], 20).map((row) => row.row);
    expect(linkedRows.map((row) => stripVTControlCharacters(row))).toEqual(plainRows);
    // wrap-ansi closes the link at each row break and reopens it on the next row.
    expect(linkedRows.filter((row) => row.includes(OSC8)).length).toBeGreaterThan(1);
  });
});

describe('findWorkspaceFile index', () => {
  it('lets the first file win and indexes each root separately', () => {
    const files = [fileA, path.join(root, 'other', 'src', 'a.ts')];
    expect(findWorkspaceFile('src/a.ts', files, root)).toBe(fileA);
    expect(findWorkspaceFile('src/a.ts', files, path.join(root, 'other'))).toBe(files[1]);
    expect(findWorkspaceFile('missing.ts', files, root)).toBeUndefined();
  });

  it('matches Windows separators and handles empty input', () => {
    expect(findWorkspaceFile(String.raw`src\lib\b.ts`, allFiles, root)).toBe(fileB);
    expect(findWorkspaceFile('src/a.ts', [], root)).toBeUndefined();
    expect(findWorkspaceFile('', allFiles, root)).toBeUndefined();
  });

  it('indexes a replaced file list from scratch', () => {
    expect(findWorkspaceFile('src/lib/b.ts', [fileA], root)).toBeUndefined();
    expect(findWorkspaceFile('src/lib/b.ts', [fileA, fileB], root)).toBe(fileB);
  });
});

describe('stripStylesKeepLinks', () => {
  it('drops colors and keeps links', () => {
    const linkText = `${OSC8}file:///w/a.ts${BEL}a.ts${OSC8}${BEL}`;
    expect(stripStylesKeepLinks(`\u001b[31mx ${linkText}\u001b[0m y`)).toBe(`x ${linkText} y`);
    expect(stripStylesKeepLinks('\u001b[1mplain\u001b[0m')).toBe('plain');
  });

  it('strips an unterminated link start like any other escape', () => {
    expect(stripStylesKeepLinks(`a ${OSC8}file:///w/a.ts`)).toBe(stripVTControlCharacters(`a ${OSC8}file:///w/a.ts`));
  });
});

describe('parseSgrMouse', () => {
  const press = (x: number, y: number): MouseReport => ({ button: 0, x, y, pressed: true, motion: false, wheel: undefined });

  it('reads a press and a release with 0-based cells', () => {
    expect(parseSgrMouse('\u001b[<0;5;10M\u001b[<0;5;10m')).toEqual([press(4, 9), { ...press(4, 9), pressed: false }]);
  });

  it('reads wheel up and down', () => {
    expect(parseSgrMouse('\u001b[<64;1;1M\u001b[<65;1;1M').map((event) => event.wheel)).toEqual(['up', 'down']);
  });

  it('removes modifier bits and flags drags', () => {
    const [ctrlClick, shiftWheel, drag, right] = parseSgrMouse('\u001b[<16;2;3M\u001b[<68;1;1M\u001b[<32;2;3M\u001b[<2;2;3M');
    expect(ctrlClick).toEqual(press(1, 2));
    expect(shiftWheel.wheel).toBe('up');
    expect(drag.motion).toBe(true);
    expect(right.button).toBe(2);
  });

  it('ignores other bytes and incomplete reports', () => {
    expect(parseSgrMouse('abc\u001b[A')).toEqual([]);
    expect(parseSgrMouse('x\u001b[<0;5;10Mq\u001b[<0;5')).toEqual([press(4, 9)]);
    expect(parseSgrMouse('\u001b[<a;b;cM')).toEqual([]);
  });
});

describe('enableMouseTracking', () => {
  const setup = () => {
    const writes: string[] = [];
    const proc = new EventEmitter();
    const disable = enableMouseTracking((data) => writes.push(data), proc as unknown as NodeJS.Process);
    return { writes, proc, disable };
  };

  it('turns tracking on, then off once', () => {
    const { writes, proc, disable } = setup();
    expect(writes).toEqual([MOUSE_TRACKING_ON]);
    disable();
    disable();
    expect(writes).toEqual([MOUSE_TRACKING_ON, MOUSE_TRACKING_OFF]);
    expect(proc.listenerCount('exit') + proc.listenerCount('SIGTERM')).toBe(0);
  });

  it.each(['exit', 'SIGTERM'])('turns tracking off on %s', (event) => {
    const { writes, proc, disable } = setup();
    proc.emit(event);
    disable();
    expect(writes).toEqual([MOUSE_TRACKING_ON, MOUSE_TRACKING_OFF]);
    expect(proc.listenerCount('exit') + proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('mouse helpers', () => {
  it('finds the region and entry under a row', () => {
    const regions = [{ kind: 'results' as const, top: 8, count: 3 }, { kind: 'hints' as const, top: 15, count: 0 }];
    expect(hitMouseRegion(9, regions)).toEqual({ kind: 'results', index: 1 });
    expect(hitMouseRegion(11, regions)).toBeUndefined();
    expect(hitMouseRegion(15, regions)).toBeUndefined();
  });

  it('finds the next-step hint under a column', () => {
    const hints = ['/trace a', '/callers b'];
    expect(hintAt(hints, 2)).toBe('/trace a');
    expect(hintAt(hints, 9)).toBe('/trace a');
    expect(hintAt(hints, 11)).toBeUndefined();
    expect(hintAt(hints, 13)).toBe('/callers b');
    expect(hintAt(hints, 0)).toBeUndefined();
  });

  it('detects a double click on the same row within 400 ms', () => {
    expect(isDoubleClick(undefined, { row: 1, time: 0 })).toBe(false);
    expect(isDoubleClick({ row: 1, time: 0 }, { row: 1, time: 399 })).toBe(true);
    expect(isDoubleClick({ row: 1, time: 0 }, { row: 1, time: 400 })).toBe(false);
    expect(isDoubleClick({ row: 1, time: 0 }, { row: 2, time: 10 })).toBe(false);
  });

  it('answers /mouse on, off and usage, and leaves other commands to the runner', () => {
    expect(resolveMouseCommand(' /mouse on ')).toEqual({ command: 'mouse', output: MOUSE_ON_MESSAGE, mouse: true });
    expect(resolveMouseCommand('/mouse off')).toMatchObject({ mouse: false });
    expect(resolveMouseCommand('/mouse')).toEqual({ command: 'mouse', output: 'Usage: /mouse on|off (off by default).' });
    expect(resolveMouseCommand('/mouse on now')?.mouse).toBeUndefined();
    expect(resolveMouseCommand('/summary')).toBeUndefined();
  });
});

describe('buildMouseRegions', () => {
  const layout: MouseLayout = {
    panelHeight: 10,
    resultRows: 8,
    pickerOpen: false,
    pickerRows: 0,
    pickerCountLine: false,
    actionMenuRows: 0,
    showHints: false,
    paletteRows: 0,
    paletteCompletion: false,
    paletteArgsHint: false,
    paletteWindow: false,
  };

  it('puts result rows under the header, summary and gap', () => {
    expect(buildMouseRegions(layout)[0]).toEqual({ kind: 'results', top: 8, count: 8 });
  });

  it('puts picker entries under its title, breadcrumb and count line', () => {
    expect(buildMouseRegions({ ...layout, pickerOpen: true, pickerRows: 4 })[0]).toEqual({ kind: 'picker', top: 9, count: 4 });
    expect(buildMouseRegions({ ...layout, pickerOpen: true, pickerRows: 0, pickerCountLine: true })[0]).toEqual({ kind: 'picker', top: 10, count: 0 });
  });

  it('places hints and palette entries after the prompt, action menu and palette header', () => {
    const [, hints, palette] = buildMouseRegions({
      ...layout, actionMenuRows: 2, showHints: true, paletteRows: 3, paletteCompletion: true, paletteArgsHint: true, paletteWindow: true,
    });
    // Panel 6..15, gap 16, notice 17, prompt 18, menu 19-20.
    expect(hints).toEqual({ kind: 'hints', top: 21, count: 1 });
    expect(palette).toEqual({ kind: 'palette', top: 26, count: 3 });
    expect(buildMouseRegions(layout)[1].count).toBe(0);
  });
});

describe('handleMouseEvent', () => {
  const rows = [
    { text: '$ /cmd', row: '$ /cmd', blockIndex: 0, lineIndex: 0 },
    { text: 'relativePath: src/a.ts', row: 'relativePath: src/a.ts', blockIndex: 0, lineIndex: 1 },
  ];
  const context = (overrides: Partial<MouseContext> = {}): MouseContext => ({
    regions: [
      { kind: 'results', top: 8, count: 2 },
      { kind: 'picker', top: 30, count: 2 },
      { kind: 'palette', top: 20, count: 3 },
      { kind: 'hints', top: 18, count: 1 },
    ],
    visibleRows: rows,
    scrollTop: 5,
    maxScrollTop: 20,
    pickerOpen: false,
    pickerScrollStart: 10,
    pickerEntryCount: 12,
    visibleSlashStart: 4,
    hints: ['/trace x'],
    workspaceRoot: root,
    allFiles,
    placeCursor: vi.fn(),
    setScrollTop: vi.fn(),
    setPickerIndex: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setCommandLine: vi.fn(),
    setIsFocused: vi.fn(),
    setActionMenu: vi.fn(),
    setNotice: vi.fn(),
    ...overrides,
  });
  const click = (x: number, y: number): MouseReport => ({ button: 0, x, y, pressed: true, motion: false });
  /** Result of the last updater passed to a state setter. */
  const applied = <T>(setter: unknown, previous: T): T => (vi.mocked(setter as (next: (value: T) => T) => void).mock.calls.at(-1)![0])(previous);

  it('scrolls the results three rows per wheel step', () => {
    const ctx = context();
    expect(handleMouseEvent({ ...click(0, 0), wheel: 'up' }, ctx, undefined)).toBeUndefined();
    expect(applied(ctx.setScrollTop, 10)).toBe(7);
    handleMouseEvent({ ...click(0, 0), wheel: 'down' }, ctx, undefined);
    expect(applied(ctx.setScrollTop, 10)).toBe(13);
  });

  it('moves the picker selection with the wheel, within its entries', () => {
    const ctx = context({ pickerOpen: true });
    handleMouseEvent({ ...click(0, 0), wheel: 'down' }, ctx, undefined);
    expect(applied(ctx.setPickerIndex, 10)).toBe(11);
    handleMouseEvent({ ...click(0, 0), wheel: 'up' }, ctx, undefined);
    expect(applied(ctx.setPickerIndex, 1)).toBe(0);
    expect(ctx.setScrollTop).not.toHaveBeenCalled();
  });

  it('focuses the clicked result row, and opens its actions on a double click', () => {
    const ctx = context();
    const first = handleMouseEvent(click(3, 9), ctx, undefined, 1000);
    expect(first).toEqual({ row: 6, time: 1000 });
    expect(ctx.setIsFocused).toHaveBeenCalledWith(true);
    expect(ctx.placeCursor).toHaveBeenCalledWith(rows[1], 'follow');
    expect(ctx.setActionMenu).toHaveBeenLastCalledWith(null);

    expect(handleMouseEvent(click(3, 9), ctx, first, 1200)).toBeUndefined();
    expect(vi.mocked(ctx.setActionMenu).mock.calls.at(-1)![0]).toMatchObject({ target: { file: fileA }, index: 0 });
  });

  it('maps a click on a wrapped continuation row of a scrolled view to its line', () => {
    const lines = [
      { text: '$ /cmd', blockIndex: 0, lineIndex: 0 },
      { text: `relativePath: src/a.ts ${'x'.repeat(30)}`, blockIndex: 0, lineIndex: 1 },
    ];
    const wrapped = wrapLines(lines, 20);
    const scrollTop = 1;
    const ctx = context({ visibleRows: wrapped.slice(scrollTop), scrollTop, regions: [{ kind: 'results', top: 8, count: wrapped.length - scrollTop }] });
    expect(handleMouseEvent(click(0, 9), ctx, undefined, 0)).toEqual({ row: 2, time: 0 });
    expect(ctx.placeCursor).toHaveBeenCalledWith(expect.objectContaining({ blockIndex: 0, lineIndex: 1 }), 'follow');
  });

  it('reports a double click on a row without a target', () => {
    const ctx = context();
    handleMouseEvent(click(3, 8), ctx, { row: 5, time: 0 }, 100);
    expect(ctx.setNotice).toHaveBeenLastCalledWith('No file or symbol on line');
  });

  it('selects picker and palette entries and puts a hint on the prompt', () => {
    const ctx = context();
    handleMouseEvent(click(0, 31), ctx, undefined);
    expect(ctx.setPickerIndex).toHaveBeenCalledWith(11);
    handleMouseEvent(click(0, 22), ctx, undefined);
    expect(ctx.setSelectedCommandIndex).toHaveBeenCalledWith(6);
    handleMouseEvent(click(4, 18), ctx, undefined);
    expect(ctx.setCommandLine).toHaveBeenCalledWith('/trace x');
    handleMouseEvent(click(40, 18), ctx, undefined);
    expect(ctx.setCommandLine).toHaveBeenCalledTimes(1);
  });

  it('ignores releases, drags, other buttons and clicks outside the regions', () => {
    const ctx = context();
    const last = { row: 1, time: 0 };
    expect(handleMouseEvent({ ...click(0, 9), pressed: false }, ctx, last)).toBe(last);
    expect(handleMouseEvent({ ...click(0, 9), motion: true }, ctx, last)).toBe(last);
    expect(handleMouseEvent({ ...click(0, 9), button: 2 }, ctx, last)).toBe(last);
    expect(handleMouseEvent(click(0, 1), ctx, last)).toBeUndefined();
    expect(ctx.setIsFocused).not.toHaveBeenCalled();
  });
});
