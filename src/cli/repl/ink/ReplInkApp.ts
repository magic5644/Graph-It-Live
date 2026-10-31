import React, { useEffect, useMemo, useState, useRef } from 'react';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import wrapAnsi from 'wrap-ansi';
import { normalizePath } from '../../../shared/path';
import {
  buildResultActions,
  countBlockLines,
  cursorIndexOf,
  extractResultTarget,
  findMatches,
  findWorkspaceFile,
  focusTargetIndex,
  foldedBlocks,
  highlightMatches,
  openInEditor,
  sameLine,
  stepMatch,
  selectPanelLines,
  toWorkspaceRelativePath,
  type FocusMove,
  type LineKey,
  type OutputLine,
  type ResultAction,
  type ResultTarget,
} from '../resultsNavigation';

export type { OutputLine } from '../resultsNavigation';

const h = React.createElement;

export interface InkReplCommandResponse {
  command: string;
  output?: string;
  shouldQuit?: boolean;
  /** Updated REPL context to reflect session state changes (workspace, file, etc.) */
  updatedContext?: {
    workspaceRoot?: string;
    allFiles?: string[];
    preferredFormat?: string;
    lastFile?: string | null;
    lastSymbol?: string | null;
  };
}

interface RunInkReplSessionOptions {
  version: string;
  workspaceRoot: string;
  allFiles: string[];
  preferredFormat: string;
  lastFile?: string;
  lastSymbol?: string;
  onSubmitCommand: (commandLine: string) => Promise<InkReplCommandResponse>;
  /** Symbol names of a workspace file, for `file#Symbol` completion. */
  listFileSymbols?: (absoluteFile: string) => Promise<string[]>;
  /** Extra Ink render options; tests pass fake streams here. */
  renderOptions?: import('ink').RenderOptions;
}

interface OutputBlock {
  title: string;
  body: string;
}

interface SlashCommandEntry {
  command: string;
  group?: string;
  description: string;
  argsHint?: string;
  insertText?: string;
  targetCommand?: string;
  isArgument?: boolean;
  autoExecute?: boolean;
}

type PickerMode = 'none' | 'path' | 'file';

interface PickerEntry {
  name: string;
  relPath: string;
  isDir: boolean;
}

interface PickerTarget {
  command: string;
  baseLine?: string;
  /** Workspace-relative file to preselect (the current file), so Enter reruns on it. */
  startFile?: string;
}

const BLUE = '\u001b[38;5;33m';
const ORANGE = '\u001b[38;5;214m';
const SPARK = '\u001b[38;5;117m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';
const MAX_VISIBLE_SLASH_SUGGESTIONS = 8;
const MIN_RESULTS_PANEL_ROWS = 4;
const HEADER_ROWS = 7;
const BASE_FOOTER_ROWS = 3;

const SLASH_COMMANDS: SlashCommandEntry[] = [
  { group: 'Navigate', command: '/scope', description: 'Set workspace scope', argsHint: '/scope <directory>' },
  { group: 'Navigate', command: '/file', description: 'Set active file context', argsHint: '/file <path>' },
  { group: 'Understand', command: '/trace', description: 'Trace symbol or explain file', argsHint: '/trace <file#Symbol> [--maxDepth N]' },
  { group: 'Understand', command: '/explain', description: 'Explain file logic', argsHint: '/explain <file>' },
  { group: 'Understand', command: '/context', description: 'Bounded graph context for a question or the current symbol', argsHint: '/context ["<question>"] [--detail compact] [--token-budget N]' },
  { group: 'Understand', command: '/query', description: 'Query the codebase with natural language', argsHint: '/query "<question>" [--depth N] [--token-budget N]' },
  { group: 'Relations', command: '/check-dependencies', description: 'Analyze incoming/outgoing deps', argsHint: '/check-dependencies <file> [--incoming|--outgoing|--both]' },
  { group: 'Relations', command: '/cycles', description: 'Detect dependency cycles', argsHint: '/cycles <file>' },
  { group: 'Relations', command: '/callers', description: 'Find callers of a symbol', argsHint: '/callers [file#Symbol] [--depth=N] [--includeTypeOnly=true]' },
  { group: 'Relations', command: '/impact', description: 'Impact analysis for a symbol change', argsHint: '/impact [file#Symbol] [--includeTransitive=true] [--maxDepth=N]' },
  { group: 'Workspace', command: '/summary', description: 'Summarize workspace or file' },
  { group: 'Workspace', command: '/architecture', description: 'Build workspace graph', argsHint: '/architecture [--maxFiles N]' },
  { group: 'Workspace', command: '/check', description: 'Find dead code' },
  { group: 'Workspace', command: '/check-architecture', description: 'Check imports against graphit.architecture.json', argsHint: '/check-architecture [--config <file>] [--baseline <file>] [--update-baseline]' },
  { group: 'Workspace', command: '/review-pr', description: 'Review the Git diff against a base ref', argsHint: '/review-pr --base <ref> [--head <ref>]' },
  { group: 'Workspace', command: '/scan', description: 'Force indexing scan' },
  { group: 'Output', command: '/format', description: 'Set default output format', argsHint: '/format <text|json|toon|markdown|mermaid>' },
  { group: 'Output', command: '/export', description: 'Export graph as standalone HTML (vis.js)', argsHint: '/export [path] [--output <file>|-o <file>]' },
  { group: 'Output', command: '/wiki', description: 'Generate a markdown wiki from the call graph', argsHint: '/wiki [--output <dir>] [--top N] [--format markdown|json|toon]' },
  { group: 'Session', command: '/help', description: 'Show REPL help' },
  { group: 'Session', command: '/quit', description: 'Exit REPL' },
];

/** Hidden aliases: accepted when typed, never listed in the palette. */
const SLASH_ALIASES: Record<string, string> = {
  '/path': '/scope',
  '/deps': '/check-dependencies',
  '/dependencies': '/check-dependencies',
  '/deps-in': '/check-dependencies',
  '/deps-out': '/check-dependencies',
  '/path-in': '/check-dependencies',
  '/path-out': '/check-dependencies',
  '/cycle': '/cycles',
};

function resolveSlashAlias(command: string): string {
  return SLASH_ALIASES[command] ?? command;
}

function isScopeCommand(command: string): boolean {
  return resolveSlashAlias(command) === '/scope';
}

export function getSlashCommandHelpLines(): string[] {
  const lines: string[] = [];
  let lastGroup = '';
  for (const { group, command, description, argsHint } of SLASH_COMMANDS) {
    if (group && group !== lastGroup) {
      lines.push(`${DIM}${group}${RESET}`);
      lastGroup = group;
    }
    const usage = argsHint ?? command;
    lines.push(`  ${usage.padEnd(56)} ${description}`);
  }
  const aliases = Object.entries(SLASH_ALIASES).map(([alias, target]) => `${alias} → ${target}`);
  lines.push(`${DIM}Aliases:${RESET} ${aliases.join(', ')}`);
  return lines;
}

const COMMANDS_REQUIRING_ARGS = new Set([
  '/trace',
  '/explain',
  '/scope',
  '/path',
  '/path-in',
  '/path-out',
  '/file',
  '/check-dependencies',
  '/deps',
  '/dependencies',
  '/deps-in',
  '/deps-out',
  '/cycles',
  '/cycle',
  '/format',
]);

const FILE_ARGUMENT_COMMANDS = new Set([
  '/trace',
  '/explain',
  '/path-in',
  '/path-out',
  '/file',
  '/check-dependencies',
  '/deps',
  '/dependencies',
  '/deps-in',
  '/deps-out',
  '/cycles',
  '/cycle',
]);

/** Commands whose argument accepts `file#Symbol`. */
const SYMBOL_ARGUMENT_COMMANDS = new Set(['/trace', '/callers', '/impact']);

const OPTION_VALUE_FLAGS = new Set([
  '--maxDepth',
  '--maxFiles',
  '--format',
  '-f',
]);

const ARG_COMPLETIONS: Record<string, Array<{ value: string; description: string }>> = {
  '/trace': [
    { value: '--maxDepth', description: 'Limit trace depth' },
  ],
  '/check-dependencies': [
    { value: '--incoming', description: 'Show incoming references' },
    { value: '--outgoing', description: 'Show outgoing dependencies' },
    { value: '--both', description: 'Show incoming and outgoing' },
  ],
  '/callers': [
    { value: '--depth=', description: 'Limit caller depth' },
    { value: '--includeTypeOnly=true', description: 'Include type-only references' },
  ],
  '/impact': [
    { value: '--includeTransitive=true', description: 'Include transitive dependents' },
    { value: '--maxDepth=', description: 'Limit transitive depth' },
  ],
  '/context': [
    { value: '--detail', description: 'Output detail (compact for agents)' },
    { value: '--token-budget', description: 'Cap output tokens' },
  ],
  '/review-pr': [
    { value: '--base', description: 'Base Git ref' },
    { value: '--head', description: 'Head Git ref' },
  ],
  '/architecture': [
    { value: '--maxFiles', description: 'Limit analyzed files' },
  ],
  '/check-architecture': [
    { value: '--config', description: 'Rules file in the workspace' },
    { value: '--baseline', description: 'Accepted violations file' },
    { value: '--update-baseline', description: 'Accept every current violation' },
  ],
  '/format': [
    { value: 'text', description: 'Plain text output' },
    { value: 'json', description: 'JSON output' },
    { value: 'toon', description: 'TOON output' },
    { value: 'markdown', description: 'Markdown output' },
    { value: 'mermaid', description: 'Mermaid output' },
  ],
};

function collectWorkspaceDirectories(allFiles: string[], workspaceRoot: string): string[] {
  const directories = new Set<string>();
  for (const absoluteFile of allFiles) {
    const relativeFile = toWorkspaceRelativePath(absoluteFile, workspaceRoot);
    const dirPath = path.posix.dirname(relativeFile);
    if (!dirPath || dirPath === '.') {
      continue;
    }

    const segments = dirPath.split('/');
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      directories.add(current);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

function filterPathSuggestions(
  entries: string[],
  query: string,
): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return entries;
  }

  const matches = entries.filter((entry) => {
    const lower = entry.toLowerCase();
    return lower.startsWith(normalizedQuery) || lower.includes(normalizedQuery);
  });
  // Exact match first: Enter on a complete argument (history, next-step hint) runs that argument.
  const exact = matches.find((entry) => entry === query.trim());
  return exact === undefined ? matches : [exact, ...matches.filter((entry) => entry !== exact)];
}

function buildWorkspacePathSuggestions(
  command: string,
  query: string,
  allFiles: string[],
  workspaceRoot: string,
): SlashCommandEntry[] {
  const filePaths = allFiles.map((absoluteFile) => toWorkspaceRelativePath(absoluteFile, workspaceRoot));
  const directories = collectWorkspaceDirectories(allFiles, workspaceRoot);
  const normalizedQuery = query.trim();

  if (command === '/scope') {
    return filterPathSuggestions(directories, normalizedQuery)
      .map((dirPath) => ({
        command: dirPath,
        description: `Directory ${dirPath === '' ? '.' : dirPath}`,
        insertText: dirPath,
        targetCommand: command,
        isArgument: true,
        autoExecute: true,
      }));
  }

  const filteredFiles = filterPathSuggestions(filePaths, normalizedQuery);

  return [
    ...filteredFiles.map((filePath) => ({
      command: filePath,
      description: `File ${filePath}`,
      insertText: filePath,
      targetCommand: command,
      isArgument: true,
      autoExecute: true,
    })),
  ];
}

