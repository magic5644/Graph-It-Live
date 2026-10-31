/**
 * Ink REPL app rendered with fake terminal streams: key routing, wrapped results,
 * counter, Esc, picker and clipboard as the user sees them.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock('node:child_process', () => ({ spawnSync }));

import { runInkReplSession, type InkReplCommandResponse } from '../../src/cli/repl/ink/ReplInkApp';

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  frames: string[] = [];
  constructor(public columns: number, public rows: number) {
    super();
  }
  write(chunk: string, callback?: () => void): boolean {
    this.frames.push(chunk);
    callback?.();
    return true;
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

const KEY = {
  up: '\u001b[A',
  down: '\u001b[B',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  home: '\u001b[H',
  end: '\u001b[F',
  enter: '\r',
  tab: '\t',
  escape: '\u001b',
  backspace: '\u007f',
  ctrlC: '\u0003',
  ctrlF: '\u0006',
  ctrlL: '\u000c',
  ctrlN: '\u000e',
  ctrlP: '\u0010',
  ctrlY: '\u0019',
};

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for Ink to draw again (slow CI runners), or give up quietly for keys that change nothing. */
async function nextFrame(stdout: FakeStdout, timeoutMs = 1000): Promise<void> {
  const count = stdout.frames.length;
  for (let waited = 0; waited < timeoutMs && stdout.frames.length === count; waited += 10) {
    await tick(10);
  }
  await tick(20);
}

interface Session {
  stdout: FakeStdout;
  stdin: PassThrough;
  press: (...keys: string[]) => Promise<void>;
  screen: () => string[];
  text: () => string;
  done: Promise<void>;
}

let active: Session | undefined;

const workspaceRoot = path.resolve('/workspace');
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
const echo = (output: string) => async (line: string): Promise<InkReplCommandResponse> => ({ command: line, output });

async function startSession(
  onSubmitCommand: (line: string) => Promise<InkReplCommandResponse>,
  { columns = 80, rows = 24, allFiles = [] as string[] } = {},
): Promise<Session> {
  const stdout = new FakeStdout(columns, rows);
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });
  const done = runInkReplSession({
    version: '0.0.0-test',
    workspaceRoot,
    allFiles,
    preferredFormat: 'text',
    onSubmitCommand,
    renderOptions: {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  });
  for (let attempt = 0; attempt < 50 && !stdout.frames.some((frame) => frame.includes('Graph-It-Live')); attempt++) {
    await tick(20);
  }
  const screen = (): string[] => {
    const last = stdout.frames.findLast((frame) => frame.includes('Graph-It-Live')) ?? '';
    return stripVTControlCharacters(last).replace(/\n$/, '').split('\n');
  };
  const session: Session = {
    stdout,
    stdin,
    done,
    press: async (...keys) => {
      for (const key of keys) {
        stdin.write(key);
        await nextFrame(stdout);
      }
    },
    screen,
    text: () => screen().join('\n'),
  };
  active = session;
  return session;
}

async function run(session: Session, command: string): Promise<void> {
  await session.press(command, KEY.enter);
  for (let waited = 0; waited < 2000 && /❯ \S|⏳/.test(session.text()); waited += 10) {
    await tick(10);
  }
}

const counter = (session: Session) => /Results(?: \(lines (\d+)-(\d+) \/ (\d+)\))?/.exec(session.text())?.slice(1);

afterEach(async () => {
  if (active) {
    // Esc first: an open picker swallows Ctrl+C.
    active.stdin.write(KEY.escape);
    await tick(20);
    active.stdin.write(KEY.ctrlC);
    await active.done;
    active = undefined;
  }
  spawnSync.mockClear();
});

