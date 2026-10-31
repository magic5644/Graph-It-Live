/**
 * Pure helpers behind the REPL results navigation: folding, cursor moves, search matches,
 * file/symbol targets found in output rows, their follow-up actions, the editor launch,
 * OSC 8 links on those targets, and the optional mouse tracking (`/mouse on|off`).
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { normalizePath } from '../../shared/path';

/** One logical output line; `lineIndex` counts from the block's `$ command` title line (0). */
export interface OutputLine {
  text: string;
  blockIndex: number;
  lineIndex: number;
}

export type LineKey = Pick<OutputLine, 'blockIndex' | 'lineIndex'>;

/** Newest blocks left expanded when a new result arrives; older ones fold unless the user expanded them. */
export const AUTO_EXPANDED_BLOCKS = 3;

const INVERSE = '\u001b[7m';
const NO_INVERSE = '\u001b[27m';

export function toWorkspaceRelativePath(absolutePath: string, workspaceRoot: string): string {
  return normalizePath(path.relative(workspaceRoot, absolutePath));
}

/** Path lookups per file list and root: links scan every visible row, a linear search per word would stall rendering. */
const workspaceFileIndexes = new WeakMap<readonly string[], Map<string, Map<string, string>>>();

/** Normalized absolute and workspace-relative path of each file, the first file winning (the order `find` used). */
function workspaceFileIndex(allFiles: readonly string[], workspaceRoot: string): Map<string, string> {
  let byRoot = workspaceFileIndexes.get(allFiles);
  if (!byRoot) {
    byRoot = new Map();
    workspaceFileIndexes.set(allFiles, byRoot);
  }
  const rootKey = normalizePath(workspaceRoot);
  let index = byRoot.get(rootKey);
  if (!index) {
    index = new Map();
    for (const absoluteFile of allFiles) {
      for (const key of [normalizePath(absoluteFile), toWorkspaceRelativePath(absoluteFile, workspaceRoot)]) {
        if (!index.has(key)) index.set(key, absoluteFile);
      }
    }
    byRoot.set(rootKey, index);
  }
  return index;
}

// File lists are replaced, never mutated, so the cached index of a list stays valid.
export function findWorkspaceFile(typedPath: string, allFiles: string[], workspaceRoot: string): string | undefined {
  return workspaceFileIndex(allFiles, workspaceRoot).get(normalizePath(typedPath));
}

/** True when `file` resolves strictly inside `workspaceRoot` (CWE-22 guard before any spawn). */
export function isInsideWorkspace(file: string, workspaceRoot: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(file));
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export const sameLine = (left: LineKey, right: LineKey): boolean =>
  left.blockIndex === right.blockIndex && left.lineIndex === right.lineIndex;

/** Fold state of every block: the user's choice when there is one, else folded when older than the newest ones. */
export function foldedBlocks(blockCount: number, overrides: ReadonlyMap<number, boolean>): Set<number> {
  const folded = new Set<number>();
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    if (overrides.get(blockIndex) ?? blockIndex < blockCount - AUTO_EXPANDED_BLOCKS) folded.add(blockIndex);
  }
  return folded;
}

/** Lines shown in the panel: a folded block keeps only its title row. */
export function toVisibleLines(lines: OutputLine[], folded: ReadonlySet<number>): OutputLine[] {
  return folded.size === 0 ? lines : lines.filter((line) => line.lineIndex === 0 || !folded.has(line.blockIndex));
}

/**
 * Lines the panel shows and the lines `Ctrl+Y` copies. A filter keeps exactly the matching lines and
 * ignores folding, so every match stays reachable; otherwise folded blocks shrink to their title.
 */
export function selectPanelLines(
  lines: OutputLine[],
  folded: ReadonlySet<number>,
  matches: readonly number[],
  filtering: boolean,
): { visible: OutputLine[]; copy: OutputLine[] } {
  if (!filtering) return { visible: toVisibleLines(lines, folded), copy: lines };
  const matching = matches.map((index) => lines[index]);
  return { visible: matching, copy: matching };
}

/** Body rows of each block (title and blank separator excluded). */
export function countBlockLines(lines: readonly OutputLine[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const line of lines) counts.set(line.blockIndex, (counts.get(line.blockIndex) ?? 0) + 1);
  for (const [blockIndex, count] of counts) counts.set(blockIndex, Math.max(0, count - 2));
  return counts;
}

