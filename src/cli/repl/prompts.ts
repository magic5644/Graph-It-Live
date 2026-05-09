/**
 * REPL Prompts
 *
 * All @inquirer/prompts questions used by the REPL, centralised here
 * so each can be updated independently from the REPL loop.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { confirm, input, search, select } from '@inquirer/prompts';
import type { CliOutputFormat } from '../formatter.js';
import { sanitizeTerminalText } from './terminal.js';
import { normalizePath } from '../../shared/path.js';
import * as path from 'node:path';
import { filterFiles } from './fileSearch.js';

// ============================================================================
// Action types
// ============================================================================

export type MainAction =
  | 'trace'
  | 'command'
  | 'setPath'
  | 'checkDependencies'
  | 'cycles'
  | 'check'
  | 'summary'
  | 'architecture'
  | 'format'
  | 'help'
  | 'quit';
export type PostResultAction = 'drillDown' | 'export' | 'saveToFile' | 'setFormat' | 'newAnalysis' | 'quit';
export type ExportFormat = 'json' | 'markdown' | 'mermaid';

export interface MainActionSelection {
  kind: 'action' | 'typed' | 'quit';
  action?: MainAction;
  commandLine?: string;
}

interface PaletteEntry<TValue> {
  slash: string;
  title: string;
  description: string;
  aliases: string[];
  keywords: string[];
  value: TValue;
}

interface BrowserEntries {
  directories: string[];
  files: string[];
}

interface FileBrowserChoice {
  name: string;
  value: string;
  disabled?: boolean;
}

interface DirectoryBrowserChoice {
  name: string;
  value: string;
}

type JumpResolution =
  | { kind: 'file'; value: string }
  | { kind: 'directory'; value: string }
  | { kind: 'none'; suggestions: string[] };

const FILE_BROWSER_MAX_FILES = 60;
const FILE_BROWSER_MAX_SUGGESTIONS = 5;

const MAIN_ACTION_ENTRIES: PaletteEntry<MainAction>[] = [
  {
    slash: '/trace',
    title: 'Trace a symbol or file',
    description: 'Select a file, then optionally drill into a symbol.',
    aliases: ['trace'],
    keywords: ['symbol', 'call', 'flow', 'execution'],
    value: 'trace',
  },
  {
    slash: '/path',
    title: 'Set workspace directory',
    description: 'Navigate directories and set the active workspace scope.',
    aliases: ['path', 'workspace'],
    keywords: ['directory', 'root', 'scope', 'folder'],
    value: 'setPath',
  },
  {
    slash: '/check-dependencies',
    title: 'Check incoming & outgoing deps',
    description: 'Analyze both importers (in) and imports (out) for a file.',
    aliases: ['check-dependencies', 'deps', 'dependencies'],
    keywords: ['incoming', 'outgoing', 'in', 'out', 'graph'],
    value: 'checkDependencies',
  },
  {
    slash: '/cycles',
    title: 'List confirmed dependency cycles',
    description: 'Detect and list cycle chains that include the selected file.',
    aliases: ['cycles', 'cycle'],
    keywords: ['circular', 'dependencies', 'loop'],
    value: 'cycles',
  },
  {
    slash: '/summary',
    title: 'Summarize workspace or file',
    description: 'Show the current file summary when available, otherwise the workspace.',
    aliases: ['summary', 'codemap'],
    keywords: ['overview', 'map', 'workspace'],
    value: 'summary',
  },
  {
    slash: '/architecture',
    title: 'Build workspace architecture',
    description: 'Render the full project graph, including Mermaid when supported.',
    aliases: ['architecture', 'arch'],
    keywords: ['workspace', 'mermaid', 'graph'],
    value: 'architecture',
  },
  {
    slash: '/check',
    title: 'Find dead code',
    description: 'Inspect the current file or workspace for unused exports.',
    aliases: ['check', 'unused'],
    keywords: ['dead', 'unused', 'analysis'],
    value: 'check',
  },
  {
    slash: '/command',
    title: 'Run a raw command line',
    description: 'Type a full CLI command such as /path-in file.ts or /trace file.ts#fn.',
    aliases: ['command', 'raw'],
    keywords: ['cli', 'manual', 'freeform'],
    value: 'command',
  },
  {
    slash: '/file',
    title: 'Set current file context',
    description: 'Set the active file used by /summary and /check when no file is provided.',
    aliases: ['file', 'context'],
    keywords: ['current', 'active', 'path'],
    value: 'command',
  },
  {
    slash: '/format',
    title: 'Change default format',
    description: 'Pick the default REPL rendering format for the current session.',
    aliases: ['format'],
    keywords: ['text', 'json', 'markdown', 'toon', 'mermaid'],
    value: 'format',
  },
  {
    slash: '/help',
    title: 'Show REPL help',
    description: 'Display common slash commands and examples.',
    aliases: ['help'],
    keywords: ['commands', 'examples', 'tips'],
    value: 'help',
  },
  {
    slash: '/quit',
    title: 'Quit the REPL',
    description: 'Exit the interactive session.',
    aliases: ['quit', 'exit'],
    keywords: ['leave', 'close'],
    value: 'quit',
  },
];

const POST_RESULT_ENTRIES: PaletteEntry<PostResultAction>[] = [
  {
    slash: '/drill-down',
    title: 'Drill into the current node',
    description: 'Jump deeper into the current file or symbol context.',
    aliases: ['drill-down', 'drill'],
    keywords: ['symbol', 'node', 'trace'],
    value: 'drillDown',
  },
  {
    slash: '/export',
    title: 'Export in another format',
    description: 'Render the current structured result as JSON, Markdown, or Mermaid.',
    aliases: ['export'],
    keywords: ['json', 'markdown', 'mermaid'],
    value: 'export',
  },
  {
    slash: '/save',
    title: 'Save current result to a file',
    description: 'Write the visible output to a safe path inside the workspace.',
    aliases: ['save'],
    keywords: ['file', 'write'],
    value: 'saveToFile',
  },
  {
    slash: '/format',
    title: 'Change default format',
    description: 'Update the session default rendering format.',
    aliases: ['format'],
    keywords: ['text', 'json', 'markdown', 'toon', 'mermaid'],
    value: 'setFormat',
  },
  {
    slash: '/again',
    title: 'Start a new analysis',
    description: 'Return to the main palette for another action.',
    aliases: ['again', 'new'],
    keywords: ['analysis', 'back'],
    value: 'newAnalysis',
  },
  {
    slash: '/quit',
    title: 'Quit the REPL',
    description: 'Exit the interactive session.',
    aliases: ['quit', 'exit'],
    keywords: ['leave', 'close'],
    value: 'quit',
  },
];

function normalizePaletteQuery(input: string | undefined): string {
  return (input ?? '').trim().toLowerCase();
}

function isSlashPaletteQuery(input: string | undefined): boolean {
  return normalizePaletteQuery(input).startsWith('/');
}

function scorePaletteEntry<TValue>(entry: PaletteEntry<TValue>, query: string): number {
  if (!query || query === '/') return 0;

  const normalizedSlash = entry.slash.toLowerCase();
  const normalizedQuery = query.startsWith('/') ? query : `/${query}`;
  if (normalizedSlash === normalizedQuery) return 0;
  if (normalizedSlash.startsWith(normalizedQuery)) return 1;
  if (entry.aliases.some((alias) => alias.toLowerCase() === query)) return 2;
  if (entry.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 3;

  const haystack = [entry.title, entry.description, ...entry.aliases, ...entry.keywords]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query) ? 10 : Number.POSITIVE_INFINITY;
}

function renderPaletteLabel<TValue>(entry: PaletteEntry<TValue>): string {
  return `${entry.slash.padEnd(14)} ${entry.title} — ${entry.description}`;
}

function filterPaletteEntries<TValue>(
  entries: PaletteEntry<TValue>[],
  input?: string,
): PaletteEntry<TValue>[] {
  if (!isSlashPaletteQuery(input)) {
    return [];
  }

  const query = normalizePaletteQuery(input);
  return entries
    .map((entry) => ({ entry, score: scorePaletteEntry(entry, query) }))
    .filter(({ score }) => score !== Number.POSITIVE_INFINITY)
    .sort((left, right) => left.score - right.score || left.entry.slash.localeCompare(right.entry.slash))
    .map(({ entry }) => entry);
}

function shouldOfferTypedCommand(trimmedInput: string): boolean {
  return trimmedInput.startsWith('/');
}

export function buildMainActionChoices(input?: string): Array<{
  name: string;
  value: MainActionSelection;
}> {
  const trimmed = (input ?? '').trim();
  const matchedEntries = filterPaletteEntries(MAIN_ACTION_ENTRIES, input).slice(0, 8);
  const choices: Array<{ name: string; value: MainActionSelection }> = matchedEntries.map((entry) => ({
    name: renderPaletteLabel(entry),
    value: entry.value === 'quit'
      ? ({ kind: 'quit' } satisfies MainActionSelection)
      : ({ kind: 'action', action: entry.value } satisfies MainActionSelection),
  }));

  if (trimmed && trimmed !== '/' && shouldOfferTypedCommand(trimmed)) {
    const preview = sanitizeTerminalText(trimmed, 96);
    choices.unshift({
      name: `Run typed command  ${preview}`,
      value: { kind: 'typed', commandLine: trimmed },
    });
  }

  return choices;
}

export function buildPostResultChoices(input?: string): Array<{
  name: string;
  value: PostResultAction;
}> {
  return filterPaletteEntries(POST_RESULT_ENTRIES, input)
    .slice(0, 8)
    .map((entry) => ({ name: renderPaletteLabel(entry), value: entry.value }));
}

// ============================================================================
// Prompts
// ============================================================================

/** Main command palette: type / to browse commands, or enter a command directly. */
export async function selectMainAction(message = 'Type / to browse commands'): Promise<MainActionSelection> {
  return search<MainActionSelection>({
    message,
    source: async (input) => buildMainActionChoices(input),
  });
}