/**
 * Workspace file named before `#` in the token being typed, when the command takes `file#Symbol`.
 * Only files of the workspace list qualify, so half-typed paths never trigger symbol extraction.
 */
export function findSymbolCompletionFile(
  input: string,
  allFiles: string[],
  workspaceRoot: string,
): string | undefined {
  if (/\s$/.test(input)) return undefined;
  const tokens = input.trim().split(/\s+/);
  const currentToken = tokens.length > 1 ? (tokens.at(-1) ?? '') : '';
  const hashIndex = currentToken.indexOf('#');
  if (hashIndex <= 0 || !SYMBOL_ARGUMENT_COMMANDS.has(resolveSlashAlias(tokens[0].toLowerCase()))) {
    return undefined;
  }
  return findWorkspaceFile(currentToken.slice(0, hashIndex), allFiles, workspaceRoot);
}

function buildSymbolSuggestions(
  activeCommand: string,
  currentArgToken: string,
  symbols: string[],
): SlashCommandEntry[] {
  const hashIndex = currentArgToken.indexOf('#');
  const filePart = currentArgToken.slice(0, hashIndex);
  return filterPathSuggestions(symbols, currentArgToken.slice(hashIndex + 1))
    .map((symbolName) => ({
      command: `${filePart}#${symbolName}`,
      description: `Symbol ${symbolName}`,
      insertText: `${filePart}#${symbolName}`,
      targetCommand: activeCommand,
      isArgument: true,
      autoExecute: true,
    }));
}

function buildArgumentSuggestions(
  activeCommand: string,
  currentArgToken: string,
  query: string,
  allFiles: string[],
  workspaceRoot: string,
  getFileSymbols?: (absoluteFile: string) => string[] | undefined,
): SlashCommandEntry[] {
  if (SYMBOL_ARGUMENT_COMMANDS.has(activeCommand) && currentArgToken.includes('#')) {
    const symbolFile = findWorkspaceFile(currentArgToken.slice(0, currentArgToken.indexOf('#')), allFiles, workspaceRoot);
    const symbols = symbolFile ? getFileSymbols?.(symbolFile) : undefined;
    return symbols ? buildSymbolSuggestions(activeCommand, currentArgToken, symbols) : [];
  }

  const optionMatches = (ARG_COMPLETIONS[activeCommand] ?? [])
    .filter((candidate) => candidate.value.toLowerCase().startsWith(currentArgToken.toLowerCase()))
    .map((candidate) => ({
      command: candidate.value,
      description: `${candidate.description} (${activeCommand})`,
      insertText: candidate.value,
      targetCommand: activeCommand,
      isArgument: true,
      autoExecute: !candidate.value.startsWith('--'),
    }));

  if (activeCommand === '/scope') {
    return buildWorkspacePathSuggestions(activeCommand, query, allFiles, workspaceRoot);
  }

  if (FILE_ARGUMENT_COMMANDS.has(activeCommand) && !currentArgToken.startsWith('-')) {
    return [
      ...buildWorkspacePathSuggestions(activeCommand, query, allFiles, workspaceRoot),
      ...optionMatches,
    ];
  }

  return optionMatches;
}

function collectPickerDirsAndFiles(
  relFiles: string[],
  prefix: string,
): { dirs: Set<string>; files: string[] } {
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const rel of relFiles) {
    if (prefix && !rel.startsWith(prefix)) continue;
    const remainder = prefix ? rel.slice(prefix.length) : rel;
    if (!remainder) continue;
    const slashIdx = remainder.indexOf('/');
    if (slashIdx < 0) {
      files.push(rel);
    } else {
      dirs.add(remainder.slice(0, slashIdx));
    }
  }
  return { dirs, files };
}

function buildPickerEntries(allFiles: string[], workspaceRoot: string, currentDir: string): PickerEntry[] {
  const relFiles = allFiles.map((f) => toWorkspaceRelativePath(f, workspaceRoot));
  const prefix = currentDir ? `${currentDir}/` : '';
  const { dirs, files } = collectPickerDirsAndFiles(relFiles, prefix);

  const sortedDirs = [...dirs].toSorted((a, b) => a.localeCompare(b));
  const sortedFiles = files.toSorted((a, b) => a.localeCompare(b));

  const dirEntries: PickerEntry[] = sortedDirs.map((dir) => ({
    name: dir,
    relPath: currentDir ? `${currentDir}/${dir}` : dir,
    isDir: true,
  }));
  const fileEntries: PickerEntry[] = sortedFiles.map((file) => ({
    name: file.split('/').at(-1) ?? file,
    relPath: file,
    isDir: false,
  }));
  return [...dirEntries, ...fileEntries];
}

export function filterSlashCommands(
  input: string,
  allFiles: string[],
  workspaceRoot: string,
  getFileSymbols?: (absoluteFile: string) => string[] | undefined,
): SlashCommandEntry[] {
  if (!input.startsWith('/')) return [];

  const trimmed = input.trim();
  const query = trimmed.toLowerCase();
  const queryToken = query.split(/\s+/, 1)[0] ?? query;
  const hasWhitespace = /\s/.test(query);
  const hasTrailingSpace = /\s$/.test(input);

  const commandEntries = SLASH_COMMANDS.map((entry) => ({
    ...entry,
    insertText: entry.command,
    targetCommand: entry.command,
  }));

  const commandMatches = commandEntries.filter((entry) => entry.command.startsWith(queryToken));
  if (hasWhitespace) {
    const activeCommand = commandEntries.find((entry) => entry.command === resolveSlashAlias(queryToken))?.command;
    if (!activeCommand) {
      return commandMatches;
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const currentArgToken = hasTrailingSpace ? '' : (tokens.at(-1) ?? '');
    const argumentQuery = trimmed.slice(queryToken.length);

    return buildArgumentSuggestions(activeCommand, currentArgToken, argumentQuery, allFiles, workspaceRoot, getFileSymbols);
  }

  // Name matches first: typing `/explain` must not select `/trace` ("… explain file").
  const descriptionMatches = commandEntries.filter((entry) =>
    !entry.command.startsWith(queryToken) && entry.description.toLowerCase().includes(query.slice(1)));
  return [...commandMatches, ...descriptionMatches];
}

function completeCommandLine(currentInput: string, targetCommand: string): string {
  const trimmed = currentInput.trim();
  if (!trimmed.startsWith('/')) {
    return `${targetCommand} `;
  }

  const firstToken = trimmed.split(/\s+/, 1)[0] ?? '';
  const remaining = trimmed.slice(firstToken.length).trimStart();
  if (remaining.length > 0) {
    return `${targetCommand} ${remaining}`;
  }
  return `${targetCommand} `;
}

function completeArgumentToken(currentInput: string, argumentValue: string): string {
  const trimmed = currentInput.trim();
  if (!trimmed.startsWith('/')) {
    return `${trimmed} ${argumentValue} `.trimStart();
  }

  const hasTrailingSpace = /\s$/.test(currentInput);
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return `${argumentValue} `;
  }

  if (hasTrailingSpace) {
    return `${trimmed} ${argumentValue} `;
  }

  const replacedTokens = [...tokens];
  replacedTokens[replacedTokens.length - 1] = argumentValue;
  return `${replacedTokens.join(' ')} `;
}

function buildCommandLineFromSelection(currentInput: string, selected: SlashCommandEntry): string {
  if (selected.isArgument) {
    return completeArgumentToken(currentInput, selected.insertText ?? selected.command);
  }

  return completeCommandLine(currentInput, selected.insertText ?? selected.command);
}

function getFirstToken(commandLine: string): string {
  return commandLine.trim().split(/\s+/, 1)[0] ?? '';
}

function normalizeCommandToken(command: string): string {
  return command.startsWith('/') ? command : `/${command}`;
}

function hasUsableFileContext(displayLastFile: string): boolean {
  return displayLastFile.length > 0 && displayLastFile !== 'none';
}

function insertFileArgument(commandLine: string, filePath: string): string {
  const trimmed = commandLine.trim();
  const firstToken = getFirstToken(trimmed);
  const remaining = trimmed.slice(firstToken.length).trimStart();
  return remaining.length > 0
    ? `${firstToken} ${filePath} ${remaining}`
    : `${firstToken} ${filePath}`;
}

function lineHasFileArgument(commandLine: string): boolean {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return false;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('--') && token.includes('=')) {
      continue;
    }
    if (OPTION_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    return true;
  }

  return false;
}

/**
 * `/trace` with a current file puts it on the command line, so `#` completes its symbols; other file
 * commands reopen the file picker on the current file instead, where another file is one key away.
 */
function keepsFileOnCommandLine(command: string, displayLastFile: string): boolean {
  return SYMBOL_ARGUMENT_COMMANDS.has(command) && hasUsableFileContext(displayLastFile);
}

/** Picker folder and row of the current file, or the workspace root when there is none or it left the index. */
export function pickerStartPosition(
  allFiles: string[],
  workspaceRoot: string,
  startFile: string | undefined,
): { dir: string; index: number } {
  const relative = startFile && hasUsableFileContext(startFile) ? normalizePath(startFile) : '';
  const parent = path.posix.dirname(relative);
  const dir = parent === '.' ? '' : parent;
  const index = buildPickerEntries(allFiles, workspaceRoot, dir).findIndex((entry) => entry.relPath === relative);
  return index < 0 ? { dir: '', index: 0 } : { dir, index };
}

function buildPrefilledCommandLine(command: string, displayLastFile: string): string {
  const normalizedCommand = normalizeCommandToken(command);
  if (FILE_ARGUMENT_COMMANDS.has(normalizedCommand) && hasUsableFileContext(displayLastFile)) {
    return `${normalizedCommand} ${displayLastFile} `;
  }

  return `${normalizedCommand} `;
}

function getCompletionPreview(commandLine: string, selectedCommand?: string): string {
  if (!selectedCommand) {
    return '';
  }

  const trimmed = commandLine.trim();
  if (!trimmed.startsWith('/')) {
    return '';
  }

  const firstToken = trimmed.split(/\s+/, 1)[0] ?? '';
  if (firstToken.length === 0 || !selectedCommand.startsWith(firstToken)) {
    return '';
  }

  const suffix = selectedCommand.slice(firstToken.length);
  return suffix;
}