/** Index of `key` in `visible`; a line hidden by folding maps to its block title, a vanished one to the last line. */
export function cursorIndexOf(visible: readonly OutputLine[], key: LineKey): number {
  const exact = visible.findIndex((line) => sameLine(line, key));
  if (exact >= 0) return exact;
  const title = visible.findIndex((line) => line.blockIndex === key.blockIndex && line.lineIndex === 0);
  return title >= 0 ? title : visible.length - 1;
}

export type FocusMove = 'up' | 'down' | 'pageUp' | 'pageDown' | 'halfUp' | 'halfDown' | 'top' | 'bottom' | 'prevBlock' | 'nextBlock';

/** Previous/next block title row strictly before/after `index`, or `undefined` at the ends. */
export function blockTitleIndex(visible: readonly OutputLine[], index: number, direction: 1 | -1): number | undefined {
  for (let at = index + direction; at >= 0 && at < visible.length; at += direction) {
    if (visible[at].lineIndex === 0) return at;
  }
  return undefined;
}

/** Cursor index after a focus-mode move (pages count logical lines). */
export function focusTargetIndex(move: FocusMove, visible: readonly OutputLine[], index: number, pageSize: number): number {
  const last = visible.length - 1;
  const half = Math.max(1, Math.floor(pageSize / 2));
  if (move === 'top') return 0;
  if (move === 'bottom') return last;
  if (move === 'prevBlock' || move === 'nextBlock') return blockTitleIndex(visible, index, move === 'nextBlock' ? 1 : -1) ?? index;
  const steps = { up: -1, down: 1, pageUp: -pageSize, pageDown: pageSize, halfUp: -half, halfDown: half };
  return Math.max(0, Math.min(last, index + steps[move]));
}

/** Indices in `lines` whose text (ANSI codes ignored) contains `query`, case-insensitive. */
export function findMatches(lines: readonly OutputLine[], query: string): number[] {
  if (query.trim().length === 0) return [];
  const needle = query.toLowerCase();
  const matches: number[] = [];
  lines.forEach((line, index) => {
    if (stripVTControlCharacters(line.text).toLowerCase().includes(needle)) matches.push(index);
  });
  return matches;
}

/**
 * Position in `matches` of the next (`1`) or previous (`-1`) match from line `from`, wrapping around.
 * `inclusive` accepts a match on `from` itself (search-as-you-type).
 */
export function stepMatch(matches: readonly number[], from: number, direction: 1 | -1, inclusive = false): number | undefined {
  if (matches.length === 0) return undefined;
  if (direction === 1) {
    // findIndex returns -1 when no match follows: wrap to the first one.
    return Math.max(0, matches.findIndex((match) => (inclusive ? match >= from : match > from)));
  }
  const previous = matches.findLastIndex((match) => (inclusive ? match <= from : match < from));
  return previous < 0 ? matches.length - 1 : previous;
}

/** Text with every `query` match in inverse video; a matching row loses its own colors so codes never split. */
export function highlightMatches(text: string, query: string): string {
  const plain = stripVTControlCharacters(text);
  const lower = plain.toLowerCase();
  const needle = query.toLowerCase();
  // Lowercasing can change the length (`İ`): indices would no longer line up, so leave the row as is.
  if (query.trim().length === 0 || lower.length !== plain.length || !lower.includes(needle)) return text;
  let result = '';
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    result += `${plain.slice(from, at)}${INVERSE}${plain.slice(at, at + needle.length)}${NO_INVERSE}`;
    from = at + needle.length;
  }
  return result + plain.slice(from);
}

export interface ResultTarget {
  /** Absolute path of an indexed workspace file. */
  file: string;
  relativePath: string;
  symbol?: string;
  line?: number;
}

const LEADING_PUNCTUATION = '("\'`[{<';
const TRAILING_PUNCTUATION = ')"\'`,;]}>.';

/** Word without surrounding quotes, brackets and punctuation (a loop: a trailing-class regex backtracks quadratically). */
function trimTokenEdges(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && LEADING_PUNCTUATION.includes(word[start])) start++;
  while (end > start && TRAILING_PUNCTUATION.includes(word[end - 1])) end--;
  return word.slice(start, end);
}
const SYMBOL_NAME = /^[\w$.]+$/;

function parseTargetToken(token: string): { candidate: string; symbol?: string; line?: number } {
  const hashIndex = token.indexOf('#');
  if (hashIndex > 0) {
    const symbol = token.slice(hashIndex + 1);
    return { candidate: token.slice(0, hashIndex), symbol: SYMBOL_NAME.test(symbol) ? symbol : undefined };
  }
  const lineSuffix = /:(\d+)(?::\d+)?$/.exec(token);
  if (lineSuffix) return { candidate: token.slice(0, lineSuffix.index), line: Number(lineSuffix[1]) };
  // Graph node ids (`/abs/file.ts:Symbol`) in explain and trace output.
  const symbolSuffix = /:([A-Za-z_$][\w$]*)$/.exec(token);
  return symbolSuffix ? { candidate: token.slice(0, symbolSuffix.index), symbol: symbolSuffix[1] } : { candidate: token };
}