/**
 * File fuzzy-search: type to filter, pick from live list.
 *
 * @param allFiles - Absolute paths from SourceFileCollector
 * @param workspaceRoot - Root for computing relative display paths
 */
export async function searchFile(
  allFiles: string[],
  workspaceRoot: string,
): Promise<string> {
  const relativeFiles = allFiles
    .map((absPath) => normalizePath(path.relative(workspaceRoot, absPath)))
    .sort((left, right) => left.localeCompare(right));

  let currentDirectory = '';

  for (;;) {
    const choices = buildFileBrowserChoices(relativeFiles, currentDirectory);
    const location = currentDirectory || '.';

    const selected = await select<string>({
      message: `Browse files (${location})`,
      choices,
    });

    if (selected === '__jump__') {
      const jumpResult = await handleJumpSelection(relativeFiles, currentDirectory);
      if (jumpResult.filePath) {
        return jumpResult.filePath;
      }
      if (jumpResult.nextDirectory !== undefined) {
        currentDirectory = jumpResult.nextDirectory;
        continue;
      }
      continue;
    }

    if (selected === '__up__') {
      currentDirectory = parentDirectoryOf(currentDirectory);
      continue;
    }

    if (selected.startsWith('dir:')) {
      currentDirectory = selected.slice('dir:'.length);
      continue;
    }

    if (selected.startsWith('file:')) {
      return selected.slice('file:'.length);
    }
  }
}