describe('Ink REPL results navigation', () => {
  it('shows no line range before any output', async () => {
    const session = await startSession(echo(''));
    expect(session.text()).toContain('No results yet');
    expect(counter(session)).toEqual([undefined, undefined, undefined]);
  });

  it('scrolls the results with ↑/↓ on an empty prompt instead of recalling history', async () => {
    const session = await startSession(echo(numbered(60)));
    await run(session, '/summary');
    expect(counter(session)).toEqual(['52', '62', '62']);

    await session.press(KEY.up, KEY.up);
    expect(counter(session)).toEqual(['50', '60', '62']);
    expect(session.text()).not.toContain('History');

    await session.press(KEY.down);
    expect(counter(session)).toEqual(['51', '61', '62']);
  });

  it('scrolls by page and jumps to the ends', async () => {
    const session = await startSession(echo(numbered(60)));
    await run(session, '/summary');
    await session.press(KEY.pageUp);
    expect(counter(session)).toEqual(['41', '51', '62']);
    await session.press(KEY.home);
    expect(counter(session)).toEqual(['1', '11', '62']);
    await session.press(KEY.pageDown);
    expect(counter(session)).toEqual(['12', '22', '62']);
    await session.press(KEY.end);
    expect(counter(session)).toEqual(['52', '62', '62']);
  });

  it('keeps history on Ctrl+P/Ctrl+N and on ↑/↓ while browsing', async () => {
    const session = await startSession(echo(numbered(60)));
    await run(session, '/summary');
    await session.press(KEY.ctrlP);
    expect(session.text()).toContain('History 1/1');
    expect(session.text()).toContain('❯ /summary');

    await session.press(KEY.down);
    expect(session.text()).toContain('History cleared');
    await session.press(KEY.up);
    expect(session.text()).not.toContain('History 1/1');
    await session.press(KEY.ctrlP, KEY.ctrlN);
    expect(session.text()).toContain('History cleared');
  });

  it('reports a failed command as an output block', async () => {
    const session = await startSession(async () => { throw new Error('boom'); });
    await run(session, '/summary');
    expect(session.text()).toContain('Command failed');
    expect(session.text()).toContain('Error: boom');
  });

  it('moves in the slash palette with ↑/↓ and closes it with Esc', async () => {
    const session = await startSession(echo(numbered(60)));
    await run(session, '/summary');
    await session.press('/', 'c');
    expect(session.text()).toMatch(/Suggestions 1\/\d+/);
    await session.press(KEY.down);
    expect(session.text()).toMatch(/Suggestions 2\/\d+/);
    await session.press(KEY.up);
    expect(session.text()).toMatch(/Suggestions 1\/\d+/);
    expect(counter(session)?.[1]).toBe('62');

    await session.press(KEY.escape);
    expect(session.text()).toContain('Command cleared');
    expect(session.text()).not.toMatch(/Suggestions \d+\/\d+/);
  });

  it('scrolls the results with ↑ in search mode', async () => {
    const session = await startSession(echo(numbered(60)));
    await run(session, '/summary');
    await session.press(KEY.ctrlF, KEY.up);
    // Search mode hides the next-step line, so the panel is one row taller.
    expect(counter(session)).toEqual(['50', '61', '62']);
    expect(session.text()).not.toContain('History');
  });

  it('keeps the first visible row when the footer grows mid-list', async () => {
    const session = await startSession(echo(numbered(60)));
    await run(session, '/summary');
    await session.press(KEY.pageUp, KEY.pageUp);
    const [start] = counter(session) ?? [];
    await session.press('/');
    expect(session.text()).toMatch(/Suggestions 1\/\d+/);
    expect(counter(session)?.[0]).toBe(start);
  });

  it('keeps the prompt marker on a command wider than the terminal', async () => {
    const session = await startSession(echo('ok'), { columns: 40, rows: 20 });
    await session.press(`/summary ${'x'.repeat(60)}`);
    expect(session.screen().some((line) => line.startsWith('❯ …') && line.endsWith('xxx'))).toBe(true);
    expect(session.screen().length).toBeLessThanOrEqual(20);
  });

  it('clears an applied search filter with Esc', async () => {
    const session = await startSession(echo(numbered(60)));
    await run(session, '/summary');
    await session.press(KEY.ctrlF, '5', '9', KEY.backspace, KEY.enter);
    expect(session.text()).toContain('Search filter applied');
    expect(session.text()).toContain('filter: 5');
    expect(counter(session)).toEqual(['1', '11', '15']);

    await session.press(KEY.escape);
    expect(session.text()).toContain('Search cleared');
    expect(session.text()).not.toContain('filter:');
  });

  it('wraps lines wider than the panel and never renders more rows than the terminal', async () => {
    const long = 'x'.repeat(100);
    const session = await startSession(echo(`${long}\n${'y'.repeat(30)}`), { columns: 40, rows: 20 });
    await run(session, '/summary');
    const screen = session.screen();
    expect(screen.length).toBeLessThanOrEqual(20);
    expect(screen[0]).toContain('Graph-It-Live');
    expect(Math.max(...screen.map((line) => line.length))).toBeLessThanOrEqual(40);
    expect(counter(session)?.[2]).toBe('6');
  });

  it('re-wraps on resize and stays on the last row', async () => {
    const session = await startSession(echo(`${'x'.repeat(100)}\n${numbered(20)}`), { columns: 80, rows: 24 });
    await run(session, '/summary');
    expect(counter(session)).toEqual(['14', '24', '24']);
    session.stdout.resize(40, 24);
    await nextFrame(session.stdout);
    expect(counter(session)).toEqual(['15', '25', '25']);
    expect(session.screen().length).toBeLessThanOrEqual(24);
  });

  it('cycles next-step hints with Tab', async () => {
    const session = await startSession(echo('ok'));
    await run(session, '/summary');
    await session.press(KEY.tab);
    expect(session.text()).toContain('Next step selected');
    expect(session.text()).toContain('❯ /summary');
  });

  it('copies the output and the first visible line', async () => {
    const session = await startSession(echo(numbered(3)));
    await run(session, '/summary');
    await session.press(KEY.ctrlY);
    expect(session.text()).toContain('Copied full output to clipboard');
    expect(String((spawnSync.mock.calls[0] as unknown[])[2] && (spawnSync.mock.calls[0] as unknown as [string, string[], { input: string }])[2].input))
      .toContain('line 3');
    await session.press(KEY.ctrlL);
    expect(session.text()).toContain('Copied selected line to clipboard');
  });

  it('opens the directory picker, navigates and cancels it with Esc', async () => {
    const allFiles = [path.join(workspaceRoot, 'src', 'a.ts'), path.join(workspaceRoot, 'test', 'b.ts')];
    const session = await startSession(echo('ok'), { allFiles });
    await session.press('/', 's', 'c', 'o', 'p', 'e', KEY.enter);
    expect(session.text()).toContain('Select directory');
    await session.press(KEY.down);
    expect(session.text()).toContain('❯ 📁 test/');
    await session.press(KEY.up);
    expect(session.text()).toContain('❯ 📁 src/');
    await session.press(KEY.escape);
    expect(session.text()).toContain('Picker cancelled');
  });

  it('enters a directory, goes back up and selects it with Space in the directory picker', async () => {
    const allFiles = [path.join(workspaceRoot, 'src', 'a.ts')];
    const submit = vi.fn(echo('ok'));
    const session = await startSession(submit, { allFiles });
    await session.press('/', 's', 'c', 'o', 'p', 'e', KEY.enter);
    await session.press(KEY.enter);
    expect(session.text()).toContain('📍 src');
    await session.press(KEY.backspace);
    expect(session.text()).toContain('📍 .');
    await session.press(KEY.enter, ' ');
    await tick(60);
    expect(submit).toHaveBeenCalledWith('/scope src');
  });

  it('picks a file in the file picker and runs the command on it', async () => {
    const allFiles = [path.join(workspaceRoot, 'src', 'a.ts')];
    const submit = vi.fn(echo('ok'));
    const session = await startSession(submit, { allFiles });
    await session.press('/', 'c', 'y', 'c', 'l', 'e', 's', KEY.enter);
    expect(session.text()).toContain('Select file for /cycles');
    await session.press(KEY.enter, KEY.enter);
    await tick(60);
    expect(submit).toHaveBeenCalledWith('/cycles src/a.ts');
  });

  it('completes a command and its file argument with Tab', async () => {
    const allFiles = [path.join(workspaceRoot, 'src', 'a.ts')];
    const submit = vi.fn(echo('ok'));
    const session = await startSession(submit, { allFiles });
    await session.press('/', 'c', 'y', 'c');
    expect(session.text()).toContain('Completion: /cycles');
    await session.press(KEY.tab);
    expect(session.text()).toContain('Command selected: /cycles');
    await session.press('s', 'r');
    expect(session.text()).toContain('Completion: /cycles src');
    await session.press(KEY.tab);
    expect(session.text()).toContain('Argument selected');
    await session.press(KEY.enter);
    await tick(60);
    expect(submit).toHaveBeenCalledWith(expect.stringMatching(/^\/cycles src/));
  });

  it('applies the context returned by a command and suggests follow-ups for the file', async () => {
    const otherRoot = path.resolve('/other');
    const session = await startSession(async (line) => ({
      command: line,
      output: 'done',
      updatedContext: {
        workspaceRoot: otherRoot,
        allFiles: [path.join(otherRoot, 'b.ts')],
        preferredFormat: 'json',
        lastFile: path.join(otherRoot, 'b.ts'),
        lastSymbol: null,
      },
    }));
    await run(session, '/file b.ts');
    expect(session.text()).toContain('format: json');
    expect(session.text()).toContain('last file: b.ts');
    expect(session.text()).toContain('/explain b.ts');

    await session.press('/', 'c', 'y', 'c', 'l', 'e', 's', KEY.enter);
    expect(session.text()).toContain('❯ /cycles b.ts');
  });

  it('lists the symbols of a file after # for /trace', async () => {
    const allFiles = [path.join(workspaceRoot, 'src', 'a.ts')];
    const listFileSymbols = vi.fn(async () => ['main', 'helper']);
    const stdout = new FakeStdout(80, 24);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined, ref: () => undefined, unref: () => undefined });
    const done = runInkReplSession({
      version: '0.0.0-test', workspaceRoot, allFiles, preferredFormat: 'text', onSubmitCommand: echo('ok'), listFileSymbols,
      renderOptions: { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, interactive: true, patchConsole: false, exitOnCtrlC: false },
    });
    for (const key of [...'/trace src/a.ts#']) {
      stdin.write(key);
      await tick(15);
    }
    await tick(80);
    const last = stripVTControlCharacters(stdout.frames.findLast((frame) => frame.includes('Graph-It-Live')) ?? '');
    expect(listFileSymbols).toHaveBeenCalledWith(path.join(workspaceRoot, 'src', 'a.ts'));
    expect(last).toContain('helper');
    stdin.write(KEY.ctrlC);
    await done;
  });

  it('reports an empty command and quits when the command asks to', async () => {
    const session = await startSession(async (line) => ({ command: line, output: '', shouldQuit: line === '/quit' }));
    await session.press(KEY.enter);
    expect(session.text()).toContain('Empty command');
    await session.press('/quit', KEY.enter);
    await session.done;
    active = undefined;
  });
});