/**
 * First file of the workspace index named in an output row, read left to right: `relativePath: <p>`,
 * `path: <abs>`, `"relativePath": "<p>"` (JSON), `<file>#<Symbol>`, `<file>:<Symbol>` (node ids),
 * `<file>:<line>` or a bare path.
 * Only indexed files inside the workspace qualify, so output text never reaches the filesystem.
 */
export function extractResultTarget(text: string, workspaceRoot: string, allFiles: string[]): ResultTarget | undefined {
  return findResultTarget(text, workspaceRoot, allFiles)?.target;
}

/** The target, the token naming it, and the token offset in the text without ANSI codes. */
function findResultTarget(
  text: string,
  workspaceRoot: string,
  allFiles: string[],
): { target: ResultTarget; token: string; offset: number } | undefined {
  for (const word of stripVTControlCharacters(text).matchAll(/\S+/g)) {
    const token = trimTokenEdges(word[0]);
    if (token.length === 0) continue;
    const { candidate, symbol, line } = parseTargetToken(token);
    const file = findWorkspaceFile(candidate, allFiles, workspaceRoot);
    if (file && isInsideWorkspace(file, workspaceRoot)) {
      // Leading punctuation never starts the token, so its first occurrence in the word is the trimmed one.
      const offset = word.index + word[0].indexOf(token);
      return { target: { file, relativePath: toWorkspaceRelativePath(file, workspaceRoot), symbol, line }, token, offset };
    }
  }
  return undefined;
}

/** Terminals that render OSC 8 links (`TERM_PROGRAM`); Apple Terminal would print the escape bytes. */
const HYPERLINK_TERMINALS = new Set(['iTerm.app', 'vscode', 'WezTerm', 'ghostty']);

/**
 * True when result targets may be printed as OSC 8 links. `FORCE_HYPERLINK=0` turns them off and any
 * other value forces them (the `supports-hyperlinks` convention); `NO_COLOR`, `TERM=dumb` and a
 * non-TTY output turn them off.
 */
export function supportsHyperlinks(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.FORCE_HYPERLINK !== undefined) return env.FORCE_HYPERLINK !== '0';
  if (!isTTY || env.NO_COLOR || env.TERM === 'dumb') return false;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || HYPERLINK_TERMINALS.has(env.TERM_PROGRAM ?? '')) return true;
  return Number(env.VTE_VERSION) >= 5000;
}

/**
 * `file://` URI of an absolute path (`file:///C:/…` on Windows). Every byte outside the characters
 * ANSI parsers accept in an OSC parameter (`(`, `;`, `!`, …) is percent-encoded too, so
 * `stripVTControlCharacters` and wrap-ansi still recognize the whole link.
 */