/**
 * Directory browser used by /path to set session workspace scope.
 */
export async function searchDirectory(
  allFiles: string[],
  workspaceRoot: string,
): Promise<string> {
  const relativeFiles = allFiles
    .map((absPath) => normalizePath(path.relative(workspaceRoot, absPath)))
    .filter((relPath) => relPath && !relPath.startsWith('..'))
    .sort((left, right) => left.localeCompare(right));

  let currentDirectory = '';

  for (;;) {
    const choices = buildDirectoryBrowserChoices(relativeFiles, currentDirectory);
    const location = currentDirectory || '.';

    const selected = await select<string>({
      message: `Browse directories (${location})`,
      choices,
    });

    const outcome = await handleDirectorySelection(
      selected,
      relativeFiles,
      currentDirectory,
    );

    if (outcome.selectedDirectory !== undefined) {
      return outcome.selectedDirectory;
    }

    if (outcome.nextDirectory !== undefined) {
      currentDirectory = outcome.nextDirectory;
    }
  }
}

export async function handleDirectorySelection(
  selected: string,
  relativeFiles: string[],
  currentDirectory: string,
): Promise<{ selectedDirectory?: string; nextDirectory?: string }> {
  if (selected === '__select_current__') {
    return { selectedDirectory: currentDirectory };
  }

  if (selected === '__up__') {
    return { nextDirectory: parentDirectoryOf(currentDirectory) };
  }

  if (selected.startsWith('dir:')) {
    return { selectedDirectory: selected.slice('dir:'.length) };
  }

  if (selected !== '__jump__') {
    return {};
  }

  const typedPath = await input({
    message: 'Jump to directory path (workspace-relative)',
    default: currentDirectory ? `${currentDirectory}/` : '',
  });

  const normalized = normalizeUserPathInput(typedPath);
  if (!normalized) {
    process.stdout.write('Empty path. Keeping current directory.\n');
    return {};
  }

  if (normalized === '.') {
    return { selectedDirectory: currentDirectory };
  }

  const jumpResult = resolveDirectoryJumpTarget(relativeFiles, currentDirectory, normalized);
  if (jumpResult.kind === 'directory') {
    return { nextDirectory: jumpResult.value };
  }

  process.stdout.write(
    `No directory match for "${sanitizeTerminalText(typedPath, 120)}".\n`,
  );
  return {};
}

