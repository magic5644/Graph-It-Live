import React, { useMemo, useState, useRef } from 'react';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizePath } from '../../../shared/path';

const h = React.createElement;

export interface InkReplCommandResponse {
  command: string;
  output?: string;
  shouldQuit?: boolean;
  /** Updated REPL context to reflect session state changes (workspace, file, etc.) */
  updatedContext?: {
    workspaceRoot?: string;
    allFiles?: string[];
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
}

interface OutputBlock {
  title: string;
  body: string;
}

interface SlashCommandEntry {
  command: string;
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
  { command: '/trace', description: 'Trace symbol or explain file', argsHint: '/trace <file#Symbol> [--maxDepth N]' },
  { command: '/path', description: 'Set workspace scope', argsHint: '/path <directory>' },
  { command: '/path-in', description: 'Show incoming path', argsHint: '/path-in <file>' },
  { command: '/path-out', description: 'Show outgoing path', argsHint: '/path-out <file>' },
  { command: '/file', description: 'Set active file context', argsHint: '/file <path>' },
  { command: '/check-dependencies', description: 'Analyze incoming/outgoing deps', argsHint: '/check-dependencies <file> [--incoming|--outgoing|--both]' },
  { command: '/deps', description: 'Alias of check-dependencies', argsHint: '/deps <file>' },
  { command: '/dependencies', description: 'Alias of check-dependencies', argsHint: '/dependencies <file>' },
  { command: '/deps-in', description: 'Incoming dependencies alias', argsHint: '/deps-in <file>' },
  { command: '/deps-out', description: 'Outgoing dependencies alias', argsHint: '/deps-out <file>' },
  { command: '/cycles', description: 'Detect dependency cycles', argsHint: '/cycles <file>' },
  { command: '/cycle', description: 'Alias of cycles', argsHint: '/cycle <file>' },
  { command: '/summary', description: 'Summarize workspace or file' },
  { command: '/architecture', description: 'Build workspace graph', argsHint: '/architecture [--maxFiles N]' },
  { command: '/check', description: 'Find dead code' },
  { command: '/scan', description: 'Force indexing scan' },
  { command: '/query', description: 'Query the codebase with natural language', argsHint: '/query "<question>" [--depth N] [--token-budget N]' },
  { command: '/wiki', description: 'Generate a markdown wiki from the call graph', argsHint: '/wiki [--output <dir>] [--top N] [--format markdown|json|toon]' },
  { command: '/command', description: 'Run raw command line', argsHint: '/command <graph-it command...>' },
  { command: '/format', description: 'Set default output format', argsHint: '/format <text|json|toon|markdown|mermaid>' },
  { command: '/help', description: 'Show REPL help' },
  { command: '/quit', description: 'Exit REPL' },
];

const COMMANDS_REQUIRING_ARGS = new Set([
  '/trace',
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
  '/command',
  '/format',
]);

const FILE_ARGUMENT_COMMANDS = new Set([
  '/trace',
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
  '/deps': [
    { value: '--incoming', description: 'Show incoming references' },
    { value: '--outgoing', description: 'Show outgoing dependencies' },
    { value: '--both', description: 'Show incoming and outgoing' },
  ],
  '/dependencies': [
    { value: '--incoming', description: 'Show incoming references' },
    { value: '--outgoing', description: 'Show outgoing dependencies' },
    { value: '--both', description: 'Show incoming and outgoing' },
  ],
  '/deps-in': [
    { value: '--incoming', description: 'Show incoming references' },
  ],
  '/deps-out': [
    { value: '--outgoing', description: 'Show outgoing dependencies' },
  ],
  '/architecture': [
    { value: '--maxFiles', description: 'Limit analyzed files' },
  ],
  '/format': [
    { value: 'text', description: 'Plain text output' },
    { value: 'json', description: 'JSON output' },
    { value: 'toon', description: 'TOON output' },
    { value: 'markdown', description: 'Markdown output' },
    { value: 'mermaid', description: 'Mermaid output' },
  ],
};

function toWorkspaceRelativePath(absolutePath: string, workspaceRoot: string): string {
  return normalizePath(path.relative(workspaceRoot, absolutePath));
}

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

  return entries.filter((entry) => {
    const lower = entry.toLowerCase();
    return lower.startsWith(normalizedQuery) || lower.includes(normalizedQuery);
  });
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

  if (command === '/path') {
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

function buildArgumentSuggestions(
  activeCommand: string,
  currentArgToken: string,
  query: string,
  allFiles: string[],
  workspaceRoot: string,
): SlashCommandEntry[] {
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

  if (activeCommand === '/path') {
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

function filterSlashCommands(
  input: string,
  allFiles: string[],
  workspaceRoot: string,
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
    const activeCommand = commandEntries.find((entry) => entry.command === queryToken)?.command;
    if (!activeCommand) {
      return commandMatches;
    }

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const currentArgToken = hasTrailingSpace ? '' : (tokens.at(-1) ?? '');
    const argumentQuery = trimmed.slice(queryToken.length);

    return buildArgumentSuggestions(activeCommand, currentArgToken, argumentQuery, allFiles, workspaceRoot);
  }

  return commandEntries
    .filter((entry) =>
      entry.command.startsWith(queryToken) ||
      entry.description.toLowerCase().includes(query.slice(1)),
    );
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
  if (firstToken !== '/path' && !FILE_ARGUMENT_COMMANDS.has(firstToken)) {
    return '';
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const currentPathToken = tokens.length > 1 ? (tokens.at(-1) ?? '') : '';
  if (currentPathToken.length === 0 || !selectedPath.startsWith(currentPathToken)) {
    return '';
  }

  return selectedPath.slice(currentPathToken.length);
}

function toLines(blocks: OutputBlock[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(`$ ${block.title}`);
    if (block.body.length === 0) {
      lines.push('(no output)', '');
      continue;
    }

    lines.push(...block.body.replaceAll('\r\n', '\n').split('\n'), '');
  }

  return lines;
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

  if (process.platform === 'darwin') {
    const result = spawnSync('pbcopy', [], { input: text });
    return result.status === 0;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('clip', [], { input: text, shell: true });
    return result.status === 0;
  }

  const wl = spawnSync('wl-copy', [], { input: text });
  if (wl.status === 0) return true;

  const xclip = spawnSync('xclip', ['-selection', 'clipboard'], { input: text });
  if (xclip.status === 0) return true;

  const xsel = spawnSync('xsel', ['--clipboard', '--input'], { input: text });
  return xsel.status === 0;
}

function handleNavigationKey(
  key: {
    pageUp?: boolean;
    pageDown?: boolean;
    home?: boolean;
    end?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
  },
  panelHeight: number,
  maxScrollTop: number,
  setScrollTop: React.Dispatch<React.SetStateAction<number>>,
): boolean {
  if (key.pageUp) {
    setScrollTop(previous => Math.max(0, previous - panelHeight));
    return true;
  }

  if (key.pageDown) {
    setScrollTop(previous => Math.min(maxScrollTop, previous + panelHeight));
    return true;
  }

  if (key.home) {
    setScrollTop(0);
    return true;
  }

  if (key.end) {
    setScrollTop(maxScrollTop);
    return true;
  }

  if (key.upArrow) {
    setScrollTop(previous => Math.max(0, previous - 1));
    return true;
  }

  if (key.downArrow) {
    setScrollTop(previous => Math.min(maxScrollTop, previous + 1));
    return true;
  }

  return false;
}

function handleClipboardInput(
  input: string,
  key: { ctrl?: boolean },
  visibleLines: string[],
  filteredLines: string[],
  setNotice: React.Dispatch<React.SetStateAction<string>>,
): boolean {
  if (!(key.ctrl && input === 'y')) {
    if (!(key.ctrl && input === 'l')) {
      return false;
    }

    const line = visibleLines[0] ?? '';
    const copiedLine = copyToClipboard(line);
    setNotice(copiedLine ? 'Copied selected line to clipboard' : 'Clipboard copy failed');
    return true;
  }

  const fullText = filteredLines.join('\n');
  const copied = copyToClipboard(fullText);
  setNotice(copied ? 'Copied full output to clipboard' : 'Clipboard copy failed');
  return true;
}

function getPromptGlyph(isSearchMode: boolean, isRunning: boolean): string {
  if (isSearchMode) {
    return '🔎';
  }
  if (isRunning) {
    return '⏳';
  }
  return '❯';
}

function handleSearchModeInputEvent(
  isSearchMode: boolean,
  input: string,
  key: {
    return?: boolean;
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  },
  setIsSearchMode: React.Dispatch<React.SetStateAction<boolean>>,
  setNotice: React.Dispatch<React.SetStateAction<string>>,
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>,
  setScrollTop: React.Dispatch<React.SetStateAction<number>>,
): boolean {
  if (!isSearchMode) {
    return false;
  }

  if (key.return) {
    setIsSearchMode(false);
    setNotice('Search filter applied');
    return true;
  }

  if (key.escape) {
    setIsSearchMode(false);
    setSearchQuery('');
    setNotice('Search cleared');
    return true;
  }

  if (key.backspace || key.delete) {
    setSearchQuery((previous) => previous.slice(0, -1));
    setScrollTop(0);
    return true;
  }

  if (!key.ctrl && !key.meta && input.length > 0) {
    setSearchQuery((previous) => previous + input);
    setScrollTop(0);
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
    setNotice('Search mode: type to filter results, Enter to return, Esc to clear');
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
  const targetCommand = ctx.pickerTarget?.command ?? (ctx.pickerMode === 'path' ? '/path' : '/file');
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
    const targetCommand = ctx.pickerTarget?.command ?? '/path';
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
  commandHistory: string[];
  historyIndex: number | null;
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
  if (completedLine.startsWith('/path ') || completedLine.startsWith('/file ')) {
    runCommand(completedLine);
    return true;
  }

  const firstToken = getFirstToken(completedLine);
  if (firstToken === '/format' || FILE_ARGUMENT_COMMANDS.has(firstToken)) {
    runCommand(completedLine);
    return true;
  }

  return false;
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

  if (firstToken !== selectedCommand) {
    if (needsArgs) {
      if (selectedCommand === '/path') {
        onActivatePicker('path', { command: selectedCommand });
      } else if (FILE_ARGUMENT_COMMANDS.has(selectedCommand) && !hasUsableFileContext(displayLastFile)) {
        onActivatePicker('file', { command: selectedCommand });
      } else {
        setCommandLine(buildPrefilledCommandLine(selectedCommand, displayLastFile));
        setNotice(`Command selected: ${selectedCommand}`);
      }
    } else {
      runCommand(selectedCommand);
    }
    return true;
  }

  if (!hasArguments && needsArgs) {
    if (selectedCommand === '/path') {
      onActivatePicker('path', { command: selectedCommand });
    } else if (FILE_ARGUMENT_COMMANDS.has(selectedCommand) && !hasUsableFileContext(displayLastFile)) {
      onActivatePicker('file', { command: selectedCommand });
    } else {
      setCommandLine(buildPrefilledCommandLine(selectedCommand, displayLastFile));
      setNotice(`Command selected: ${selectedCommand}`);
    }
    return true;
  }

  return false;
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
    commandHistory,
    historyIndex,
    runCommand,
    onActivatePicker,
    setNotice,
    setHistoryIndex,
    setCommandLine,
    setSelectedCommandIndex,
  } = context;

  const handleHistoryInput = (): boolean => {
    if (!(key.ctrl && (input === 'p' || input === 'n'))) {
      return false;
    }

    if (input === 'p') {
      if (commandHistory.length === 0) {
        return true;
      }

      const nextIndex = historyIndex === null
        ? 0
        : Math.min(historyIndex + 1, commandHistory.length - 1);
      setHistoryIndex(nextIndex);
      setCommandLine(commandHistory[nextIndex]);
      setNotice(`History ${nextIndex + 1}/${commandHistory.length}`);
      return true;
    }

    if (historyIndex === null) {
      return true;
    }

    const nextIndex = historyIndex - 1;
    if (nextIndex < 0) {
      setHistoryIndex(null);
      setCommandLine('');
      setNotice('History cleared');
      return true;
    }

    setHistoryIndex(nextIndex);
    setCommandLine(commandHistory[nextIndex]);
    setNotice(`History ${nextIndex + 1}/${commandHistory.length}`);
    return true;
  };

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

    if (trimmed === '/path' || trimmed === '/file') {
      onActivatePicker(trimmed === '/path' ? 'path' : 'file', { command: trimmed });
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
      if (hasUsableFileContext(displayLastFile)) {
        setCommandLine(`${insertFileArgument(trimmed, displayLastFile)} `);
        setNotice(`Using current file: ${displayLastFile}`);
      } else {
        onActivatePicker('file', { command: firstToken, baseLine: trimmed });
        setCommandLine('');
      }
      return true;
    }

    runCommand(trimmed);
    return true;
  };

  if (handleHistoryInput()) {
    return true;
  }

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
    setCommandLine(previous => previous + input);
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

  function buildPickerPanelNodes(
    pickerMode: PickerMode,
    pickerDir: string,
    pickerIndex: number,
    pickerEntries: PickerEntry[],
    visiblePickerEntries: PickerEntry[],
    pickerScrollStart: number,
    panelHeight: number,
    pickerTarget: PickerTarget | null,
  ): React.ReactElement {
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
      return h(Text, { key: `picker-${entry.relPath}`, color, bold: isSelected },
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
      h(Text, { key: 'picker-title', color: borderColor }, title),
      h(Text, { key: 'picker-breadcrumb', dimColor: true }, `  📍 ${breadcrumb}`),
      countNote,
      h(Box, { key: 'picker-entries', flexDirection: 'column', marginTop: 1 },
        ...(entryNodes.length > 0 ? entryNodes : [emptyNode]),
      ),
    );
  }

  function ReplInkApp(): React.ReactElement {
    const { exit } = useApp();
    const { rows } = useWindowSize();
    const [commandLine, setCommandLine] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearchMode, setIsSearchMode] = useState(false);
    const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [blocks, setBlocks] = useState<OutputBlock[]>([]);
    const [scrollTop, setScrollTop] = useState(0);
    const [notice, setNotice] = useState('Ready. Enter a command like /summary or /trace src/index.ts#main');
    const [currentAllFiles, setCurrentAllFiles] = useState(options.allFiles);
    const [displayWorkspace, setDisplayWorkspace] = useState(options.workspaceRoot);
    const currentWorkspaceRef = useRef(options.workspaceRoot);
    const [displayLastFile, setDisplayLastFile] = useState(options.lastFile
      ? path.relative(options.workspaceRoot, options.lastFile)
      : 'none');
    const [displayLastSymbol, setDisplayLastSymbol] = useState(options.lastSymbol ?? 'none');
    const [pickerMode, setPickerMode] = useState<PickerMode>('none');
    const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
    const [pickerDir, setPickerDir] = useState('');
    const [pickerIndex, setPickerIndex] = useState(0);

    const lines = useMemo(() => toLines(blocks), [blocks]);
    const slashSuggestions = useMemo(
      () => filterSlashCommands(commandLine, currentAllFiles, displayWorkspace),
      [commandLine, currentAllFiles, displayWorkspace],
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
          if (selectedSlashSuggestion.targetCommand === '/path' || selectedSlashSuggestion.targetCommand === '/file') {
            return getPathSuggestionPreview(commandLine, selectedSlashSuggestion.insertText ?? selectedSlashSuggestion.command);
          }
          return getArgumentCompletionPreview(commandLine, selectedSlashSuggestion.insertText ?? selectedSlashSuggestion.command);
        }
        return getCompletionPreview(commandLine, selectedSlashSuggestion?.command);
      },
      [commandLine, selectedSlashSuggestion],
    );
    const filteredLines = useMemo(() => {
      if (searchQuery.trim().length === 0) {
        return lines;
      }

      const needle = searchQuery.toLowerCase();
      return lines.filter((line) => line.toLowerCase().includes(needle));
    }, [lines, searchQuery]);
    const argsHintLine = selectedSlashSuggestion?.argsHint
      ? `${DIM}Args: ${selectedSlashSuggestion.argsHint}${RESET}`
      : undefined;
    const slashWindowIndicator = hasSlashSuggestions && slashSuggestions.length > visibleSlashSuggestions.length;
    const computedFooterRows = BASE_FOOTER_ROWS
      + (hasSlashSuggestions ? 1 : 0)
      + (hasSlashSuggestions && completionPreview.length > 0 ? 1 : 0)
      + (argsHintLine ? 1 : 0)
      + (slashWindowIndicator ? 1 : 0)
      + (hasSlashSuggestions ? visibleSlashSuggestions.length : 0);
    const panelHeight = Math.max(1, rows - HEADER_ROWS - computedFooterRows);
    const panelContentHeight = Math.max(1, panelHeight - 2);
    const maxScrollTop = Math.max(0, filteredLines.length - panelContentHeight);
    const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
    const visibleLines = filteredLines.slice(clampedScrollTop, clampedScrollTop + panelContentHeight);

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
      setPickerTarget(target ?? { command: mode === 'path' ? '/path' : '/file' });
      setPickerDir('');
      setPickerIndex(0);
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
          setScrollTop(Number.MAX_SAFE_INTEGER);
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
          setScrollTop(Number.MAX_SAFE_INTEGER);
          setNotice('Command failed');
        })
        .finally(() => {
          setIsRunning(false);
        });
    };

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
        () => handleSearchModeInputEvent(isSearchMode, input, key, setIsSearchMode, setNotice, setSearchQuery, setScrollTop),
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
        () => handleClipboardInput(input, key, visibleLines, filteredLines, setNotice),
        () => handleCommandInputEvent(
          input,
          key,
          {
            isRunning,
            commandLine,
            displayLastFile,
            selectedSlashSuggestion,
            commandHistory,
            historyIndex,
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

    const resultNodes = visibleLines.length > 0
      ? visibleLines.map((line, index) => h(Text, { key: `${clampedScrollTop + index}-${line}` }, line))
      : [h(Text, { dimColor: true, key: 'empty' }, 'No results yet')];
    const suggestionNodes = hasSlashSuggestions
      ? visibleSlashSuggestions.map((entry, index) => {
          const absoluteIndex = visibleSlashStart + index;
          const isSelected = absoluteIndex === boundedSelectedCommandIndex;
          const prefix = isSelected ? '›' : ' ';
          const color = isSelected ? SPARK : DIM;
          return h(
            Text,
            { key: `slash-${absoluteIndex}-${entry.command}` },
            `${color}${prefix} ${entry.command.padEnd(20)}${RESET} ${entry.description}`,
          );
        })
      : [];
    const filterSuffix = searchQuery
      ? ` ${SPARK}filter:${RESET} ${searchQuery}`
      : '';
    const resultsSummary = `${BOLD}Results${RESET} ${DIM}(lines ${clampedScrollTop + 1}-${Math.min(filteredLines.length, clampedScrollTop + panelContentHeight)} / ${Math.max(1, filteredLines.length)})${RESET}${filterSuffix}`;
    const promptGlyph = getPromptGlyph(isSearchMode, isRunning);
    const activeInput = isSearchMode ? searchQuery : commandLine;
    const runningSuffix = isRunning ? ' …' : '';

    return h(
      Box,
      { flexDirection: 'column', height: rows },
      h(
        Box,
        { flexDirection: 'column', marginBottom: 1 },
        h(Text, {}, `${BLUE}●${RESET}${DIM}─${RESET}${BLUE}■${RESET}   ${BOLD}Graph-It-Live${RESET} ${DIM}v${options.version}${RESET} ${SPARK}✦${RESET}`),
        h(Text, {}, `${BLUE}│${RESET} ${DIM}╲${RESET}   ${DIM}Ctrl+C quit · PgUp/PgDn scroll · Ctrl+Y copy all · Ctrl+L copy line${RESET}`),
        h(Text, {}, `${BLUE}●${RESET}${DIM}─${RESET}${ORANGE}■${RESET}   ${DIM}Ctrl+F search output · Esc clear search · Ctrl+P/Ctrl+N history${RESET}`),
      ),
      h(
        Box,
        { marginBottom: 1 },
        h(Text, { wrap: 'truncate' }, `${DIM}workspace:${RESET} ${displayWorkspace}  ${DIM}format:${RESET} ${options.preferredFormat}  ${DIM}last file:${RESET} ${displayLastFile}  ${DIM}last symbol:${RESET} ${displayLastSymbol}`),
      ),
      pickerMode === 'none'
        ? h(
            Box,
            {
              height: panelHeight,
              flexDirection: 'column',
              paddingLeft: 1,
            },
            h(Text, { color: 'cyan' }, resultsSummary),
            h(Box, { flexDirection: 'column', marginTop: 1 }, ...resultNodes),
          )
        : buildPickerPanelNodes(pickerMode, pickerDir, pickerIndex, pickerEntries, visiblePickerEntries, pickerScrollStart, panelHeight, pickerTarget),
      h(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        h(Text, {}, `${DIM}${notice}${RESET}`),
        h(Text, {}, `${promptGlyph} ${activeInput}${runningSuffix}`),
        ...(hasSlashSuggestions
          ? [
              h(Text, { key: 'slash-help' }, `${DIM}Suggestions ${boundedSelectedCommandIndex + 1}/${slashSuggestions.length}: ↑/↓ select · Tab complete · Enter apply/run · type space for files/options${RESET}`),
              ...(completionPreview.length > 0
                ? [h(Text, { key: 'slash-completion' }, `${DIM}Completion: ${activeInput}${completionPreview}${RESET}`)]
                : []),
              ...(argsHintLine ? [h(Text, { key: 'slash-args' }, argsHintLine)] : []),
              ...(slashWindowIndicator
                ? [
                    h(
                      Text,
                      { key: 'slash-window' },
                      `${DIM}Showing ${visibleSlashStart + 1}-${visibleSlashStart + visibleSlashSuggestions.length}${RESET}`,
                    ),
                  ]
                : []),
              ...suggestionNodes,
            ]
          : []),
      ),
    );
  }

  const instance = render(h(ReplInkApp), { alternateScreen: true });
  await instance.waitUntilExit();
}