export function toFileUri(file: string, platform: NodeJS.Platform = process.platform): string {
  return pathToFileURL(file, { windows: platform === 'win32' }).href
    .replaceAll(/[^-\w/#&.:=?%@~]/g, (char) => `%${char.codePointAt(0)?.toString(16).toUpperCase().padStart(2, '0')}`);
}

const OSC8 = '\u001b]8;;';
// BEL ends the link: the terminator wrap-ansi writes when it closes and reopens a link around a row break.
const BEL = '\u0007';

/**
 * `text` with its result target (see `extractResultTarget`) wrapped in an OSC 8 link to the file.
 * Unchanged when there is no target or when styling splits the token.
 */
export function linkResultTarget(
  text: string,
  workspaceRoot: string,
  allFiles: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const found = findResultTarget(text, workspaceRoot, allFiles);
  if (!found) return text;
  // ANSI codes only add characters, so the token sits at or after its plain-text offset.
  const at = text.indexOf(found.token, found.offset);
  if (at < 0) return text;
  const link = `${OSC8}${toFileUri(found.target.file, platform)}${BEL}${found.token}${OSC8}${BEL}`;
  return text.slice(0, at) + link + text.slice(at + found.token.length);
}

/** Row without its colors but with its OSC 8 links, so the inverse-video cursor row stays clickable. */
export function stripStylesKeepLinks(row: string): string {
  let result = '';
  let from = 0;
  for (let at = row.indexOf(OSC8); at >= 0; at = row.indexOf(OSC8, from)) {
    const end = row.indexOf(BEL, at);
    if (end < 0) break;
    result += stripVTControlCharacters(row.slice(from, at)) + row.slice(at, end + 1);
    from = end + 1;
  }
  return result + stripVTControlCharacters(row.slice(from));
}

export const MOUSE_TRACKING_ON = '\u001b[?1000h\u001b[?1002h\u001b[?1006h';
export const MOUSE_TRACKING_OFF = '\u001b[?1000l\u001b[?1002l\u001b[?1006l';

/** One SGR (1006) mouse report; `x`/`y` are 0-based screen cells. */
export interface MouseReport {
  /** 0 left, 1 middle, 2 right (modifier bits removed). */
  button: number;
  x: number;
  y: number;
  /** `M` press (or drag), `m` release. */
  pressed: boolean;
  /** Drag: movement with a button held. */
  motion: boolean;
  wheel?: 'up' | 'down';
}

const SGR_MOUSE_PREFIX = '\u001b[<';
const SGR_MOUSE_REPORT = /^(\d{1,4});(\d{1,4});(\d{1,4})([Mm])/;

/**
 * Mouse reports `ESC [ < b ; x ; y M|m` found in a stdin chunk; other bytes are ignored.
 * shortcut: a report split across two chunks is dropped, terminals write each one in a single write.
 */
export function parseSgrMouse(chunk: string): MouseReport[] {
  return chunk.split(SGR_MOUSE_PREFIX).slice(1).flatMap((part) => {
    const report = SGR_MOUSE_REPORT.exec(part);
    if (!report) return [];
    const code = Number(report[1]);
    const isWheel = (code & 64) !== 0;
    let wheel: MouseReport['wheel'];
    if (isWheel) wheel = (code & 1) === 0 ? 'up' : 'down';
    return [{
      button: code & 3,
      x: Number(report[2]) - 1,
      y: Number(report[3]) - 1,
      pressed: report[4] === 'M',
      motion: (code & 32) !== 0,
      wheel,
    }];
  });
}

/**
 * Write `MOUSE_TRACKING_ON` and return the function that writes `MOUSE_TRACKING_OFF` (once). It also
 * runs on process `exit` (normal end, `process.exit`, uncaught error) and `SIGTERM`, so the terminal
 * is never left in mouse mode. The CLI keeps its own `SIGTERM` handler (`src/cli/index.ts`), so this
 * listener does not change how the process ends.
 */
export function enableMouseTracking(
  write: (data: string) => void,
  proc: Pick<NodeJS.Process, 'once' | 'off'> = process,
): () => void {
  let active = true;
  const disable = (): void => {
    if (!active) return;
    active = false;
    proc.off('exit', disable);
    proc.off('SIGTERM', disable);
    write(MOUSE_TRACKING_OFF);
  };
  write(MOUSE_TRACKING_ON);
  proc.once('exit', disable);
  proc.once('SIGTERM', disable);
  return disable;
}

export type MouseRegionKind = 'results' | 'picker' | 'palette' | 'hints';

/** Screen rows `top` to `top + count - 1` (0-based) holding clickable entries of one kind. */
export interface MouseRegion {
  kind: MouseRegionKind;
  top: number;
  count: number;
}

/** Region under screen row `y`, with the entry index inside it. */
export function hitMouseRegion(y: number, regions: readonly MouseRegion[]): { kind: MouseRegionKind; index: number } | undefined {
  const region = regions.find((candidate) => y >= candidate.top && y < candidate.top + candidate.count);
  return region && { kind: region.kind, index: y - region.top };
}

/**
 * Next-step hint under column `x` of the line `→ hint · hint · hint`.
 * shortcut: one cell per UTF-16 unit, a hint with wide characters shifts the ones after it.
 */
export function hintAt(hints: readonly string[], x: number): string | undefined {
  let start = 2;
  for (const hint of hints) {
    if (x >= start && x < start + hint.length) return hint;
    start += hint.length + 3;
  }
  return undefined;
}

export const DOUBLE_CLICK_MS = 400;

/** A click on output row `row` (absolute, scrolling included) at `time` ms. */
export interface ClickStamp {
  row: number;
  time: number;
}

export const isDoubleClick = (previous: ClickStamp | undefined, next: ClickStamp): boolean =>
  previous?.row === next.row && next.time - previous.time < DOUBLE_CLICK_MS;

export const MOUSE_ON_MESSAGE = 'Mouse tracking on: wheel scrolls, click moves the cursor, double click opens the actions, '
  + 'click picks palette and picker entries. Select text with Option+drag (macOS) or Shift+drag (Linux, Windows). '
  + '/mouse off restores native selection.';

/** Reply to `/mouse on|off`, handled by the REPL UI itself; `undefined` for any other command. */
export function resolveMouseCommand(commandLine: string): { command: string; output: string; mouse?: boolean } | undefined {
  const [command, argument, extra] = commandLine.trim().split(/\s+/);
  if (command !== '/mouse') return undefined;
  if (argument === 'on' && extra === undefined) return { command: 'mouse', output: MOUSE_ON_MESSAGE, mouse: true };
  if (argument === 'off' && extra === undefined) {
    return { command: 'mouse', output: 'Mouse tracking off: native selection restored.', mouse: false };
  }
  return { command: 'mouse', output: 'Usage: /mouse on|off (off by default).' };
}

export interface ResultAction {
  label: string;
  /** REPL command line to run; absent for "Open in editor". */
  commandLine?: string;
}

export const OPEN_IN_EDITOR = 'Open in editor';

const quoteArgument = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

/** Follow-up commands for a target: symbol commands for `file#Symbol`, file commands otherwise, then the editor. */
export function buildResultActions(target: ResultTarget): ResultAction[] {
  const subject = quoteArgument(target.symbol ? `${target.relativePath}#${target.symbol}` : target.relativePath);
  const commands = target.symbol ? ['/trace', '/callers', '/impact'] : ['/explain', '/check-dependencies', '/cycles', '/file'];
  return [
    ...commands.map((command) => ({ label: `${command} ${subject}`, commandLine: `${command} ${subject}` })),
    { label: OPEN_IN_EDITOR },
  ];
}

export interface EditorLaunch {
  command: string;
  args: string[];
}

/** Editors that need the terminal the REPL is drawing on. */
const TERMINAL_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'micro', 'hx', 'helix', 'kak', 'joe', 'ne', 'ed', 'pico', 'mg']);
/** VS Code family: `-g file:line` opens at the line. */
const GOTO_EDITORS = new Set(['code', 'code-insiders', 'codium', 'cursor', 'windsurf']);