async function handleJumpSelection(
  relativeFiles: string[],
  currentDirectory: string,
): Promise<{ filePath?: string; nextDirectory?: string }> {
  const typedPath = await input({
    message: 'Jump to file path (workspace-relative)',
    default: currentDirectory ? `${currentDirectory}/` : '',
  });

  const resolution = resolveJumpTarget(relativeFiles, currentDirectory, typedPath);
  if (resolution.kind === 'file') {
    return { filePath: resolution.value };
  }

  if (resolution.kind === 'directory') {
    return { nextDirectory: resolution.value };
  }

  printJumpNotFoundMessage(typedPath, resolution.suggestions);
  return {};
}

function printJumpNotFoundMessage(typedPath: string, suggestions: string[]): void {
  if (suggestions.length > 0) {
    process.stdout.write(
      `No exact match for "${sanitizeTerminalText(typedPath, 120)}". Suggestions: ${suggestions.join(', ')}\n`,
    );
    return;
  }

  process.stdout.write(
    `No match for "${sanitizeTerminalText(typedPath, 120)}". Try a different path.\n`,
  );
}

function normalizeUserPathInput(rawInput: string): string {
  return normalizePath(rawInput.trim())
    .replace(/^\.\//, '')
    .replace(/^\//, '');
}

function hasDirectory(relativeFiles: string[], directory: string): boolean {
  const prefix = `${directory}/`;
  return relativeFiles.some((filePath) => filePath.startsWith(prefix));
}

function dedupeCandidates(values: string[]): string[] {
  return [...new Set(values)];
}

function buildJumpCandidates(inputPath: string, currentDirectory: string): string[] {
  if (!currentDirectory) return [inputPath];
  return dedupeCandidates([
    inputPath,
    normalizePath(path.posix.join(currentDirectory, inputPath)),
  ]);
}

function toSuggestionText(matches: string[]): string[] {
  return matches
    .slice(0, FILE_BROWSER_MAX_SUGGESTIONS)
    .map((match) => sanitizeTerminalText(match, 120));
}

function findJumpSuggestions(relativeFiles: string[], query: string): string[] {
  const syntheticWorkspace = '/workspace';
  const absoluteFiles = relativeFiles.map((rel) => path.posix.join(syntheticWorkspace, rel));
  const matches = filterFiles(absoluteFiles, query, syntheticWorkspace);
  return toSuggestionText(matches);
}

export function resolveJumpTarget(
  relativeFiles: string[],
  currentDirectory: string,
  rawInput: string,
): JumpResolution {
  const inputPath = normalizeUserPathInput(rawInput);
  if (!inputPath) {
    return { kind: 'none', suggestions: [] };
  }

  const fileSet = new Set(relativeFiles);
  const candidates = buildJumpCandidates(inputPath, currentDirectory);

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return { kind: 'file', value: candidate };
    }
    if (hasDirectory(relativeFiles, candidate)) {
      return { kind: 'directory', value: candidate };
    }
  }

  return {
    kind: 'none',
    suggestions: findJumpSuggestions(relativeFiles, inputPath),
  };
}

