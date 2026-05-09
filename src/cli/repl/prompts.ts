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
import { getTip } from './tips.js';

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
export type PostResultAction =
  | 'drillDown'
  | 'export'
  | 'saveToFile'
  | 'setFormat'
  | 'newAnalysis'
  | 'followUpDeps'
  | 'followUpCycles'
  | 'followUpTrace'
  | 'followUpDeadCode'
  | 'followUpArchitecture'
  | 'quit';
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
  group: string;
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
    keywords: ['symbol', 'call', 'flow', 'execution', 'developer', 'qa'],
    value: 'trace',
    group: '🔍 Code Analysis',
  },
  {
    slash: '/path',
    title: 'Set workspace directory',
    description: 'Navigate directories and set the active workspace scope.',
    aliases: ['path', 'workspace'],
    keywords: ['directory', 'root', 'scope', 'folder', 'architect'],
    value: 'setPath',
    group: '📐 Architecture',
  },
  {
    slash: '/check-dependencies',
    title: 'Check incoming & outgoing deps',
    description: 'Analyze both importers (in) and imports (out) for a file.',
    aliases: ['check-dependencies', 'deps', 'dependencies'],
    keywords: ['incoming', 'outgoing', 'in', 'out', 'graph', 'developer', 'architect'],
    value: 'checkDependencies',
    group: '🔍 Code Analysis',
  },
  {
    slash: '/cycles',
    title: 'List confirmed dependency cycles',
    description: 'Detect and list cycle chains that include the selected file.',
    aliases: ['cycles', 'cycle'],
    keywords: ['circular', 'dependencies', 'loop', 'security', 'qa'],
    value: 'cycles',
    group: '🔍 Code Analysis',
  },
  {
    slash: '/summary',
    title: 'Summarize workspace or file',
    description: 'Show the current file summary when available, otherwise the workspace.',
    aliases: ['summary', 'codemap'],
    keywords: ['overview', 'map', 'workspace', 'architect', 'functional'],
    value: 'summary',
    group: '📐 Architecture',
  },
  {
    slash: '/architecture',
    title: 'Build workspace architecture',
    description: 'Render the full project graph, including Mermaid when supported.',
    aliases: ['architecture', 'arch'],
    keywords: ['workspace', 'mermaid', 'graph', 'architect'],
    value: 'architecture',
    group: '📐 Architecture',
  },
  {
    slash: '/check',
    title: 'Find dead code',
    description: 'Inspect the current file or workspace for unused exports.',
    aliases: ['check', 'unused'],
    keywords: ['dead', 'unused', 'analysis', 'security', 'qa'],
    value: 'check',
    group: '🔍 Code Analysis',
  },
  {
    slash: '/command',
    title: 'Run a raw command line',
    description: 'Type a full CLI command such as /path-in file.ts or /trace file.ts#fn.',
    aliases: ['command', 'raw'],
    keywords: ['cli', 'manual', 'freeform'],
    value: 'command',
    group: '⚙ Session',
  },
  {
    slash: '/file',
    title: 'Set current file context',
    description: 'Set the active file used by /summary and /check when no file is provided.',
    aliases: ['file', 'context'],
    keywords: ['current', 'active', 'path'],
    value: 'command',
    group: '⚙ Session',
  },
  {
    slash: '/format',
    title: 'Change default format',
    description: 'Pick the default REPL rendering format for the current session.',
    aliases: ['format'],
    keywords: ['text', 'json', 'markdown', 'toon', 'mermaid'],
    value: 'format',
    group: '⚙ Session',
  },
  {
    slash: '/help',
    title: 'Show REPL help',
    description: 'Display common slash commands and examples.',
    aliases: ['help'],
    keywords: ['commands', 'examples', 'tips'],
    value: 'help',
    group: '⚙ Session',
  },
  {
    slash: '/quit',
    title: 'Quit the REPL',
    description: 'Exit the interactive session.',
    aliases: ['quit', 'exit'],
    keywords: ['leave', 'close'],
    value: 'quit',
    group: '⚙ Session',
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
    group: '🔍 Analysis',
  },
  {
    slash: '/export',
    title: 'Export in another format',
    description: 'Render the current structured result as JSON, Markdown, or Mermaid.',
    aliases: ['export'],
    keywords: ['json', 'markdown', 'mermaid'],
    value: 'export',
    group: '💾 Save',
  },
  {
    slash: '/save',
    title: 'Save current result to a file',
    description: 'Write the visible output to a safe path inside the workspace.',
    aliases: ['save'],
    keywords: ['file', 'write'],
    value: 'saveToFile',
    group: '💾 Save',
  },
  {
    slash: '/format',
    group: '⚙ Session',
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
    group: '⚙ Session',
  },
  {
    slash: '/quit',
    title: 'Quit the REPL',
    description: 'Exit the interactive session.',
    aliases: ['quit', 'exit'],
    keywords: ['leave', 'close'],
    value: 'quit',
    group: '⚙ Session',
  },
];

