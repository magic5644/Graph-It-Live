/**
 * Pure helpers behind the REPL results navigation: folding, cursor moves, search matches,
 * file/symbol targets found in output rows, their follow-up actions, and the editor launch.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
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

export function findWorkspaceFile(typedPath: string, allFiles: string[], workspaceRoot: string): string | undefined {
  const typed = normalizePath(typedPath);
  return allFiles.find((absoluteFile) =>
    normalizePath(absoluteFile) === typed || toWorkspaceRelativePath(absoluteFile, workspaceRoot) === typed);
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

const TOKEN_EDGES = /^[("'`[{<]+|[)"'`,;\]}>.]+$/g;
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
  for (const word of stripVTControlCharacters(text).split(/\s+/)) {
    const token = word.replaceAll(TOKEN_EDGES, '');
    if (token.length === 0) continue;
    const { candidate, symbol, line } = parseTargetToken(token);
    const file = findWorkspaceFile(candidate, allFiles, workspaceRoot);
    if (file && isInsideWorkspace(file, workspaceRoot)) {
      return { file, relativePath: toWorkspaceRelativePath(file, workspaceRoot), symbol, line };
    }
  }
  return undefined;
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