function getArgumentCompletionPreview(commandLine: string, selectedArgument?: string): string {
  if (!selectedArgument) {
    return '';
  }

  const trimmed = commandLine.trim();
  if (!trimmed.startsWith('/')) {
    return '';
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const currentArgToken = tokens.length > 1 ? (tokens.at(-1) ?? '') : '';
  if (currentArgToken.length === 0 || !selectedArgument.startsWith(currentArgToken)) {
    return '';
  }

  return selectedArgument.slice(currentArgToken.length);
}

function getPathSuggestionPreview(commandLine: string, selectedPath?: string): string {
  if (!selectedPath) {
    return '';
  }

  const trimmed = commandLine.trim();
  const firstToken = getFirstToken(trimmed);
  if (!isScopeCommand(firstToken) && !FILE_ARGUMENT_COMMANDS.has(firstToken)) {
    return '';
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const currentPathToken = tokens.length > 1 ? (tokens.at(-1) ?? '') : '';
  if (currentPathToken.length === 0 || !selectedPath.startsWith(currentPathToken)) {
    return '';
  }

  return selectedPath.slice(currentPathToken.length);
}

/**
 * Append typed text to the command line. A `#` typed right after a completed file argument
 * (`/trace src/a.ts ` + `#`) joins that file, so symbol completion starts without a backspace.
 */
export function appendTypedInput(previous: string, input: string): string {
  if (input === '#' && /\S\s+$/.test(previous) && SYMBOL_ARGUMENT_COMMANDS.has(resolveSlashAlias(getFirstToken(previous)))
    && previous.trim().split(/\s+/).length > 1) {
    return `${previous.trimEnd()}#`;
  }
  return previous + input;
}

/**
 * Move through the command history (newest first). `older` from a fresh line recalls the
 * newest command; `newer` past the newest one returns to an empty line (index `null`).
 * Returns `undefined` when there is nowhere to go.
 */
export function stepHistory(
  history: string[],
  index: number | null,
  direction: 'older' | 'newer',
): { index: number | null; line: string } | undefined {
  if (direction === 'older') {
    if (history.length === 0) return undefined;
    const nextIndex = index === null ? 0 : Math.min(index + 1, history.length - 1);
    return { index: nextIndex, line: history[nextIndex] };
  }
  if (index === null) return undefined;
  return index <= 0 ? { index: null, line: '' } : { index: index - 1, line: history[index - 1] };
}

/** Follow-up commands for the current context: the symbol first, then the file, else the workspace. */
export function getNextStepHints(lastFile: string, lastSymbol: string): string[] {
  if (!hasUsableFileContext(lastFile)) {
    return ['/summary', '/architecture', '/check'];
  }
  const file = normalizePath(lastFile);
  if (lastSymbol.length > 0 && lastSymbol !== 'none') {
    return ['/callers', '/impact', '/trace'].map((command) => `${command} ${file}#${lastSymbol}`);
  }
  return ['/explain', '/check-dependencies', '/cycles'].map((command) => `${command} ${file}`);
}

/** Hint that Tab puts on the command line: the first one, then the next after a hint. */
export function cycleNextStepHint(hints: string[], commandLine: string): string | undefined {
  if (hints.length === 0 || (commandLine.length > 0 && !hints.includes(commandLine))) {
    return undefined;
  }
  return hints[(hints.indexOf(commandLine) + 1) % hints.length];
}

/** One terminal row of the results panel: a slice of a wrapped logical line. */
export interface OutputRow extends OutputLine {
  row: string;
}

export function toLines(blocks: OutputBlock[]): OutputLine[] {
  const lines: OutputLine[] = [];
  blocks.forEach((block, blockIndex) => {
    const body = block.body.length === 0 ? ['(no output)'] : block.body.replaceAll('\r\n', '\n').split('\n');
    [`$ ${block.title}`, ...body, ''].forEach((text, lineIndex) => lines.push({ text, blockIndex, lineIndex }));
  });
  return lines;
}

/** Split lines into rows at most `width` cells wide (ANSI-aware), so the panel height matches the rows sliced. */
export function wrapLines(lines: OutputLine[], width: number): OutputRow[] {
  const columns = Math.max(1, width);
  return lines.flatMap((line) => wrapAnsi(line.text, columns, { hard: true, trim: false })
    .split('\n')
    .map((row) => ({ ...line, row })));
}

export type ArrowTarget = 'picker' | 'history' | 'suggestions' | 'scroll';

/**
 * Where ↑/↓ go. Terminals turn the mouse wheel into ↑/↓ in the alternate screen, so an
 * empty prompt scrolls the results; history stays on ↑/↓ while browsing, on a line without
 * suggestions, and before any output (shell habit). Ctrl+P/Ctrl+N always browse history.
 */
export function resolveArrowTarget(state: {
  commandLine: string;
  historyIndex: number | null;
  hasSuggestions: boolean;
  hasOutput: boolean;
  isSearchMode: boolean;
  isPickerOpen: boolean;
}): ArrowTarget {
  if (state.isPickerOpen) return 'picker';
  if (state.isSearchMode) return 'scroll';
  if (state.historyIndex !== null) return 'history';
  if (state.hasSuggestions) return 'suggestions';
  if (state.commandLine.length > 0 || !state.hasOutput) return 'history';
  return 'scroll';
}

/** Scroll position meaning "stick to the last row", kept across resizes and footer changes. */
const FOLLOW_TAIL = Number.MAX_SAFE_INTEGER;

/** Next scroll position for a navigation key, or `undefined` when the key does not scroll. */
export function nextScrollTop(
  key: { pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean; upArrow?: boolean; downArrow?: boolean },
  scrollTop: number,
  pageSize: number,
  maxScrollTop: number,
): number | undefined {
  const top = Math.min(scrollTop, maxScrollTop);
  let next: number | undefined;
  if (key.pageUp) next = top - pageSize;
  else if (key.pageDown) next = top + pageSize;
  else if (key.home) next = 0;
  else if (key.end) next = FOLLOW_TAIL;
  else if (key.upArrow) next = top - 1;
  else if (key.downArrow) next = top + 1;
  if (next === undefined) return undefined;
  return next >= maxScrollTop ? FOLLOW_TAIL : Math.max(0, next);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function copyToClipboard(rawText: string): boolean {
  const text = rawText.endsWith('\n') ? rawText : `${rawText}\n`;
  const windowsRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
  const fixedPathEnv = {
    ...process.env,
    PATH:
      process.platform === 'win32'
        ? windowsRoot + String.raw`\System32`
        : '/usr/bin:/bin',
  };

  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/pbcopy', [], { input: text, env: fixedPathEnv });
    return result.status === 0;
  }

  if (process.platform === 'win32') {
    const clipPath = String.raw`${windowsRoot}\System32\clip.exe`;
    const result = spawnSync(clipPath, [], { input: text, env: fixedPathEnv });
    return result.status === 0;
  }

  const wl = spawnSync('/usr/bin/wl-copy', [], { input: text, env: fixedPathEnv });
  if (wl.status === 0) return true;

  const xclip = spawnSync('/usr/bin/xclip', ['-selection', 'clipboard'], { input: text, env: fixedPathEnv });
  if (xclip.status === 0) return true;

  const xsel = spawnSync('/usr/bin/xsel', ['--clipboard', '--input'], { input: text, env: fixedPathEnv });
  return xsel.status === 0;
}

function handleNavigationKey(
  key: Parameters<typeof nextScrollTop>[0],
  panelHeight: number,
  maxScrollTop: number,
  setScrollTop: React.Dispatch<React.SetStateAction<number>>,
): boolean {
  if (nextScrollTop(key, 0, panelHeight, maxScrollTop) === undefined) {
    return false;
  }
  // Updater form: a wheel burst delivers several arrows before the next render.
  setScrollTop(previous => nextScrollTop(key, previous, panelHeight, maxScrollTop) ?? previous);
  return true;
}

/** Copy raw output lines (never the rendered markers or highlights) and report it. */
function copyLinesWithNotice(
  lines: readonly OutputLine[],
  what: string,
  setNotice: React.Dispatch<React.SetStateAction<string>>,
): void {
  const copied = copyToClipboard(lines.map((line) => line.text).join('\n'));
  setNotice(copied ? `Copied ${what} to clipboard` : 'Clipboard copy failed');
}

/** Ctrl+Y copies the whole output; Ctrl+L no longer copies (cursor line = `y` in results focus). */
function handleClipboardInput(
  input: string,
  key: { ctrl?: boolean },
  copyLines: OutputLine[],
  setNotice: React.Dispatch<React.SetStateAction<string>>,
): boolean {
  if (!(key.ctrl && input === 'y')) return false;
  copyLinesWithNotice(copyLines, 'full output', setNotice);
  return true;
}

function getPromptGlyph(isSearchMode: boolean, isRunning: boolean, isFocused: boolean): string {
  if (isSearchMode) {
    return '🔎';
  }
  if (isFocused) {
    return '»';
  }
  if (isRunning) {
    return '⏳';
  }
  return '❯';
}

interface SearchInputContext {
  isSearchMode: boolean;
  searchFilter: boolean;
  searchQuery: string;
  setIsSearchMode: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setSearchFilter: React.Dispatch<React.SetStateAction<boolean>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  enterFocus: () => void;
  jumpToMatch: (direction: 1 | -1) => void;
}

/** Enter keeps the search: a filter stays applied, highlights move to results focus for `n`/`N`. */
function leaveSearchMode(ctx: SearchInputContext): void {
  ctx.setIsSearchMode(false);
  if (ctx.searchFilter || ctx.searchQuery.trim().length === 0) {
    ctx.setNotice('Search filter applied');
    return;
  }
  ctx.enterFocus();
  ctx.setNotice('Search kept: n/N next/previous match · Esc back to prompt');
}

/** Search mode: type to highlight (or filter, Tab toggles), Ctrl+N/Ctrl+P jump, Enter keeps, Esc clears. */
function handleSearchModeInputEvent(
  input: string,
  key: {
    return?: boolean;
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    tab?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  },
  ctx: SearchInputContext,
): boolean {
  if (!ctx.isSearchMode) {
    return false;
  }

  if (key.return) {
    leaveSearchMode(ctx);
    return true;
  }

  if (key.escape) {
    ctx.setIsSearchMode(false);
    ctx.setSearchQuery('');
    ctx.setNotice('Search cleared');
    return true;
  }

  if (key.tab) {
    ctx.setSearchFilter(!ctx.searchFilter);
    ctx.setNotice(ctx.searchFilter ? 'Search highlights matches' : 'Search filters lines');
    return true;
  }

  if (key.ctrl && (input === 'n' || input === 'p')) {
    ctx.jumpToMatch(input === 'n' ? 1 : -1);
    return true;
  }

  if (key.backspace || key.delete) {
    ctx.setSearchQuery((previous) => previous.slice(0, -1));
    return true;
  }

  if (!key.ctrl && !key.meta && input.length > 0) {
    ctx.setSearchQuery((previous) => previous + input);
    return true;
  }

  return false;
}

function handleSlashSuggestionsInputEvent(
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    tab?: boolean;
  },
  hasSlashSuggestions: boolean,
  slashSuggestions: SlashCommandEntry[],
  boundedSelectedCommandIndex: number,
  setSelectedCommandIndex: React.Dispatch<React.SetStateAction<number>>,
  setCommandLine: React.Dispatch<React.SetStateAction<string>>,
  setNotice: React.Dispatch<React.SetStateAction<string>>,
): boolean {
  if (!hasSlashSuggestions) {
    return false;
  }

  if (key.upArrow) {
    setSelectedCommandIndex((previous) => {
      const normalizedPrevious = ((previous % slashSuggestions.length) + slashSuggestions.length) % slashSuggestions.length;
      if (normalizedPrevious <= 0) return slashSuggestions.length - 1;
      return normalizedPrevious - 1;
    });
    return true;
  }

  if (key.downArrow) {
    setSelectedCommandIndex((previous) => {
      const normalizedPrevious = ((previous % slashSuggestions.length) + slashSuggestions.length) % slashSuggestions.length;
      return (normalizedPrevious + 1) % slashSuggestions.length;
    });
    return true;
  }

  if (key.tab) {
    const selected = slashSuggestions[boundedSelectedCommandIndex] ?? slashSuggestions[0];
    if (selected) {
      setCommandLine((previous) => buildCommandLineFromSelection(previous, selected));
      setSelectedCommandIndex(0);
      setNotice(selected.isArgument
        ? `Argument selected: ${selected.insertText ?? selected.command}`
        : `Command selected: ${selected.command}`);
    }
    return true;
  }

  return false;
}

function dispatchGlobalInputEvent(
  input: string,
  key: {
    ctrl?: boolean;
  },
  exit: () => void,
  setIsSearchMode: React.Dispatch<React.SetStateAction<boolean>>,
  setNotice: React.Dispatch<React.SetStateAction<string>>,
  handlers: Array<() => boolean>,
): boolean {
  if (key.ctrl && input === 'c') {
    exit();
    return true;
  }

  if (key.ctrl && input === 'f') {
    setIsSearchMode(true);
    setNotice('Search: type to highlight · Ctrl+N/Ctrl+P next/previous · Tab filter · Enter keep · Esc clear');
    return true;
  }

  for (const handler of handlers) {
    if (handler()) {
      return true;
    }
  }

  return false;
}

interface PickerInputKey {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

interface PickerInputContext {
  pickerMode: PickerMode;
  pickerTarget: PickerTarget | null;
  pickerEntries: PickerEntry[];
  pickerIndex: number;
  pickerDir: string;
  setPickerMode: React.Dispatch<React.SetStateAction<PickerMode>>;
  setPickerTarget: React.Dispatch<React.SetStateAction<PickerTarget | null>>;
  setPickerDir: React.Dispatch<React.SetStateAction<string>>;
  setPickerIndex: React.Dispatch<React.SetStateAction<number>>;
  setCommandLine: React.Dispatch<React.SetStateAction<string>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  runCommand: (cmd: string) => void;
}

function closePicker(ctx: PickerInputContext): void {
  ctx.setPickerMode('none');
  ctx.setPickerTarget(null);
}

function handlePickerBackspaceKey(key: PickerInputKey, ctx: PickerInputContext): boolean {
  if (!(key.backspace || key.delete)) return false;
  if (ctx.pickerDir) {
    const parent = ctx.pickerDir.includes('/')
      ? ctx.pickerDir.slice(0, ctx.pickerDir.lastIndexOf('/'))
      : '';
    ctx.setPickerDir(parent);
    ctx.setPickerIndex(0);
  }
  return true;
}

function handlePickerEnterKey(ctx: PickerInputContext): void {
  const entry = ctx.pickerEntries[ctx.pickerIndex];
  const targetCommand = ctx.pickerTarget?.command ?? (ctx.pickerMode === 'path' ? '/scope' : '/file');
  if (!entry) {
    if (ctx.pickerMode === 'path') {
      ctx.runCommand(`${targetCommand} ${ctx.pickerDir || '.'}`);
      closePicker(ctx);
      ctx.setCommandLine('');
    }
    return;
  }
  if (entry.isDir) {
    ctx.setPickerDir(entry.relPath);
    ctx.setPickerIndex(0);
  } else if (ctx.pickerMode === 'file') {
    const commandLine = ctx.pickerTarget?.baseLine
      ? insertFileArgument(ctx.pickerTarget.baseLine, entry.relPath)
      : `${targetCommand} ${entry.relPath}`;
    ctx.runCommand(commandLine);
    closePicker(ctx);
    ctx.setCommandLine('');
  }
}

function handlePickerInputEvent(
  input: string,
  key: PickerInputKey,
  ctx: PickerInputContext,
): boolean {
  if (ctx.pickerMode === 'none') return false;

  if (key.escape) {
    closePicker(ctx);
    ctx.setNotice('Picker cancelled');
    return true;
  }
  if (key.upArrow) {
    ctx.setPickerIndex((p) => Math.max(0, p - 1));
    return true;
  }
  if (key.downArrow) {
    ctx.setPickerIndex((p) => Math.min(ctx.pickerEntries.length - 1, p + 1));
    return true;
  }
  if (handlePickerBackspaceKey(key, ctx)) return true;
  if (input === ' ' && ctx.pickerMode === 'path') {
    const targetCommand = ctx.pickerTarget?.command ?? '/scope';
    ctx.runCommand(`${targetCommand} ${ctx.pickerDir || '.'}`);
    closePicker(ctx);
    ctx.setCommandLine('');
    return true;
  }
  if (key.return) { handlePickerEnterKey(ctx); return true; }
  return false;
}


interface CommandInputContext {
  isRunning: boolean;
  commandLine: string;
  displayLastFile: string;
  selectedSlashSuggestion: SlashCommandEntry | undefined;
  runCommand: (trimmed: string) => void;
  onActivatePicker: (mode: 'path' | 'file', target?: PickerTarget) => void;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setCommandLine: React.Dispatch<React.SetStateAction<string>>;
  setSelectedCommandIndex: React.Dispatch<React.SetStateAction<number>>;
}

function tryExecuteSelectedArgumentSuggestion(
  commandLine: string,
  selectedSlashSuggestion: SlashCommandEntry | undefined,
  runCommand: (trimmed: string) => void,
): boolean {
  if (!selectedSlashSuggestion?.isArgument || !selectedSlashSuggestion.autoExecute) {
    return false;
  }

  const completedLine = buildCommandLineFromSelection(commandLine, selectedSlashSuggestion).trim();
  if (isScopeCommand(getFirstToken(completedLine)) || completedLine.startsWith('/file ')) {
    runCommand(completedLine);
    return true;
  }

  const firstToken = getFirstToken(completedLine);
  if (firstToken === '/format' || FILE_ARGUMENT_COMMANDS.has(firstToken) || SYMBOL_ARGUMENT_COMMANDS.has(firstToken)) {
    runCommand(completedLine);
    return true;
  }

  return false;
}

function handleCommandSelectionBranch(
  selectedCommand: string,
  needsArgs: boolean,
  displayLastFile: string,
  runCommand: (trimmed: string) => void,
  setCommandLine: React.Dispatch<React.SetStateAction<string>>,
  setNotice: React.Dispatch<React.SetStateAction<string>>,
  onActivatePicker: (mode: 'path' | 'file', target?: PickerTarget) => void,
): void {
  if (!needsArgs) {
    runCommand(selectedCommand);
    return;
  }

  if (isScopeCommand(selectedCommand)) {
    onActivatePicker('path', { command: selectedCommand });
  } else if (FILE_ARGUMENT_COMMANDS.has(selectedCommand) && !keepsFileOnCommandLine(selectedCommand, displayLastFile)) {
    onActivatePicker('file', { command: selectedCommand, startFile: displayLastFile });
  } else {
    setCommandLine(buildPrefilledCommandLine(selectedCommand, displayLastFile));
    setNotice(`Command selected: ${selectedCommand}`);
  }
}

function tryHandleSelectedCommandEnter(
  trimmed: string,
  selectedSlashSuggestion: SlashCommandEntry | undefined,
  runCommand: (trimmed: string) => void,
  setCommandLine: React.Dispatch<React.SetStateAction<string>>,
  setNotice: React.Dispatch<React.SetStateAction<string>>,
  displayLastFile: string,
  onActivatePicker: (mode: 'path' | 'file', target?: PickerTarget) => void,
): boolean {
  const selectedCommand = selectedSlashSuggestion?.targetCommand;
  if (!selectedCommand || !trimmed.startsWith('/')) {
    return false;
  }

  const firstToken = trimmed.split(/\s+/, 1)[0];
  const hasArguments = trimmed.length > firstToken.length;
  const needsArgs = COMMANDS_REQUIRING_ARGS.has(selectedCommand);

  if (firstToken !== selectedCommand || (!hasArguments && needsArgs)) {
    handleCommandSelectionBranch(
      selectedCommand,
      needsArgs,
      displayLastFile,
      runCommand,
      setCommandLine,
      setNotice,
      onActivatePicker,
    );
    return true;
  }

  return false;
}

interface HistoryInputContext {
  arrowTarget: ArrowTarget;
  commandHistory: string[];
  historyIndex: number | null;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setCommandLine: React.Dispatch<React.SetStateAction<string>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
}

/** Ctrl+P/Ctrl+N always browse history; Up/Down only when `resolveArrowTarget` routes them here. */
function handleHistoryInputEvent(
  input: string,
  key: { ctrl?: boolean; upArrow?: boolean; downArrow?: boolean },
  ctx: HistoryInputContext,
): boolean {
  const browsing = ctx.arrowTarget === 'history';
  let direction: 'older' | 'newer' | undefined;
  if ((key.ctrl && input === 'p') || (key.upArrow && browsing)) direction = 'older';
  if ((key.ctrl && input === 'n') || (key.downArrow && browsing)) direction = 'newer';
  if (!direction) return false;

  const step = stepHistory(ctx.commandHistory, ctx.historyIndex, direction);
  if (step) {
    ctx.setHistoryIndex(step.index);
    ctx.setCommandLine(step.line);
    ctx.setNotice(step.index === null ? 'History cleared' : `History ${step.index + 1}/${ctx.commandHistory.length}`);
  }
  return true;
}

interface EscapeInputContext {
  hasSlashSuggestions: boolean;
  searchQuery: string;
  setCommandLine: React.Dispatch<React.SetStateAction<string>>;
  setSelectedCommandIndex: React.Dispatch<React.SetStateAction<number>>;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
}

/** Esc outside search mode: close the slash palette first, else remove an applied filter. */
function handleEscapeInputEvent(key: { escape?: boolean }, ctx: EscapeInputContext): boolean {
  if (!key.escape) return false;
  if (ctx.hasSlashSuggestions) {
    ctx.setCommandLine('');
    ctx.setSelectedCommandIndex(0);
    ctx.setHistoryIndex(null);
    ctx.setNotice('Command cleared');
    return true;
  }
  if (ctx.searchQuery.length > 0) {
    ctx.setSearchQuery('');
    ctx.setNotice('Search cleared');
    return true;
  }
  return false;
}

interface FocusKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  ctrl?: boolean;
}

type FocusCommand = 'leave' | 'command' | 'copyLine' | 'copyBlock' | 'copyAll' | 'toggleFold' | 'fold' | 'unfold'
  | 'toggleAll' | 'actions' | 'nextMatch' | 'previousMatch';

const FOCUS_KEY_MOVES: ReadonlyArray<[keyof FocusKey, FocusMove]> = [
  ['upArrow', 'up'], ['downArrow', 'down'], ['pageUp', 'pageUp'], ['pageDown', 'pageDown'], ['home', 'top'], ['end', 'bottom'],
];
const FOCUS_INPUT_MOVES = new Map<string, FocusMove>([
  ['k', 'up'], ['j', 'down'], ['g', 'top'], ['G', 'bottom'], ['[', 'prevBlock'], [']', 'nextBlock'],
]);
const FOCUS_CTRL_MOVES = new Map<string, FocusMove>([['u', 'halfUp'], ['d', 'halfDown']]);
const FOCUS_KEY_COMMANDS: ReadonlyArray<[keyof FocusKey, FocusCommand]> = [
  ['escape', 'leave'], ['return', 'actions'], ['leftArrow', 'fold'], ['rightArrow', 'unfold'],
];
const FOCUS_INPUT_COMMANDS = new Map<string, FocusCommand>([
  ['i', 'leave'], ['/', 'command'], ['y', 'copyLine'], ['Y', 'copyAll'], ['c', 'copyBlock'], [' ', 'toggleFold'],
  ['z', 'toggleAll'], ['Z', 'toggleAll'], ['n', 'nextMatch'], ['N', 'previousMatch'],
]);

export function resolveFocusMove(input: string, key: FocusKey): FocusMove | undefined {
  const flagged = FOCUS_KEY_MOVES.find(([flag]) => key[flag]);
  if (flagged) return flagged[1];
  return (key.ctrl ? FOCUS_CTRL_MOVES : FOCUS_INPUT_MOVES).get(input);
}

export function resolveFocusCommand(input: string, key: FocusKey): FocusCommand | undefined {
  const flagged = FOCUS_KEY_COMMANDS.find(([flag]) => key[flag]);
  if (flagged) return flagged[1];
  if (key.ctrl) return input === 'y' ? 'copyAll' : undefined;
  return FOCUS_INPUT_COMMANDS.get(input);
}

/**
 * Scroll position showing rows `first..last` of the cursor line: `alignTop` puts the first row at
 * the top (block jumps), otherwise the view moves as little as possible.
 */
export function scrollToCursor(
  scrollTop: number,
  first: number,
  last: number,
  pageSize: number,
  maxScrollTop: number,
  alignTop: boolean,
): number {
  const top = Math.min(scrollTop, maxScrollTop);
  let next = top;
  if (alignTop || first < top) next = first;
  else if (last >= top + pageSize) next = last - pageSize + 1;
  return next >= maxScrollTop ? FOLLOW_TAIL : Math.max(0, next);
}

type CursorScroll = 'follow' | 'top';

interface ActionMenu {
  target: ResultTarget;
  actions: ResultAction[];
  index: number;
}

interface ResultsFocusContext {
  isFocused: boolean;
  /** Every raw output line (folded or not). */
  lines: OutputLine[];
  /** What `Y` copies: the filtered lines when a filter is applied. */
  copyLines: OutputLine[];
  visibleLines: OutputLine[];
  cursorIndex: number;
  pageSize: number;
  folded: ReadonlySet<number>;
  blockCount: number;
  workspaceRoot: string;
  allFiles: string[];
  placeCursor: (key: LineKey, scroll: CursorScroll) => void;
  jumpToMatch: (direction: 1 | -1) => void;
  setFoldOverrides: React.Dispatch<React.SetStateAction<ReadonlyMap<number, boolean>>>;
  setIsFocused: React.Dispatch<React.SetStateAction<boolean>>;
  setActionMenu: React.Dispatch<React.SetStateAction<ActionMenu | null>>;
  setCommandLine: React.Dispatch<React.SetStateAction<string>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
}

function setBlockFold(ctx: ResultsFocusContext, line: OutputLine, fold: boolean): void {
  ctx.setFoldOverrides((previous) => new Map(previous).set(line.blockIndex, fold));
  // The title stays the cursor row and in view, whatever the block size becomes.
  ctx.placeCursor({ blockIndex: line.blockIndex, lineIndex: 0 }, 'follow');
}

/** Fold every block, or unfold them all when all are already folded. */
function toggleAllBlocks(ctx: ResultsFocusContext, line: OutputLine): void {
  const fold = ctx.folded.size < ctx.blockCount;
  ctx.setFoldOverrides(new Map(Array.from({ length: ctx.blockCount }, (_, blockIndex) => [blockIndex, fold])));
  ctx.placeCursor({ blockIndex: line.blockIndex, lineIndex: 0 }, 'follow');
  ctx.setNotice(fold ? 'All results folded' : 'All results expanded');
}

function openActionMenu(ctx: ResultsFocusContext, line: OutputLine): void {
  const target = extractResultTarget(line.text, ctx.workspaceRoot, ctx.allFiles);
  if (!target) {
    ctx.setNotice('No file or symbol on line');
    return;
  }
  ctx.setActionMenu({ target, actions: buildResultActions(target), index: 0 });
  ctx.setNotice('Actions: ↑/↓ select · Enter run · Esc close');
}

/** `Esc`/`i` return to the prompt; `/` also starts a command. Works even when a filter hides every line. */
function leaveFocus(startCommand: boolean, ctx: ResultsFocusContext): void {
  ctx.setIsFocused(false);
  if (startCommand) ctx.setCommandLine('/');
  else ctx.setNotice('Back to prompt');
}

function runFocusCommand(command: FocusCommand, line: OutputLine, ctx: ResultsFocusContext): void {
  switch (command) {
    case 'copyLine':
      copyLinesWithNotice([line], 'line', ctx.setNotice);
      break;
    case 'copyBlock':
      // The last line of a block is its blank separator.
      copyLinesWithNotice(ctx.lines.filter((entry) => entry.blockIndex === line.blockIndex).slice(0, -1), 'result', ctx.setNotice);
      break;
    case 'copyAll':
      copyLinesWithNotice(ctx.copyLines, 'full output', ctx.setNotice);
      break;
    case 'toggleFold':
      setBlockFold(ctx, line, !ctx.folded.has(line.blockIndex));
      break;
    case 'fold':
    case 'unfold':
      setBlockFold(ctx, line, command === 'fold');
      break;
    case 'toggleAll':
      toggleAllBlocks(ctx, line);
      break;
    case 'actions':
      openActionMenu(ctx, line);
      break;
    default:
      ctx.jumpToMatch(command === 'nextMatch' ? 1 : -1);
  }
}

/** Results focus: cursor moves, block jumps, folding, copies, actions; swallows every other key. */
function handleResultsFocusInputEvent(input: string, key: FocusKey, ctx: ResultsFocusContext): boolean {
  if (!ctx.isFocused) return false;
  const line = ctx.visibleLines[ctx.cursorIndex];
  const move = resolveFocusMove(input, key);
  if (move && line) {
    const target = ctx.visibleLines[focusTargetIndex(move, ctx.visibleLines, ctx.cursorIndex, ctx.pageSize)];
    ctx.placeCursor(target, move === 'prevBlock' || move === 'nextBlock' ? 'top' : 'follow');
    return true;
  }
  const command = resolveFocusCommand(input, key);
  if (command === 'leave' || command === 'command') leaveFocus(command === 'command', ctx);
  else if (command && line) runFocusCommand(command, line, ctx);
  return true;
}

interface ActionMenuContext {
  actionMenu: ActionMenu | null;
  isRunning: boolean;
  workspaceRoot: string;
  runCommand: (commandLine: string) => void;
  setActionMenu: React.Dispatch<React.SetStateAction<ActionMenu | null>>;
  setIsFocused: React.Dispatch<React.SetStateAction<boolean>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
}

function runResultAction(menu: ActionMenu, ctx: ActionMenuContext): void {
  const action = menu.actions[menu.index];
  ctx.setActionMenu(null);
  if (action.commandLine) {
    ctx.setIsFocused(false);
    ctx.runCommand(action.commandLine);
    return;
  }
  ctx.setNotice('Opening editor…');
  void openInEditor(menu.target, ctx.workspaceRoot).then(ctx.setNotice);
}

/** Action menu on a result row: ↑/↓ select, Enter runs, Esc closes; other keys are ignored while open. */
function handleActionMenuInputEvent(key: FocusKey, ctx: ActionMenuContext): boolean {
  const menu = ctx.actionMenu;
  if (!menu) return false;
  if (key.escape) {
    ctx.setActionMenu(null);
    ctx.setNotice('Actions closed');
  } else if (key.upArrow || key.downArrow) {
    const count = menu.actions.length;
    ctx.setActionMenu({ ...menu, index: (menu.index + (key.upArrow ? count - 1 : 1)) % count });
  } else if (key.return && !ctx.isRunning) {
    runResultAction(menu, ctx);
  }
  return true;
}

/** Esc on an empty prompt (palette and filter already gone) or Shift+Tab moves focus to the results. */
function handleFocusEntryInputEvent(
  key: FocusKey,
  ctx: { commandLine: string; enterFocus: () => void },
): boolean {
  const viaEscape = key.escape && ctx.commandLine.length === 0;
  if (!viaEscape && !(key.tab && key.shift)) return false;
  ctx.enterFocus();
  return true;
}

const PROMPT_HELP_LINES = [
  '↑/↓ PgUp/PgDn wheel scroll · Ctrl+P/Ctrl+N history · Ctrl+Y copy all · Esc/Shift+Tab focus results',
  'Ctrl+F search · Esc clear filter/palette · Tab next step · Ctrl+C quit',
];
const FOCUS_HELP_LINES = [
  '↑↓/jk move · PgUp/PgDn Ctrl+U/D page · g/G ends · [ ] results · Space ←/→ fold · z fold all · Enter actions',
  'y copy line · c copy result · Y copy all · Ctrl+F search · n/N match · Esc/i prompt · / command',
];

/** Header key map of the active mode. */
function getHelpLines(isFocused: boolean): string[] {
  return isFocused ? FOCUS_HELP_LINES : PROMPT_HELP_LINES;
}

/** Cursor position in the visible lines, and the line to highlight when the cursor is shown. */
function resolveCursor(
  cursor: LineKey | null,
  visibleLines: OutputLine[],
  show: boolean,
): { cursorIndex: number; cursorLine: OutputLine | undefined } {
  const cursorIndex = cursor ? cursorIndexOf(visibleLines, cursor) : -1;
  return { cursorIndex, cursorLine: show ? visibleLines[cursorIndex] : undefined };
}

const GREEN = '\u001b[32m';
const INVERSE = '\u001b[7m';
const NO_INVERSE = '\u001b[27m';
const RED = '\u001b[31m';

/** Title row as rendered: green/red status marker, fold arrow and body size; copies keep the raw `$ command`. */
export function decorateTitle(text: string, failed: boolean, folded: boolean, lineCount: number): string {
  const size = `${lineCount} line${lineCount === 1 ? '' : 's'}`;
  return `${failed ? RED : GREEN}●${RESET} ${folded ? '▸' : '▾'} ${text} ${DIM}(${size})${RESET}`;
}

interface LineDecoration {
  /** Search query to highlight; empty when filtering. */
  highlight: string;
  folded: ReadonlySet<number>;
  failed: ReadonlySet<number>;
  counts: ReadonlyMap<number, number>;
}

function decorateLine(line: OutputLine, decoration: LineDecoration): string {
  const text = decoration.highlight ? highlightMatches(line.text, decoration.highlight) : line.text;
  if (line.lineIndex !== 0) return text;
  const { blockIndex } = line;
  return decorateTitle(text, decoration.failed.has(blockIndex), decoration.folded.has(blockIndex), decoration.counts.get(blockIndex) ?? 0);
}

/** `(block 2/5 · lines 12-40 / 87)`, then the filter or the search position. */
function buildResultsSummary(state: {
  rowCount: number;
  firstRow: number;
  shownRows: number;
  block: number | undefined;
  blockCount: number;
  searchQuery: string;
  searchFilter: boolean;
  matchLabel: string;
}): string {
  const blockPart = state.block === undefined ? '' : `block ${state.block + 1}/${state.blockCount} · `;
  const range = state.rowCount === 0
    ? ''
    : ` ${DIM}(${blockPart}lines ${state.firstRow + 1}-${state.firstRow + state.shownRows} / ${state.rowCount})${RESET}`;
  let searchPart = '';
  if (state.searchQuery) {
    searchPart = state.searchFilter
      ? ` ${SPARK}filter:${RESET} ${state.searchQuery}`
      : ` ${SPARK}search:${RESET} ${state.searchQuery} ${DIM}${state.matchLabel}${RESET}`;
  }
  return `${BOLD}Results${RESET}${range}${searchPart}`;
}

/** `match 3/12` when the cursor is on a match, else the match count. */
function describeMatches(matches: readonly number[], lines: readonly OutputLine[], cursor: LineKey | null): string {
  if (matches.length === 0) return 'no match';
  const position = cursor ? matches.indexOf(lines.findIndex((line) => sameLine(line, cursor))) : -1;
  return position >= 0 ? `match ${position + 1}/${matches.length}` : `${matches.length} matches`;
}

interface CursorActionState {
  cursor: LineKey | null;
  lines: OutputLine[];
  visibleRows: OutputRow[];
  matches: number[];
  folded: ReadonlySet<number>;
  searchQuery: string;
  setCursor: React.Dispatch<React.SetStateAction<LineKey | null>>;
  setCursorScroll: React.Dispatch<React.SetStateAction<CursorScroll | null>>;
  setFoldOverrides: React.Dispatch<React.SetStateAction<ReadonlyMap<number, boolean>>>;
  setIsFocused: React.Dispatch<React.SetStateAction<boolean>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
}

/** Cursor moves shared by the focus, search and action handlers of one render. */
function createCursorActions(state: CursorActionState): {
  placeCursor: (target: LineKey, scroll: CursorScroll) => void;
  jumpToMatch: (direction: 1 | -1, inclusive?: boolean) => void;
  enterFocus: () => void;
} {
  const placeCursor = (target: LineKey, scroll: CursorScroll): void => {
    state.setCursor({ blockIndex: target.blockIndex, lineIndex: target.lineIndex });
    state.setCursorScroll(scroll);
  };

  const jumpToMatch = (direction: 1 | -1, inclusive = false): void => {
    const anchor = state.cursor ?? state.visibleRows[0];
    const from = anchor ? state.lines.findIndex((line) => sameLine(line, anchor)) : -1;
    const position = stepMatch(state.matches, from, direction, inclusive);
    if (position === undefined) {
      state.setNotice(state.searchQuery ? 'No match' : 'No search: Ctrl+F to search');
      return;
    }
    const line = state.lines[state.matches[position]];
    // A match hidden by folding unfolds its block.
    if (state.folded.has(line.blockIndex)) {
      state.setFoldOverrides((previous) => new Map(previous).set(line.blockIndex, false));
    }
    placeCursor(line, 'follow');
    state.setNotice(`Match ${position + 1}/${state.matches.length}`);
  };

  const enterFocus = (): void => {
    const { cursor } = state;
    const anchor = cursor && state.visibleRows.some((row) => sameLine(row, cursor)) ? cursor : state.visibleRows.at(-1);
    if (!anchor) {
      state.setNotice('No results yet');
      return;
    }
    state.setIsFocused(true);
    placeCursor(anchor, 'follow');
    state.setNotice('Results: ↑/↓ j/k move · [ ] results · Space fold · Enter actions · y copy line · Esc/i prompt');
  };

  return { placeCursor, jumpToMatch, enterFocus };
}

/** Search-as-you-type: a filter restarts from the top, highlights move the cursor to the next match. */
function useSearchJump(
  isSearchMode: boolean,
  searchFilter: boolean,
  matches: number[],
  jumpToMatch: (direction: 1 | -1, inclusive?: boolean) => void,
  setScrollTop: React.Dispatch<React.SetStateAction<number>>,
): void {
  useEffect(() => {
    if (!isSearchMode) return;
    if (searchFilter) setScrollTop(0);
    else if (matches.length > 0) jumpToMatch(1, true);
    // Only a new match list or mode moves the cursor; other dependencies would re-jump on every render.
  }, [matches, searchFilter]);
}

/** Scroll once the rows of the new cursor position are laid out (folding may have just changed them). */
function useCursorScroll(args: {
  cursorScroll: CursorScroll | null;
  target: OutputLine | undefined;
  outputRows: OutputRow[];
  pageSize: number;
  maxScrollTop: number;
  setCursorScroll: React.Dispatch<React.SetStateAction<CursorScroll | null>>;
  setScrollTop: React.Dispatch<React.SetStateAction<number>>;
}): void {
  const { cursorScroll, target, outputRows, pageSize, maxScrollTop } = args;
  useEffect(() => {
    if (!cursorScroll) return;
    args.setCursorScroll(null);
    if (!target) return;
    const line: OutputLine = target;
    const first = outputRows.findIndex((row) => sameLine(row, line));
    if (first < 0) return;
    const last = outputRows.findLastIndex((row) => sameLine(row, line));
    args.setScrollTop((previous) => scrollToCursor(previous, first, last, pageSize, maxScrollTop, cursorScroll === 'top'));
  }, [cursorScroll, target, outputRows]);
}

/** Rendered text of a panel row: the cursor row in inverse video, without its own colors (embedded resets would cut it). */
function renderRowText(row: OutputRow, cursorLine: OutputLine | undefined): string {
  if (!cursorLine || !sameLine(row, cursorLine)) return row.row || ' ';
  return `${INVERSE}${stripVTControlCharacters(row.row) || ' '}${NO_INVERSE}`;
}

function getPromptText(state: { isFocused: boolean; isSearchMode: boolean; isRunning: boolean; searchQuery: string; commandLine: string }): string {
  if (state.isSearchMode) return state.searchQuery;
  if (state.isFocused) return `${DIM}results focus · Esc/i back to prompt · / command${RESET}`;
  return `${state.commandLine}${state.isRunning ? ' …' : ''}`;
}

/** Footer lines of the action menu: its title, then one line per action. */
function buildActionMenuLines(menu: ActionMenu | null): string[] {
  if (!menu) return [];
  const { relativePath, symbol } = menu.target;
  const subject = symbol ? `${relativePath}#${symbol}` : relativePath;
  return [
    `${DIM}Actions for ${subject}: ↑/↓ select · Enter run · Esc close${RESET}`,
    ...menu.actions.map((action, index) => (index === menu.index ? `${SPARK}› ${action.label}${RESET}` : `${DIM}  ${action.label}${RESET}`)),
  ];
}

/** Decoration inputs for the visible lines: highlight only when not filtering, failed blocks, sizes. */
function buildLineDecoration(state: {
  blocks: OutputBlock[];
  lines: OutputLine[];
  folded: ReadonlySet<number>;
  searchQuery: string;
  searchFilter: boolean;
}): LineDecoration {
  const failed = new Set<number>();
  state.blocks.forEach((block, index) => {
    if (/^Error:/m.test(block.body)) failed.add(index);
  });
  return {
    highlight: state.searchFilter ? '' : state.searchQuery,
    folded: state.folded,
    failed,
    counts: countBlockLines(state.lines),
  };
}

function handleCommandInputEvent(
  input: string,
  key: {
    return?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  },
  context: CommandInputContext,
): boolean {
  const {
    isRunning,
    commandLine,
    displayLastFile,
    selectedSlashSuggestion,
    runCommand,
    onActivatePicker,
    setNotice,
    setHistoryIndex,
    setCommandLine,
    setSelectedCommandIndex,
  } = context;

  const handleEnterInput = (): boolean => {
    if (!key.return) {
      return false;
    }
    if (isRunning) return true;

    const trimmed = commandLine.trim();
    if (trimmed.length === 0) {
      setNotice('Empty command');
      return true;
    }

    if (tryExecuteSelectedArgumentSuggestion(commandLine, selectedSlashSuggestion, runCommand)) {
      return true;
    }

    if (isScopeCommand(trimmed) || trimmed === '/file') {
      onActivatePicker(isScopeCommand(trimmed) ? 'path' : 'file', { command: trimmed, startFile: displayLastFile });
      setCommandLine('');
      return true;
    }

    if (tryHandleSelectedCommandEnter(
      trimmed,
      selectedSlashSuggestion,
      runCommand,
      setCommandLine,
      setNotice,
      displayLastFile,
      onActivatePicker,
    )) {
      return true;
    }

    const firstToken = getFirstToken(trimmed);
    if (FILE_ARGUMENT_COMMANDS.has(firstToken) && !lineHasFileArgument(trimmed)) {
      if (keepsFileOnCommandLine(firstToken, displayLastFile)) {
        setCommandLine(`${insertFileArgument(trimmed, displayLastFile)} `);
        setNotice(`Using current file: ${displayLastFile}`);
      } else {
        onActivatePicker('file', { command: firstToken, baseLine: trimmed, startFile: displayLastFile });
        setCommandLine('');
      }
      return true;
    }

    runCommand(trimmed);
    return true;
  };

  if (handleEnterInput()) {
    return true;
  }

  if (key.backspace || key.delete) {
    setCommandLine(previous => previous.slice(0, -1));
    setSelectedCommandIndex(0);
    setHistoryIndex(null);
    return true;
  }

  if (!key.ctrl && !key.meta && input.length > 0) {
    setCommandLine(previous => appendTypedInput(previous, input));
    setSelectedCommandIndex(0);
    setHistoryIndex(null);
    return true;
  }

  return false;
}

export async function runInkReplSession(options: RunInkReplSessionOptions): Promise<void> {
  const ink = await import('ink');
  const Box = ink.Box as unknown as React.ComponentType<Record<string, unknown>>;
  const Text = ink.Text as unknown as React.ComponentType<Record<string, unknown>>;
  const render = ink.render;
  const useApp = ink.useApp;
  const useInput = ink.useInput;
  const useWindowSize = ink.useWindowSize;

  interface PickerPanelProps {
    pickerMode: PickerMode;
    pickerDir: string;
    pickerIndex: number;
    pickerEntries: PickerEntry[];
    visiblePickerEntries: PickerEntry[];
    pickerScrollStart: number;
    panelHeight: number;
    pickerTarget: PickerTarget | null;
  }

  function buildPickerPanelNodes(props: PickerPanelProps): React.ReactElement {
    const {
      pickerMode: pickerModeParam,
      pickerDir,
      pickerIndex,
      pickerEntries,
      visiblePickerEntries,
      pickerScrollStart,
      panelHeight,
      pickerTarget,
    } = props;
    const pickerMode = pickerModeParam;
    const borderColor = pickerMode === 'path' ? 'yellow' : 'green';
    const targetLabel = pickerTarget?.command ? ` for ${pickerTarget.command}` : '';
    const title = pickerMode === 'path'
      ? `${BOLD}📁 Select directory${targetLabel}${RESET} ${DIM}(Enter=enter dir · Space=select current · Backspace=up · Esc=cancel)${RESET}`
      : `${BOLD}📄 Select file${targetLabel}${RESET} ${DIM}(Enter=select/enter dir · Backspace=up · Esc=cancel)${RESET}`;
    const breadcrumb = pickerDir || '.';
    const entryNodes = visiblePickerEntries.map((entry, i) => {
      const absIdx = pickerScrollStart + i;
      const isSelected = absIdx === pickerIndex;
      const icon = entry.isDir ? '📁' : '📄';
      const label = `${entry.name}${entry.isDir ? '/' : ''}`;
      let color: string | undefined;
      if (isSelected) {
        color = pickerMode === 'path' ? 'yellow' : 'green';
      } else if (entry.isDir) {
        color = 'cyan';
      }
      return h(Text, { key: `picker-${entry.relPath}`, color, bold: isSelected, wrap: 'truncate' },
        `${isSelected ? '❯' : ' '} ${icon} ${label}`,
      );
    });
    const emptyNode = h(Text, { key: 'picker-empty', dimColor: true }, '  (empty directory)');
    const countNote = pickerEntries.length > visiblePickerEntries.length
      ? h(Text, { key: 'picker-count', dimColor: true }, `  ${pickerScrollStart + 1}-${pickerScrollStart + visiblePickerEntries.length} / ${pickerEntries.length}`)
      : null;
    return h(
      Box,
      { height: panelHeight, flexDirection: 'column', paddingLeft: 1 },
      h(Text, { key: 'picker-title', color: borderColor, wrap: 'truncate' }, title),
      h(Text, { key: 'picker-breadcrumb', dimColor: true, wrap: 'truncate' }, `  📍 ${breadcrumb}`),
      countNote,
      h(Box, { key: 'picker-entries', flexDirection: 'column', marginTop: 1 },
        ...(entryNodes.length > 0 ? entryNodes : [emptyNode]),
      ),
    );
  }

  function ReplInkApp(): React.ReactElement {
    const { exit } = useApp();
    const { rows, columns } = useWindowSize();
    const [commandLine, setCommandLine] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearchMode, setIsSearchMode] = useState(false);
    const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [blocks, setBlocks] = useState<OutputBlock[]>([]);
    const [scrollTop, setScrollTop] = useState(0);
    const [isFocused, setIsFocused] = useState(false);
    const [cursor, setCursor] = useState<LineKey | null>(null);
    const [cursorScroll, setCursorScroll] = useState<CursorScroll | null>(null);
    const [foldOverrides, setFoldOverrides] = useState<ReadonlyMap<number, boolean>>(new Map());
    const [searchFilter, setSearchFilter] = useState(false);
    const [actionMenu, setActionMenu] = useState<ActionMenu | null>(null);
    const [notice, setNotice] = useState('Ready. Enter a command like /summary or /trace src/index.ts#main');
    const [currentAllFiles, setCurrentAllFiles] = useState(options.allFiles);
    const [displayWorkspace, setDisplayWorkspace] = useState(options.workspaceRoot);
    const currentWorkspaceRef = useRef(options.workspaceRoot);
    const [displayLastFile, setDisplayLastFile] = useState(options.lastFile
      ? path.relative(options.workspaceRoot, options.lastFile)
      : 'none');
    const [displayLastSymbol, setDisplayLastSymbol] = useState(options.lastSymbol ?? 'none');
    const [displayFormat, setDisplayFormat] = useState(options.preferredFormat);
    const [pickerMode, setPickerMode] = useState<PickerMode>('none');
    const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
    const [pickerDir, setPickerDir] = useState('');
    const [pickerIndex, setPickerIndex] = useState(0);
    // ponytail: symbols cached for the whole session, edits made meanwhile show up after a restart.
    const [symbolCache, setSymbolCache] = useState<ReadonlyMap<string, string[]>>(new Map());
    const pendingSymbolFilesRef = useRef(new Set<string>());

    const symbolCompletionFile = useMemo(
      () => findSymbolCompletionFile(commandLine, currentAllFiles, displayWorkspace),
      [commandLine, currentAllFiles, displayWorkspace],
    );
    useEffect(() => {
      const { listFileSymbols } = options;
      if (!symbolCompletionFile || !listFileSymbols || isRunning) return;
      const cacheKey = normalizePath(symbolCompletionFile);
      if (symbolCache.has(cacheKey) || pendingSymbolFilesRef.current.has(cacheKey)) return;
      pendingSymbolFilesRef.current.add(cacheKey);
      void listFileSymbols(symbolCompletionFile)
        .catch(() => [])
        .then((symbols) => {
          setSymbolCache((previous) => new Map(previous).set(cacheKey, symbols));
        })
        .finally(() => {
          pendingSymbolFilesRef.current.delete(cacheKey);
        });
    }, [symbolCompletionFile, symbolCache, isRunning]);

    const lines = useMemo(() => toLines(blocks), [blocks]);
    const slashSuggestions = useMemo(
      () => filterSlashCommands(
        commandLine,
        currentAllFiles,
        displayWorkspace,
        (absoluteFile) => symbolCache.get(normalizePath(absoluteFile)),
      ),
      [commandLine, currentAllFiles, displayWorkspace, symbolCache],
    );
    const boundedSelectedCommandIndex = slashSuggestions.length === 0
      ? 0
      : Math.min(selectedCommandIndex, slashSuggestions.length - 1);
    const hasSlashSuggestions = !isSearchMode && slashSuggestions.length > 0;
    const visibleSlashLimit = hasSlashSuggestions
      ? Math.max(1, Math.min(
        MAX_VISIBLE_SLASH_SUGGESTIONS,
        rows - HEADER_ROWS - MIN_RESULTS_PANEL_ROWS - BASE_FOOTER_ROWS - 3,
      ))
      : 0;
    const visibleSlashStart = useMemo(() => {
      if (visibleSlashLimit <= 0 || slashSuggestions.length <= visibleSlashLimit) {
        return 0;
      }

      const half = Math.floor(visibleSlashLimit / 2);
      const maxStart = slashSuggestions.length - visibleSlashLimit;
      return Math.max(0, Math.min(boundedSelectedCommandIndex - half, maxStart));
    }, [boundedSelectedCommandIndex, slashSuggestions, visibleSlashLimit]);
    const visibleSlashSuggestions = useMemo(
      () => slashSuggestions.slice(visibleSlashStart, visibleSlashStart + visibleSlashLimit),
      [slashSuggestions, visibleSlashStart, visibleSlashLimit],
    );
    const selectedSlashSuggestion = hasSlashSuggestions
      ? (slashSuggestions[boundedSelectedCommandIndex] ?? slashSuggestions[0])
      : undefined;
    const completionPreview = useMemo(
      () => {
        if (selectedSlashSuggestion?.isArgument) {
          if (selectedSlashSuggestion.targetCommand === '/scope' || selectedSlashSuggestion.targetCommand === '/file') {
            return getPathSuggestionPreview(commandLine, selectedSlashSuggestion.insertText ?? selectedSlashSuggestion.command);
          }
          return getArgumentCompletionPreview(commandLine, selectedSlashSuggestion.insertText ?? selectedSlashSuggestion.command);
        }
        return getCompletionPreview(commandLine, selectedSlashSuggestion?.command);
      },
      [commandLine, selectedSlashSuggestion],
    );
    const folded = useMemo(() => foldedBlocks(blocks.length, foldOverrides), [blocks.length, foldOverrides]);
    const matches = useMemo(() => findMatches(lines, searchQuery), [lines, searchQuery]);
    const { visible: visibleLines, copy: filteredLines } = useMemo(
      () => selectPanelLines(lines, folded, matches, searchFilter && searchQuery.trim().length > 0),
      [lines, folded, matches, searchFilter, searchQuery],
    );
    const displayLines = useMemo(() => {
      const decoration = buildLineDecoration({ blocks, lines, folded, searchQuery, searchFilter });
      return visibleLines.map((line) => ({ ...line, text: decorateLine(line, decoration) }));
    }, [visibleLines, searchFilter, searchQuery, folded, blocks, lines]);
    const actionMenuLines = buildActionMenuLines(actionMenu);
    const nextStepHints = useMemo(
      () => (blocks.length > 0 ? getNextStepHints(displayLastFile, displayLastSymbol) : []),
      [blocks.length, displayLastFile, displayLastSymbol],
    );
    const showNextStepHints = !isSearchMode && !isRunning && nextStepHints.length > 0
      && (commandLine.length === 0 || nextStepHints.includes(commandLine));
    const argsHintLine = selectedSlashSuggestion?.argsHint
      ? `${DIM}Args: ${selectedSlashSuggestion.argsHint}${RESET}`
      : undefined;
    const slashWindowIndicator = hasSlashSuggestions && slashSuggestions.length > visibleSlashSuggestions.length;
    const computedFooterRows = BASE_FOOTER_ROWS
      + (showNextStepHints ? 1 : 0)
      + (hasSlashSuggestions ? 1 : 0)
      + (hasSlashSuggestions && completionPreview.length > 0 ? 1 : 0)
      + (argsHintLine ? 1 : 0)
      + (slashWindowIndicator ? 1 : 0)
      + (hasSlashSuggestions ? visibleSlashSuggestions.length : 0)
      + actionMenuLines.length;
    const panelHeight = Math.max(1, rows - HEADER_ROWS - computedFooterRows);
    const panelContentHeight = Math.max(1, panelHeight - 2);
    // Panel content starts after paddingLeft: 1.
    const outputRows = useMemo(() => wrapLines(displayLines, columns - 1), [displayLines, columns]);
    const maxScrollTop = Math.max(0, outputRows.length - panelContentHeight);
    const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
    const visibleRows = outputRows.slice(clampedScrollTop, clampedScrollTop + panelContentHeight);
    const { cursorIndex, cursorLine } = resolveCursor(cursor, visibleLines, isFocused || isSearchMode);
    const arrowTarget = resolveArrowTarget({
      commandLine,
      historyIndex,
      hasSuggestions: hasSlashSuggestions,
      hasOutput: blocks.length > 0,
      isSearchMode,
      isPickerOpen: pickerMode !== 'none',
    });

    const pickerEntries = useMemo(
      () => (pickerMode === 'none' ? [] : buildPickerEntries(currentAllFiles, displayWorkspace, pickerDir)),
      [pickerMode, pickerDir, currentAllFiles, displayWorkspace],
    );
    const pickerVisibleCount = Math.max(1, panelHeight - 4);
    const pickerScrollStart = useMemo(() => {
      if (pickerEntries.length <= pickerVisibleCount) return 0;
      const half = Math.floor(pickerVisibleCount / 2);
      return Math.max(0, Math.min(pickerIndex - half, pickerEntries.length - pickerVisibleCount));
    }, [pickerIndex, pickerEntries.length, pickerVisibleCount]);
    const visiblePickerEntries = useMemo(
      () => pickerEntries.slice(pickerScrollStart, pickerScrollStart + pickerVisibleCount),
      [pickerEntries, pickerScrollStart, pickerVisibleCount],
    );

    const appendBlock = (title: string, body: string): void => {
      setBlocks(previous => [
        ...previous,
        {
          title,
          body,
        },
      ]);
    };

    const onActivatePicker = (mode: 'path' | 'file', target?: PickerTarget): void => {
      setPickerMode(mode);
      setPickerTarget(target ?? { command: mode === 'path' ? '/scope' : '/file' });
      const start = mode === 'file' ? pickerStartPosition(currentAllFiles, displayWorkspace, target?.startFile) : { dir: '', index: 0 };
      setPickerDir(start.dir);
      setPickerIndex(start.index);
      setNotice(mode === 'path'
        ? 'Directory picker: ↑/↓ navigate · Enter=enter dir · Space=select current dir · Backspace=up · Esc=cancel'
        : 'File picker: ↑/↓ navigate · Enter=select file or enter dir · Backspace=up · Esc=cancel');
    };

    const runCommand = (trimmed: string): void => {
      setCommandHistory((previous) => {
        if (previous[0] === trimmed) {
          return previous;
        }
        return [trimmed, ...previous].slice(0, 50);
      });
      setHistoryIndex(null);
      setIsRunning(true);
      void options.onSubmitCommand(trimmed)
        .then(response => {
          const body = response.output ?? '';
          appendBlock(trimmed, body);
          setCommandLine('');
          setScrollTop(FOLLOW_TAIL);
          setNotice(`Executed ${response.command}`);
          // Apply updated context from server-side state changes
          const ctx = response.updatedContext;
          if (ctx) {
            if (ctx.workspaceRoot) {
              currentWorkspaceRef.current = ctx.workspaceRoot;
              setDisplayWorkspace(ctx.workspaceRoot);
            }
            if (ctx.allFiles) {
              setCurrentAllFiles(ctx.allFiles);
            }
            if (ctx.preferredFormat) {
              setDisplayFormat(ctx.preferredFormat);
            }
            if (ctx.lastFile !== undefined) {
              setDisplayLastFile(ctx.lastFile === null
                ? 'none'
                : path.relative(currentWorkspaceRef.current, ctx.lastFile));
            }
            if (ctx.lastSymbol !== undefined) {
              setDisplayLastSymbol(ctx.lastSymbol ?? 'none');
            }
          }
          if (response.shouldQuit) {
            exit();
          }
        })
        .catch((error: unknown) => {
          const message = toErrorMessage(error);
          appendBlock(trimmed, `Error: ${message}`);
          setCommandLine('');
          setScrollTop(FOLLOW_TAIL);
          setNotice('Command failed');
        })
        .finally(() => {
          setIsRunning(false);
        });
    };

    const { placeCursor, jumpToMatch, enterFocus } = createCursorActions({
      cursor,
      lines,
      visibleRows,
      matches,
      folded,
      searchQuery,
      setCursor,
      setCursorScroll,
      setFoldOverrides,
      setIsFocused,
      setNotice,
    });
    useSearchJump(isSearchMode, searchFilter, matches, jumpToMatch, setScrollTop);
    useCursorScroll({
      cursorScroll,
      target: visibleLines[cursorIndex],
      outputRows,
      pageSize: panelContentHeight,
      maxScrollTop,
      setCursorScroll,
      setScrollTop,
    });

    useInput((input, key) => {
      if (pickerMode !== 'none') {
        handlePickerInputEvent(input, key, {
          pickerMode,
          pickerTarget,
          pickerEntries,
          pickerIndex,
          pickerDir,
          setPickerMode,
          setPickerTarget,
          setPickerDir,
          setPickerIndex,
          setCommandLine,
          setNotice,
          runCommand,
        });
        return;
      }
      if (dispatchGlobalInputEvent(input, key, exit, setIsSearchMode, setNotice, [
        () => handleActionMenuInputEvent(key, {
          actionMenu,
          isRunning,
          workspaceRoot: displayWorkspace,
          runCommand,
          setActionMenu,
          setIsFocused,
          setNotice,
        }),
        () => handleSearchModeInputEvent(input, key, {
          isSearchMode,
          searchFilter,
          searchQuery,
          setIsSearchMode,
          setSearchQuery,
          setSearchFilter,
          setNotice,
          enterFocus,
          jumpToMatch,
        }),
        () => handleResultsFocusInputEvent(input, key, {
          isFocused,
          lines,
          copyLines: filteredLines,
          visibleLines,
          cursorIndex,
          pageSize: panelContentHeight,
          folded,
          blockCount: blocks.length,
          workspaceRoot: displayWorkspace,
          allFiles: currentAllFiles,
          placeCursor,
          jumpToMatch,
          setFoldOverrides,
          setIsFocused,
          setActionMenu,
          setCommandLine,
          setNotice,
        }),
        () => handleEscapeInputEvent(key, {
          hasSlashSuggestions,
          searchQuery,
          setCommandLine,
          setSelectedCommandIndex,
          setHistoryIndex,
          setSearchQuery,
          setNotice,
        }),
        () => handleFocusEntryInputEvent(key, { commandLine, enterFocus }),
        () => handleHistoryInputEvent(input, key, {
          arrowTarget,
          commandHistory,
          historyIndex,
          setHistoryIndex,
          setCommandLine,
          setNotice,
        }),
        () => {
          const hint = key.tab && showNextStepHints ? cycleNextStepHint(nextStepHints, commandLine) : undefined;
          if (hint === undefined) return false;
          setCommandLine(hint);
          setHistoryIndex(null);
          setNotice('Next step selected: Enter to run, Tab for the next one');
          return true;
        },
        () => handleSlashSuggestionsInputEvent(
          key,
          hasSlashSuggestions,
          slashSuggestions,
          boundedSelectedCommandIndex,
          setSelectedCommandIndex,
          setCommandLine,
          setNotice,
        ),
        () => handleNavigationKey(key, panelContentHeight, maxScrollTop, setScrollTop),
        () => handleClipboardInput(input, key, filteredLines, setNotice),
        () => handleCommandInputEvent(
          input,
          key,
          {
            isRunning,
            commandLine,
            displayLastFile,
            selectedSlashSuggestion,
            runCommand,
            onActivatePicker,
            setNotice,
            setHistoryIndex,
            setCommandLine,
            setSelectedCommandIndex,
          },
        ),
      ])) {
        return;
      }
    });

    function buildMainPanel(): React.ReactElement {
      if (pickerMode !== 'none') {
        return buildPickerPanelNodes({
          pickerMode,
          pickerDir,
          pickerIndex,
          pickerEntries,
          visiblePickerEntries,
          pickerScrollStart,
          panelHeight,
          pickerTarget,
        });
      }

      // Rows already fit the panel width; ' ' keeps an empty row one row tall.
      const resultNodes = visibleRows.length > 0
        ? visibleRows.map((row, index) => h(Text, { key: `row-${clampedScrollTop + index}`, wrap: 'truncate' }, renderRowText(row, cursorLine)))
        : [h(Text, { dimColor: true, key: 'empty' }, 'No results yet')];
      const resultsSummary = buildResultsSummary({
        rowCount: outputRows.length,
        firstRow: clampedScrollTop,
        shownRows: visibleRows.length,
        block: (cursorLine ?? visibleRows[0])?.blockIndex,
        blockCount: blocks.length,
        searchQuery,
        searchFilter,
        matchLabel: describeMatches(matches, lines, cursor),
      });

      return h(
        Box,
        { height: panelHeight, flexDirection: 'column', paddingLeft: 1 },
        h(Text, { color: 'cyan', wrap: 'truncate' }, resultsSummary),
        h(Box, { flexDirection: 'column', marginTop: 1 }, ...resultNodes),
      );
    }

    const promptText = getPromptText({ isFocused, isSearchMode, isRunning, searchQuery, commandLine });

    function buildFooterItems(): React.ReactElement[] {
      const footerItems: React.ReactElement[] = [
        h(Text, { wrap: 'truncate' }, `${DIM}${notice}${RESET}`),
        // The glyph stays outside the truncated text, so a long command keeps its prompt marker.
        h(Box, {}, h(Box, { marginRight: 1, flexShrink: 0 }, h(Text, {}, getPromptGlyph(isSearchMode, isRunning, isFocused))), h(Text, { wrap: 'truncate-start' }, promptText)),
      ];

      footerItems.push(...actionMenuLines.map((line, index) => h(Text, { key: `action-${index}`, wrap: 'truncate' }, line)));

      if (showNextStepHints) {
        const hintLabels = nextStepHints.map((hint) => (hint === commandLine ? `${SPARK}${hint}${RESET}${DIM}` : hint));
        footerItems.push(
          h(Text, { key: 'next-step', wrap: 'truncate' }, `${DIM}→ ${hintLabels.join(' · ')}  (Tab)${RESET}`),
        );
      }

      if (hasSlashSuggestions) {
        footerItems.push(
          h(Text, { key: 'slash-help', wrap: 'truncate' }, `${DIM}Suggestions ${boundedSelectedCommandIndex + 1}/${slashSuggestions.length}: ↑/↓ select · Tab complete · Enter apply/run · type space for files/options${RESET}`),
        );
        if (completionPreview.length > 0) {
          footerItems.push(
            h(Text, { key: 'slash-completion', wrap: 'truncate' }, `${DIM}Completion: ${isSearchMode ? searchQuery : commandLine}${completionPreview}${RESET}`),
          );
        }
        if (argsHintLine) {
          footerItems.push(h(Text, { key: 'slash-args', wrap: 'truncate' }, argsHintLine));
        }
        if (slashWindowIndicator) {
          footerItems.push(
            h(Text, { key: 'slash-window', wrap: 'truncate' }, `${DIM}Showing ${visibleSlashStart + 1}-${visibleSlashStart + visibleSlashSuggestions.length}${RESET}`),
          );
        }
        const suggestionNodes = visibleSlashSuggestions.map((entry, index) => {
          const absoluteIndex = visibleSlashStart + index;
          const isSelected = absoluteIndex === boundedSelectedCommandIndex;
          const prefix = isSelected ? '›' : ' ';
          const color = isSelected ? SPARK : DIM;
          const group = entry.group ? ` ${DIM}· ${entry.group}${RESET}` : '';
          return h(
            Text,
            { key: `slash-${absoluteIndex}-${entry.command}`, wrap: 'truncate' },
            `${color}${prefix} ${entry.command.padEnd(20)}${RESET} ${entry.description}${group}`,
          );
        });
        footerItems.push(...suggestionNodes);
      }

      return footerItems;
    }

    const helpLines = getHelpLines(isFocused);

    return h(
      Box,
      { flexDirection: 'column', height: rows },
      h(
        Box,
        { flexDirection: 'column', marginBottom: 1 },
        h(Text, { wrap: 'truncate' }, `${BLUE}●${RESET}${DIM}─${RESET}${BLUE}■${RESET}   ${BOLD}Graph-It-Live${RESET} ${DIM}v${options.version}${RESET} ${SPARK}✦${RESET}`),
        h(Text, { wrap: 'truncate' }, `${BLUE}│${RESET} ${DIM}╲${RESET}   ${DIM}${helpLines[0]}${RESET}`),
        h(Text, { wrap: 'truncate' }, `${BLUE}●${RESET}${DIM}─${RESET}${ORANGE}■${RESET}   ${DIM}${helpLines[1]}${RESET}`),
      ),
      h(
        Box,
        { marginBottom: 1 },
        h(Text, { wrap: 'truncate' }, `${DIM}workspace:${RESET} ${displayWorkspace}  ${DIM}format:${RESET} ${displayFormat}  ${DIM}last file:${RESET} ${displayLastFile}  ${DIM}last symbol:${RESET} ${displayLastSymbol}`),
      ),
      buildMainPanel(),
      h(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        ...buildFooterItems(),
      ),
    );
  }

  const instance = render(h(ReplInkApp), { alternateScreen: true, ...options.renderOptions });
  await instance.waitUntilExit();
}