/** Contextual follow-up entries keyed by last command. */
const FOLLOW_UP_ENTRIES: Record<string, PaletteEntry<PostResultAction>[]> = {
  'trace': [
    { slash: '/→ check-dependencies', title: 'Check who depends on this file', description: 'See incoming and outgoing imports for the traced file.', aliases: [], keywords: [], value: 'followUpDeps', group: '🔍 Follow-up' },
    { slash: '/→ cycles',            title: 'Find circular dependencies',   description: 'Detect cycles that include the traced file.',          aliases: [], keywords: [], value: 'followUpCycles', group: '🔍 Follow-up' },
  ],
  'explain': [
    { slash: '/→ check-dependencies', title: 'Check who depends on this file', description: 'See incoming and outgoing imports for this file.',       aliases: [], keywords: [], value: 'followUpDeps', group: '🔍 Follow-up' },
    { slash: '/→ cycles',            title: 'Find circular dependencies',   description: 'Detect cycles that include this file.',                  aliases: [], keywords: [], value: 'followUpCycles', group: '🔍 Follow-up' },
  ],
  'check-dependencies': [
    { slash: '/→ trace',  title: 'Trace a symbol in this file', description: 'Dive into a specific symbol\'s execution path.', aliases: [], keywords: [], value: 'followUpTrace', group: '🔍 Follow-up' },
    { slash: '/→ cycles', title: 'Find circular dependencies',  description: 'Detect cycles involving this file.',              aliases: [], keywords: [], value: 'followUpCycles', group: '🔍 Follow-up' },
  ],
  'cycles': [
    { slash: '/→ check-dependencies', title: 'Check file dependencies',  description: 'See all imports for a file in the cycle.',    aliases: [], keywords: [], value: 'followUpDeps',     group: '🔍 Follow-up' },
    { slash: '/→ check',              title: 'Find dead code',            description: 'Detect unused exports in the cycle members.', aliases: [], keywords: [], value: 'followUpDeadCode', group: '🔍 Follow-up' },
  ],
  'architecture': [
    { slash: '/→ check', title: 'Find dead code across workspace', description: 'Detect unused exports after mapping the graph.',        aliases: [], keywords: [], value: 'followUpDeadCode',     group: '🔍 Follow-up' },
    { slash: '/→ trace', title: 'Trace a symbol',                  description: 'Drill into a specific file\'s execution flow.',           aliases: [], keywords: [], value: 'followUpTrace',        group: '🔍 Follow-up' },
  ],
  'check': [
    { slash: '/→ architecture',       title: 'Build workspace architecture', description: 'Map the full dependency graph.',                       aliases: [], keywords: [], value: 'followUpArchitecture', group: '🔍 Follow-up' },
    { slash: '/→ check-dependencies', title: 'Check file dependencies',      description: 'See incoming and outgoing imports for a flagged file.', aliases: [], keywords: [], value: 'followUpDeps',         group: '🔍 Follow-up' },
  ],
  'summary': [
    { slash: '/→ architecture', title: 'Build workspace architecture', description: 'Get the full project dependency map.',         aliases: [], keywords: [], value: 'followUpArchitecture', group: '🔍 Follow-up' },
    { slash: '/→ trace',        title: 'Trace a symbol',              description: 'Follow the execution flow from a key symbol.', aliases: [], keywords: [], value: 'followUpTrace',        group: '🔍 Follow-up' },
  ],
  'path': [
    { slash: '/→ check-dependencies', title: 'Check full deps (in + out)', description: 'See both import directions for the entry file.', aliases: [], keywords: [], value: 'followUpDeps',   group: '🔍 Follow-up' },
    { slash: '/→ cycles',             title: 'Find circular dependencies', description: 'Detect cycles in the dependency graph.',       aliases: [], keywords: [], value: 'followUpCycles', group: '🔍 Follow-up' },
  ],
};