function parentDirectoryOf(currentDirectory: string): string {
  if (!currentDirectory) return '';
  const lastSlash = currentDirectory.lastIndexOf('/');
  if (lastSlash <= 0) return '';
  return currentDirectory.slice(0, lastSlash);
}

function listDirectoryEntries(
  relativeFiles: string[],
  currentDirectory: string,
): BrowserEntries {
  const prefix = currentDirectory ? `${currentDirectory}/` : '';
  const directories = new Set<string>();
  const files: string[] = [];

  for (const relPath of relativeFiles) {
    if (prefix && !relPath.startsWith(prefix)) {
      continue;
    }

    const remainder = prefix ? relPath.slice(prefix.length) : relPath;
    if (!remainder || remainder.startsWith('..')) {
      continue;
    }

    const slashIndex = remainder.indexOf('/');
    if (slashIndex < 0) {
      files.push(relPath);
      continue;
    }

    const nextDirectorySegment = remainder.slice(0, slashIndex);
    directories.add(nextDirectorySegment);
  }

  const sortedDirectories = [...directories].sort((left, right) => left.localeCompare(right));
  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));

  return {
    directories: sortedDirectories,
    files: sortedFiles,
  };
}

function listSubdirectories(
  relativeFiles: string[],
  currentDirectory: string,
): string[] {
  return listDirectoryEntries(relativeFiles, currentDirectory).directories;
}

export function buildFileBrowserChoices(
  relativeFiles: string[],
  currentDirectory: string,
): FileBrowserChoice[] {
  const { directories, files } = listDirectoryEntries(relativeFiles, currentDirectory);
  const choices: FileBrowserChoice[] = [
    {
      name: '⌨ Jump to path…',
      value: '__jump__',
    },
  ];

  if (currentDirectory) {
    choices.push({
      name: '↩ Go to parent directory',
      value: '__up__',
    });
  }

  for (const directoryName of directories) {
    const nextPath = currentDirectory ? `${currentDirectory}/${directoryName}` : directoryName;
    choices.push({
      name: `📁 ${sanitizeTerminalText(directoryName, 80)}/`,
      value: `dir:${nextPath}`,
    });
  }

  const visibleFiles = files.slice(0, FILE_BROWSER_MAX_FILES);
  for (const filePath of visibleFiles) {
    const basename = filePath.split('/').at(-1) ?? filePath;
    choices.push({
      name: `📄 ${sanitizeTerminalText(basename, 80)}  ${sanitizeTerminalText(filePath, 160)}`,
      value: `file:${filePath}`,
    });
  }

  if (files.length > FILE_BROWSER_MAX_FILES) {
    choices.push({
      name: `… ${files.length - FILE_BROWSER_MAX_FILES} more files in this directory`,
      value: '__too_many__',
      disabled: true,
    });
  }

  if (directories.length === 0 && files.length === 0) {
    choices.push({
      name: 'No files found in this directory',
      value: '__empty__',
      disabled: true,
    });
  }

  return choices;
}