function editorFileArgs(name: string, target: ResultTarget): string[] {
  const location = target.line ? `${target.file}:${target.line}` : target.file;
  // shortcut: only the VS Code family gets the line, other GUI editors open the file at its top.
  return GOTO_EDITORS.has(name) ? ['-g', location] : [target.file];
}

/**
 * GUI editor to open `target` with: `$VISUAL`, then `$EDITOR`, then `code` inside the VS Code terminal.
 * Terminal editors are skipped (they would fight Ink for the TTY). On Windows, Node refuses to spawn
 * `.cmd`/`.bat` without a shell (CVE-2024-27980), so `code.cmd` is not used there: set an `.exe` editor.
 */
export function resolveEditorLaunch(
  target: ResultTarget,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): EditorLaunch | undefined {
  for (const configured of [env.VISUAL, env.EDITOR]) {
    // shortcut: split on spaces, an editor path containing spaces needs a wrapper script.
    const [command, ...extraArgs] = (configured ?? '').trim().split(/\s+/);
    const name = path.basename(command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    const blockedOnWindows = platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    if (command && !TERMINAL_EDITORS.has(name) && !blockedOnWindows) {
      return { command, args: [...extraArgs, ...editorFileArgs(name, target)] };
    }
  }
  if (env.TERM_PROGRAM === 'vscode' && platform !== 'win32') {
    return { command: 'code', args: editorFileArgs('code', target) };
  }
  return undefined;
}

/** Open `target` in a GUI editor, detached, without a shell; resolves to the notice to show. */
export function openInEditor(
  target: ResultTarget,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (!isInsideWorkspace(target.file, workspaceRoot)) {
    return Promise.resolve('Refusing to open a file outside the workspace');
  }
  const launch = resolveEditorLaunch(target, env, platform);
  if (!launch) {
    return Promise.resolve('No GUI editor found: set VISUAL or EDITOR (code, subl, …), or copy the line with y');
  }
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { shell: false, detached: true, stdio: 'ignore' });
    // On Windows a bare `code` is `code.cmd`, which cannot start without a shell.
    const hint = platform === 'win32' ? ' (on Windows, set VISUAL or EDITOR to an .exe editor)' : '';
    child.once('error', (error) => resolve(`Editor failed: ${error.message}${hint}`));
    child.once('spawn', () => {
      child.unref();
      resolve(`Opened ${target.relativePath} in ${path.basename(launch.command)}`);
    });
  });
}