/**
 * Return contextual follow-up palette entries for a given command result.
 * Returns [] for unknown commands.
 */
export function buildContextualPostResultEntries(command: string): PaletteEntry<PostResultAction>[] {
  return FOLLOW_UP_ENTRIES[command] ?? [];
}

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
  const bareQuery = query.startsWith('/') ? query.slice(1) : query;
  return haystack.includes(bareQuery) ? 10 : Number.POSITIVE_INFINITY;
}

function renderPaletteLabel<TValue>(entry: PaletteEntry<TValue>, showGroup = false): string {
  const groupSuffix = showGroup ? `  [${entry.group}]` : '';
  return `${entry.slash.padEnd(22)} ${entry.title} — ${entry.description}${groupSuffix}`;
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

/** Insert disabled group-header separators between groups when showing the full palette (query = '/'). */
function injectGroupSeparators<TValue>(
  entries: PaletteEntry<TValue>[],
): Array<{ name: string; value: TValue; disabled?: boolean }> {
  const result: Array<{ name: string; value: TValue; disabled?: boolean }> = [];
  let lastGroup = '';
  for (const entry of entries) {
    if (entry.group !== lastGroup) {
      result.push({ name: `── ${entry.group} ──`, value: entry.value, disabled: true });
      lastGroup = entry.group;
    }
    result.push({ name: renderPaletteLabel(entry), value: entry.value });
  }
  return result;
}

function shouldOfferTypedCommand(trimmedInput: string): boolean {
  return trimmedInput.startsWith('/');
}

export function buildMainActionChoices(input?: string): Array<{
  name: string;
  value: MainActionSelection;
  disabled?: boolean;
}> {
  const trimmed = (input ?? '').trim();
  const isShowAll = !trimmed || trimmed === '/';
  const matchedEntries = filterPaletteEntries(MAIN_ACTION_ENTRIES, input).slice(0, 12);

  let choices: Array<{ name: string; value: MainActionSelection; disabled?: boolean }>;

  if (isShowAll) {
    // Insert group separators between sections
    choices = injectGroupSeparators(matchedEntries).map((c) => ({
      ...c,
      value: (() => {
        if (c.disabled) return { kind: 'action', action: 'help' } satisfies MainActionSelection;
        const entry = matchedEntries.find((e) => renderPaletteLabel(e) === c.name);
        if (!entry) return { kind: 'action', action: 'help' } satisfies MainActionSelection;
        return entry.value === 'quit'
          ? ({ kind: 'quit' } satisfies MainActionSelection)
          : ({ kind: 'action', action: entry.value } satisfies MainActionSelection);
      })(),
    }));
  } else {
    choices = matchedEntries.map((entry) => ({
      name: renderPaletteLabel(entry),
      value: entry.value === 'quit'
        ? ({ kind: 'quit' } satisfies MainActionSelection)
        : ({ kind: 'action', action: entry.value } satisfies MainActionSelection),
    }));
  }

  if (trimmed && trimmed !== '/' && shouldOfferTypedCommand(trimmed)) {
    const preview = sanitizeTerminalText(trimmed, 96);
    choices.unshift({
      name: `Run typed command  ${preview}`,
      value: { kind: 'typed', commandLine: trimmed },
    });
  }

  return choices;
}

export function buildPostResultChoices(
  input?: string,
  command?: string,
): Array<{ name: string; value: PostResultAction; disabled?: boolean }> {
  const contextual = command ? buildContextualPostResultEntries(command) : [];
  const standard = filterPaletteEntries(POST_RESULT_ENTRIES, input).slice(0, 8);

  const filteredContextual = input && input !== '/'
    ? contextual.filter((e) => {
        const q = normalizePaletteQuery(input);
        const haystack = [e.title, e.description].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : contextual;

  const all = [...filteredContextual, ...standard];
  return all.map((entry) => ({ name: renderPaletteLabel(entry), value: entry.value }));
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
  recentFiles: string[] = [],
  tipKey?: string,
  tipCounter = 0,
): Promise<string> {
  const relativeFiles = allFiles
    .map((absPath) => normalizePath(path.relative(workspaceRoot, absPath)))
    .sort((left, right) => left.localeCompare(right));

  const tip = tipKey ? getTip(tipKey, tipCounter) : '';
  const tipLine = tip ? `\n  💡 ${tip}` : '';

  let currentDirectory = '';

  for (;;) {
    const choices = buildFileBrowserChoices(relativeFiles, currentDirectory, recentFiles);
    const location = currentDirectory || '.';
    const message = `Browse files (${location})${currentDirectory ? '' : tipLine}`;

    const selected = await select<string>({ message, choices });
    const next = await resolveFileBrowserSelection(selected, relativeFiles, currentDirectory);

    if (next.filePath !== undefined) return next.filePath;
    if (next.nextDirectory !== undefined) currentDirectory = next.nextDirectory;
  }
}

async function resolveFileBrowserSelection(
  selected: string,
  relativeFiles: string[],
  currentDirectory: string,
): Promise<{ filePath?: string; nextDirectory?: string }> {
  if (selected === '__jump__') {
    const jumpResult = await handleJumpSelection(relativeFiles, currentDirectory);
    return jumpResult;
  }

  if (selected === '__up__') {
    return { nextDirectory: parentDirectoryOf(currentDirectory) };
  }

  if (selected.startsWith('dir:')) {
    return { nextDirectory: selected.slice('dir:'.length) };
  }

  if (selected.startsWith('file:')) {
    return { filePath: selected.slice('file:'.length) };
  }

  // Disabled separators and unknown values — stay in current directory
  return { nextDirectory: currentDirectory };
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
  recentFiles: string[] = [],
): FileBrowserChoice[] {
  const { directories, files } = listDirectoryEntries(relativeFiles, currentDirectory);
  const choices: FileBrowserChoice[] = [
    {
      name: '⌨ Jump to path…',
      value: '__jump__',
    },
  ];

  // Recent files section (only show at root level)
  const visibleRecent = recentFiles.filter((f) => !currentDirectory || f.startsWith(`${currentDirectory}/`));
  if (visibleRecent.length > 0 && !currentDirectory) {
    choices.push({ name: '─── Recent ───', value: '__recent_sep__', disabled: true });
    for (const recentRel of visibleRecent) {
      const basename = recentRel.split('/').at(-1) ?? recentRel;
      choices.push({
        name: `★ ${sanitizeTerminalText(basename, 80)}  ${sanitizeTerminalText(recentRel, 160)}`,
        value: `file:${recentRel}`,
      });
    }
    choices.push({ name: '─── All files ───', value: '__all_sep__', disabled: true });
  }

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
    message: `Symbol to analyze in ${displayPath} · e.g. MyClass, processRequest, handleClick (leave empty for full-file)`,
    default: defaultSymbol,
  });
}

/**
 * Symbol selector with autocomplete when symbols are available.
 * Falls back to plain text input when the symbol list is empty.
 *
 * @param displayPath  - Relative path shown in the prompt label
 * @param symbols      - Candidate symbol names extracted from the file's AST (may be empty)
 * @param tipCounter   - Session tip counter for deterministic tip rotation
 * @param defaultSymbol - Pre-filled default (last used symbol)
 */
export async function selectOrInputSymbol(
  displayPath: string,
  symbols: string[],
  tipCounter = 0,
  defaultSymbol = '',
): Promise<string> {
  const tip = getTip('trace.symbol', tipCounter);
  const msgSuffix = tip ? `\n  💡 ${tip}` : '';

  if (symbols.length === 0) {
    return input({
      message: `Symbol to analyze in ${displayPath} · e.g. MyClass, handleClick (empty = full-file)${msgSuffix}`,
      default: defaultSymbol,
    });
  }

  const symbolChoices = [
    { name: '(full-file analysis)', value: '' },
    ...symbols.map((s) => ({ name: s, value: s })),
  ];

  return search<string>({
    message: `Symbol in ${displayPath} — type to filter · Enter for full-file${msgSuffix}`,
    source: async (inp) => {
      if (!inp) return symbolChoices;
      const q = inp.toLowerCase();
      return symbolChoices.filter((c) => c.name.toLowerCase().includes(q));
    },
  });
}

// ============================================================================
// Option configurators (always shown, Enter = accept pre-selected default)
// ============================================================================

export interface TraceOptions {
  maxDepth: number | undefined;
}

/**
 * Ask the user for trace depth. Pre-selects 10 (sensible default).
 * User can press Enter immediately to accept without thinking.
 */
export async function askTraceOptions(tipCounter = 0): Promise<TraceOptions> {
  const tip = getTip('trace.file', tipCounter);
  const msgSuffix = tip ? `\n  💡 ${tip}` : '';

  const depthValue = await select<string>({
    message: `Trace depth (Enter to accept default)${msgSuffix}`,
    choices: [
      { name: '3  — surface-level calls',    value: '3' },
      { name: '5  — moderate depth',         value: '5' },
      { name: '10 — standard (recommended)', value: '10' },
      { name: '20 — deep analysis',          value: '20' },
      { name: 'Unlimited — full traversal',  value: 'unlimited' },
    ],
    default: '10',
  });

  return { maxDepth: depthValue === 'unlimited' ? undefined : Number.parseInt(depthValue, 10) };
}

export interface ArchitectureOptions {
  maxFiles: number | undefined;
}

/**
 * Ask the user for the architecture file cap.
 * Pre-selects "All" — user can press Enter to accept.
 */
export async function askArchitectureOptions(tipCounter = 0): Promise<ArchitectureOptions> {
  const tip = getTip('architecture.start', tipCounter);
  const msgSuffix = tip ? `\n  💡 ${tip}` : '';

  const value = await select<string>({
    message: `Files to include in architecture map (Enter to accept default)${msgSuffix}`,
    choices: [
      { name: '100  — fast preview',          value: '100' },
      { name: '500  — medium workspace',       value: '500' },
      { name: 'All  — full workspace (recommended)', value: 'all' },
    ],
    default: 'all',
  });

  return { maxFiles: value === 'all' ? undefined : Number.parseInt(value, 10) };
}

export type CheckDepsDirection = 'both' | 'outgoing' | 'incoming';

export interface CheckDepsOptions {
  direction: CheckDepsDirection;
}

/**
 * Ask the user which dependency direction to analyse.
 * Pre-selects "Both" — user can press Enter to accept.
 */
export async function askCheckDepsOptions(tipCounter = 0): Promise<CheckDepsOptions> {
  const tip = getTip('checkDeps.file', tipCounter);
  const msgSuffix = tip ? `\n  💡 ${tip}` : '';

  const direction = await select<CheckDepsDirection>({
    message: `Dependency direction to analyze (Enter to accept default)${msgSuffix}`,
    choices: [
      { name: 'Both  — incoming + outgoing (recommended)', value: 'both' },
      { name: 'Outgoing only — what this file imports',    value: 'outgoing' },
      { name: 'Incoming only — who imports this file',     value: 'incoming' },
    ],
    default: 'both',
  });

  return { direction };
}

/** Post-result menu. Accepts the last command name to inject contextual follow-up suggestions. */
export async function selectPostResultAction(
  message = 'Type / for next actions',
  command?: string,
): Promise<PostResultAction> {
  return search<PostResultAction>({
    message,
    source: async (inp) => buildPostResultChoices(inp, command),
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