function resolveDirectoryJumpTarget(
  relativeFiles: string[],
  currentDirectory: string,
  normalizedInput: string,
): { kind: 'directory'; value: string } | { kind: 'none' } {
  const candidates = buildJumpCandidates(normalizedInput, currentDirectory);
  for (const candidate of candidates) {
    if (hasDirectory(relativeFiles, candidate)) {
      return { kind: 'directory', value: candidate };
    }
  }
  return { kind: 'none' };
}

export function buildDirectoryBrowserChoices(
  relativeFiles: string[],
  currentDirectory: string,
): DirectoryBrowserChoice[] {
  const directories = listSubdirectories(relativeFiles, currentDirectory);
  const choices: DirectoryBrowserChoice[] = [
    { name: '✅ Select this directory', value: '__select_current__' },
    { name: '⌨ Jump to path…', value: '__jump__' },
  ];

  if (currentDirectory) {
    choices.push({ name: '↩ Go to parent directory', value: '__up__' });
  }

  for (const directoryName of directories) {
    const nextPath = currentDirectory ? `${currentDirectory}/${directoryName}` : directoryName;
    choices.push({
      name: `📁 ${sanitizeTerminalText(directoryName, 80)}/`,
      value: `dir:${nextPath}`,
    });
  }

  return choices;
}

/**
 * Optional symbol input after file selection.
 * Empty answer means "analyse the whole file".
 *
 * @param displayPath - Relative path shown in the prompt label
 */
export async function inputSymbol(
  displayPath: string,
  defaultSymbol = '',
): Promise<string> {
  return input({
    message: `Symbol to analyze in ${displayPath} (leave empty for full-file analysis)`,
    default: defaultSymbol,
  });
}

/** Post-result menu. */
export async function selectPostResultAction(message = 'Type / for next actions'): Promise<PostResultAction> {
  return search<PostResultAction>({
    message,
    source: async (input) => buildPostResultChoices(input),
  });
}

/** Export format selector. */
export async function selectExportFormat(): Promise<ExportFormat> {
  return select<ExportFormat>({
    message: 'Export format',
    choices: [
      { name: 'JSON', value: 'json' },
      { name: 'Markdown', value: 'markdown' },
      { name: 'Mermaid', value: 'mermaid' },
    ],
  });
}

/** Preferred output format selector for interactive session defaults. */
export async function selectPreferredFormat(
  currentFormat: CliOutputFormat,
): Promise<CliOutputFormat> {
  return select<CliOutputFormat>({
    message: `Default output format (current: ${currentFormat})`,
    choices: [
      { name: 'Text (best readability)', value: 'text' },
      { name: 'JSON (best for scripts)', value: 'json' },
      { name: 'TOON (compact for LLM)', value: 'toon' },
      { name: 'Markdown', value: 'markdown' },
      { name: 'Mermaid (diagram output)', value: 'mermaid' },
    ],
    default: currentFormat,
  });
}

/** Prompt for a free-form command line (without or with "graph-it" prefix). */
export async function inputCommandLine(defaultValue = ''): Promise<string> {
  return input({
    message: 'Command (/help for examples)',
    default: defaultValue,
  });
}

/** Ask where to save current result (relative path from workspace root). */
export async function inputSavePath(defaultPath: string): Promise<string> {
  return input({
    message: 'Save result as (path in workspace)',
    default: defaultPath,
  });
}

/** Offer to re-index when the workspace has no index yet. */
export async function confirmScan(reason: string): Promise<boolean> {
  return confirm({ message: `${reason} Scan now?`, default: true });
}
