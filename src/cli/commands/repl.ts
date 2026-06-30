/**
 * CLI Command: repl
 *
 * Guided interactive REPL. Launched when `graph-it` is invoked with no
 * arguments in a TTY context. Orchestrates existing CLI commands without
 * re-implementing analysis logic.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { ExitPromptError } from '@inquirer/core';
import { SourceFileCollector } from '../../analyzer/SourceFileCollector.js';
import { CLI_OUTPUT_FORMATS, formatOutput } from '../formatter.js';
import type { CliOutputFormat } from '../formatter.js';
import type { CliRuntime } from '../runtime.js';
import { normalizePathForComparison } from '../../shared/path.js';
import { loggerFactory, type LogLevel } from '../../shared/logger.js';
import { parseSymbolRef } from '../symbols.js';
import {
  confirmScan,
  inputCommandLine,
  inputQueryQuestion,
  inputWikiOutputDir,
  inputSavePath,
  searchDirectory,
  searchFile,
  selectOrInputSymbol,
  askTraceOptions,
  askArchitectureOptions,
  askCheckDepsOptions,
  type MainActionSelection,
  selectExportFormat,
  selectMainAction,
  selectPostResultAction,
  selectPreferredFormat,
} from '../repl/prompts.js';
import { createSessionState } from '../repl/sessionState.js';
import { sanitizeTerminalText } from '../repl/terminal.js';
import { tokenizeCommandLine } from '../repl/tokenize.js';
import { getTip, getPersonaTip } from '../repl/tips.js';
import { runInkReplSession, type InkReplCommandResponse } from '../repl/ink/ReplInkApp.js';

const VERSION = process.env.CLI_VERSION ?? '0.0.0-dev';

// ANSI helpers — skipped when NO_COLOR is set (https://no-color.org)
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const DIM = useColor ? '\x1b[2m' : '';
const BOLD = useColor ? '\x1b[1m' : '';
const RESET = useColor ? '\x1b[0m' : '';
const BLUE = useColor ? '\x1b[38;5;33m' : '';
const ORANGE = useColor ? '\x1b[38;5;214m' : '';
const SPARK = useColor ? '\x1b[38;5;117m' : '';

const NON_TTY_MESSAGE =
  'Interactive mode unavailable (no TTY).\n' +
  'Use direct commands: graph-it --help\n';

interface ReplActionResult {
  command: string;
  rawData?: unknown;
  output?: string;
  effectiveFormat?: CliOutputFormat;
  contextFile?: string;
  contextSymbol?: string;
  shouldQuit?: boolean;
  skipPostAction?: boolean;
}

interface TypedCommandOptions {
  uiMode: 'legacy' | 'ink';
}

const LEGACY_TYPED_COMMAND_OPTIONS: TypedCommandOptions = { uiMode: 'legacy' };
const INK_TYPED_COMMAND_OPTIONS: TypedCommandOptions = { uiMode: 'ink' };
type DependencyDirection = 'both' | 'outgoing' | 'incoming';

type ReplMainAction = 'trace' | 'command' | 'setPath' | 'checkDependencies' | 'cycles' | 'check' | 'summary' | 'architecture' | 'query' | 'format' | 'help';
type ReplStickyAction = 'architecture' | 'summary' | 'check';
type ReplFileAction = 'trace' | 'checkDependencies' | 'cycles';
type ReplRunner = (args: string[], runtime: CliRuntime, format: CliOutputFormat) => Promise<string>;

const REPL_TYPED_RUNNER_LOADERS = {
  architecture: () => import('./architecture.js'),
  summary: () => import('./summary.js'),
  check: () => import('./check.js'),
  path: () => import('./path.js'),
  pathIn: () => import('./pathIn.js'),
  checkDependencies: () => import('./checkDependencies.js'),
  cycles: () => import('./cycles.js'),
  trace: () => import('./trace.js'),
  explain: () => import('./explain.js'),
  scan: () => import('./scan.js'),
  query: () => import('./query.js'),
  wiki: () => import('./wiki.js'),
} satisfies Record<string, () => Promise<{ run: ReplRunner }>>;

function resolveTypedRunnerKey(command: string): keyof typeof REPL_TYPED_RUNNER_LOADERS | undefined {
  if (command === 'path-in' || command === 'path-out' || command === 'deps-in' || command === 'deps-out') {
    return 'checkDependencies';
  }
  if (command === 'check-dependencies' || command === 'deps' || command === 'dependencies') {
    return 'checkDependencies';
  }
  if (command === 'cycles' || command === 'cycle') {
    return 'cycles';
  }
  if (command === 'q' || command === 'search') {
    return 'query';
  }
  if (command === 'docs' || command === 'documentation') {
    return 'wiki';
  }
  if (command in REPL_TYPED_RUNNER_LOADERS) {
    return command as keyof typeof REPL_TYPED_RUNNER_LOADERS;
  }
  return undefined;
}

function buildBanner(): string {
  return [
    '',
    `  ${BLUE}●${RESET}${DIM}─${RESET}${BLUE}■${RESET}   ${BOLD}Graph-It-Live${RESET} ${DIM}v${VERSION}${RESET} ${SPARK}✦${RESET}`,
    `  ${BLUE}│${RESET} ${DIM}╲${RESET}   ${DIM}Type / to browse commands, or press Enter to search the palette${RESET}`,
    `  ${BLUE}●${RESET}${DIM}─${RESET}${ORANGE}■${RESET}   ${DIM}Dependency & architecture explorer · Ctrl+C to quit${RESET}`,
    '',
  ].join('\n');
}

function buildReplHelpText(state: ReturnType<typeof createSessionState>): string {
  const lastFile = state.lastFile ? path.relative(state.workspaceRoot, state.lastFile) : 'none';
  return [
    `${BOLD}Slash commands${RESET}`,
    '  /trace          Select a file, then optionally a symbol to trace',
    '  /path           Set workspace directory scope (browse or explicit)',
    '  /file           Set active file context (browse or explicit)',
    '  /check-dependencies  Check incoming and outgoing dependencies',
    '  /cycles         List confirmed dependency cycles for a file',
    '  /summary        Summarize the current file or whole workspace',
    '  /architecture   Build the workspace graph',
    '  /check          Find unused exports',
    '  /query          Query the codebase with natural language',
    '  /wiki           Generate a markdown wiki from the call graph',
    '  /export --format html   Export graph as standalone HTML (vis.js)',
    '  /format         Change the default display format',
    '  /command        Run a raw CLI command line',
    '  /help           Show this help',
    '  /quit           Exit the REPL',
    '',
    `${DIM}Examples:${RESET}`,
    '  /path src/cli',
    '  /file src/cli/index.ts',
    '  /check-dependencies',
    '  /cycles src/cli/index.ts',
    '  /trace src/index.ts#main',
    '  /architecture --format mermaid',
    '  /export --format html --output my-graph.html',
    '',
    `${DIM}session:${RESET} format=${state.preferredFormat}  last-file=${lastFile}`,
  ].join('\n');
}

function normalizeSelection(
  selection: Awaited<ReturnType<typeof selectMainAction>> | MainActionSelection | ReplMainAction | 'quit',
): MainActionSelection {
  if (typeof selection !== 'string') {
    return selection;
  }

  if (selection === 'quit') {
    return { kind: 'quit' };
  }

  return { kind: 'action', action: selection };
}

function normalizeSlashCommand(command: string): string {
  return command.startsWith('/') ? command.slice(1) : command;
}

function formatTerminalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(message, 240);
}

function formatStatusValue(value: string | undefined): string {
  return sanitizeTerminalText(value ?? 'none', 120);
}

function buildPromptChrome(state: ReturnType<typeof createSessionState>): string {
  const relFile = state.lastFile
    ? path.relative(state.workspaceRoot, state.lastFile)
    : 'none';
  const symbol = state.lastSymbol ?? 'none';
  const generalTip = getTip('general', state.tipCounter);
  const personaTip = getPersonaTip(state.tipCounter);

  return [
    buildBanner(),
    `${DIM}workspace:${RESET} ${formatStatusValue(state.workspaceRoot)}  ${DIM}format:${RESET} ${state.preferredFormat}  ${DIM}last file:${RESET} ${formatStatusValue(relFile)}  ${DIM}last symbol:${RESET} ${formatStatusValue(symbol)}`,
    `${DIM}tip:${RESET} ${generalTip}`,
    `${DIM}    ${personaTip}${RESET}`,
  ].join('\n');
}

async function runQuietlyDuringBootstrap<T>(work: () => Promise<T>): Promise<T> {
  const previousLevel: LogLevel = loggerFactory.getDefaultLevel();
  loggerFactory.setDefaultLevel('none');
  try {
    return await work();
  } finally {
    loggerFactory.setDefaultLevel(previousLevel);
  }
}

/**
 * Entry point for the REPL.
 *
 * `runtime` is already constructed but NOT yet `init()`ed — this function
 * handles init itself so it can offer a guided scan on first use.
 */
export async function run(runtime: CliRuntime): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stdout.write(NON_TTY_MESSAGE);
    return;
  }

  try {
    await runQuietlyDuringBootstrap(() => runtime.init());
  } catch {
    process.stderr.write('Workspace not found or not accessible.\n');
    return;
  }

  try {
    await runQuietlyDuringBootstrap(() => runtime.ensureIndexed({ silent: true }));
  } catch {
    const doScan = await confirmScan('Index missing or stale.').catch(() => false);
    if (!doScan) {
      process.stdout.write('Goodbye!\n');
      return;
    }
    try {
      await runQuietlyDuringBootstrap(() => runtime.ensureIndexed({ silent: true }));
    } catch (err) {
      process.stderr.write(
        `Scan error: ${formatTerminalError(err)}\n`,
      );
      return;
    }
  }

  const collector = new SourceFileCollector({ excludeNodeModules: true });
  let allFiles = await runQuietlyDuringBootstrap(
    () => collector.collectAllSourceFiles(runtime.workspaceRoot),
  );
  const state = createSessionState(runtime.workspaceRoot);
  const useLegacyUi = process.env.GRAPH_IT_REPL_LEGACY === '1' || Boolean(process.env.VITEST);

  if (useLegacyUi) {
    let quit = false;
    while (!quit) {
      quit = await runOneCycle(runtime, state, allFiles);
    }
  } else {
    await runInkReplSession({
      version: VERSION,
      workspaceRoot: state.workspaceRoot,
      allFiles,
      preferredFormat: state.preferredFormat,
      lastFile: state.lastFile,
      lastSymbol: state.lastSymbol,
      onSubmitCommand: async (commandLine: string) => {
        const prevWorkspaceRoot = state.workspaceRoot;
        const prevLastFile = state.lastFile;
        const prevLastSymbol = state.lastSymbol;

        const result = await runTypedCommandLine(
          runtime,
          state,
          state.preferredFormat,
          commandLine,
          allFiles,
          INK_TYPED_COMMAND_OPTIONS,
        );

        applyResultToSession(state, result, false);

        const response: InkReplCommandResponse = {
          command: result.command,
          output: result.output
            ? stripSavedOutputNoise(result.output, result.effectiveFormat)
            : undefined,
          shouldQuit: result.shouldQuit,
        };

        // Propagate state changes back to the REPL for display/autocomplete
        const workspaceChanged = state.workspaceRoot !== prevWorkspaceRoot;
        const lastFileChanged = state.lastFile !== prevLastFile;
        const lastSymbolChanged = state.lastSymbol !== prevLastSymbol;
        if (workspaceChanged || lastFileChanged || lastSymbolChanged) {
          response.updatedContext = {};
          if (workspaceChanged) {
            const newAllFiles = await collector.collectAllSourceFiles(state.workspaceRoot);
            allFiles = newAllFiles;
            response.updatedContext.workspaceRoot = state.workspaceRoot;
            response.updatedContext.allFiles = newAllFiles;
          }
          if (lastFileChanged) {
            response.updatedContext.lastFile = state.lastFile ?? null;
          }
          if (lastSymbolChanged) {
            response.updatedContext.lastSymbol = state.lastSymbol ?? null;
          }
        }

        return response;
      },
    });
  }

  process.stdout.write('\nGoodbye!\n');
}

function isPathInsideWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, resolvedPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function findNearestExistingParent(targetDir: string): Promise<string> {
  let current = targetDir;
  for (;;) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error('No existing parent directory found for save path.');
      }
      current = parent;
    }
  }
}

async function isSafeWorkspaceWritePath(
  targetPath: string,
  workspaceRoot: string,
): Promise<boolean> {
  if (!isPathInsideWorkspace(targetPath, workspaceRoot)) {
    return false;
  }

  const realWorkspaceRoot = normalizePathForComparison(
    await fs.realpath(workspaceRoot),
  );
  const existingParent = await findNearestExistingParent(path.dirname(targetPath));
  const realParent = normalizePathForComparison(await fs.realpath(existingParent));

  // Both paths are normalised (forward slashes only), so path.sep check is redundant.
  return (
    realParent === realWorkspaceRoot ||
    realParent.startsWith(`${realWorkspaceRoot}/`)
  );
}

function parseRawCommandOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

async function executeCommandForRepl(
  command: string,
  args: string[],
  runtime: CliRuntime,
  preferredFormat: CliOutputFormat,
  runner: (args: string[], runtime: CliRuntime, format: CliOutputFormat) => Promise<string>,
): Promise<Pick<ReplActionResult, 'command' | 'rawData' | 'output' | 'effectiveFormat'>> {
  const jsonOutput = await runner(args, runtime, 'json');
  const rawData = parseRawCommandOutput(jsonOutput);

  try {
    const output = formatOutput(rawData, preferredFormat, command);
    return { command, rawData, output, effectiveFormat: preferredFormat };
  } catch {
    const output = formatOutput(rawData, 'text', command);
    return { command, rawData, output, effectiveFormat: 'text' };
  }
}

function applyResultToSession(
  state: ReturnType<typeof createSessionState>,
  result: ReplActionResult,
  emitOutput = true,
): void {
  state.lastFile = result.contextFile;
  state.lastSymbol = result.contextSymbol;
  state.tipCounter += 1;

  // Track recently-visited files (deduped, newest first, max 5)
  if (result.contextFile) {
    const relFile = path.relative(state.workspaceRoot, result.contextFile);
    state.recentFiles = [
      relFile,
      ...state.recentFiles.filter((f) => f !== relFile),
    ].slice(0, 5);
  }

  if (result.output) {
    state.lastResult = result.rawData ?? result.output;
    if (emitOutput) {
      const sanitizedOutput = stripSavedOutputNoise(result.output, result.effectiveFormat);
      process.stdout.write(sanitizedOutput.endsWith('\n') ? sanitizedOutput : `${sanitizedOutput}\n`);
    }
  }

  if (result.effectiveFormat && result.effectiveFormat !== state.preferredFormat) {
    process.stdout.write(
      `Rendered in ${result.effectiveFormat} (default ${state.preferredFormat} unsupported for this command).\n`,
    );
  }
}

async function runTypedCommandFromPrompt(
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
  allFiles: string[],
): Promise<ReplActionResult> {
  const commandLine = await inputCommandLine(state.lastCommandLine ?? '');
  return runTypedCommandLine(
    runtime,
    state,
    preferredFormat,
    commandLine,
    allFiles,
    LEGACY_TYPED_COMMAND_OPTIONS,
  );
}

async function runTypedCommandLine(
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
  commandLine: string,
  allFiles: string[],
  options?: TypedCommandOptions,
): Promise<ReplActionResult> {
  const resolvedOptions = options ?? LEGACY_TYPED_COMMAND_OPTIONS;
  const trimmedCommandLine = commandLine.trim();
  const parsed = tokenizeCommandLine(trimmedCommandLine);
  const tokens = parsed.tokens;

  if (parsed.error) {
    return {
      command: 'command',
      output: `Invalid command line: ${sanitizeTerminalText(parsed.error)}`,
      skipPostAction: true,
    };
  }

  if (tokens.length === 0) {
    return {
      command: 'command',
      output: 'Empty command. Try: path src/index.ts --format mermaid',
    };
  }

  if (tokens[0] === 'graph-it') {
    tokens.shift();
  }

  const [command, ...rawArgs] = tokens;
  const normalizedCommand = command ? normalizeSlashCommand(command) : '';
  if (!normalizedCommand) {
    return {
      command: 'command',
      output: 'No command provided after graph-it prefix.',
      skipPostAction: true,
    };
  }

  const { effectiveFormat, cleanedArgs, invalidFormatValue } = extractFormatOverride(rawArgs, preferredFormat);
  state.lastCommandLine = trimmedCommandLine;
  const contextualArgs = rebaseTypedArgs(
    normalizedCommand,
    applyImplicitFileContext(normalizedCommand, cleanedArgs, state),
    state,
  );

  if (invalidFormatValue) {
    process.stdout.write(
      `Unknown format "${sanitizeTerminalText(invalidFormatValue)}". Valid formats: ${CLI_OUTPUT_FORMATS.join(', ')}. Using ${effectiveFormat}.
`,
    );
  }

  const sessionCommand = await handleTypedSessionCommand(
    normalizedCommand,
    contextualArgs,
    state,
    runtime,
    allFiles,
    resolvedOptions,
  );
  if (sessionCommand) {
    return sessionCommand;
  }

  if (resolvedOptions.uiMode === 'ink') {
    const guidedResult = await runInkGuidedCommand(
      normalizedCommand,
      contextualArgs,
      runtime,
      state,
      effectiveFormat,
    );
    if (guidedResult) {
      return guidedResult;
    }
  }

  const runnerKey = resolveTypedRunnerKey(normalizedCommand);
  const runnerLoader = runnerKey ? REPL_TYPED_RUNNER_LOADERS[runnerKey] : undefined;
  if (runnerKey && runnerLoader) {
    const { run } = await runnerLoader();
    const commandLabel = runnerKey === 'checkDependencies'
      ? 'check-dependencies'
      : runnerKey;
    return executeCommandForRepl(
      commandLabel,
      normalizeTypedRunnerArgs(commandLabel, contextualArgs),
      runtime,
      effectiveFormat,
      run,
    );
  }

  return {
    command: normalizedCommand,
    output: `Unknown REPL command "${sanitizeTerminalText(normalizedCommand)}". Try: /path, /file, /check-dependencies, /cycles, /summary, /check, /trace, /query, /format, /help.`,
    skipPostAction: true,
  };
}

async function handleTypedSessionCommand(
  command: string,
  args: string[],
  state: ReturnType<typeof createSessionState>,
  runtime: CliRuntime,
  allFiles: string[],
  options: TypedCommandOptions,
): Promise<ReplActionResult | undefined> {
  if (command === 'help') {
    return {
      command: 'help',
      output: buildReplHelpText(state),
      skipPostAction: true,
    };
  }

  if (command === 'quit') {
    return { command: 'quit', shouldQuit: true, skipPostAction: true };
  }

  if (command === 'path') {
    return handlePathSessionCommand(args, state, runtime, allFiles, options);
  }

  if (command === 'export' && args.includes('--format') && args[args.indexOf('--format') + 1] === 'html') {
    const workspaceName = path.basename(runtime.workspaceRoot);
    const { runExportHtml } = await import('./ExportHtmlCommand.js');
    await runExportHtml(runtime, workspaceName, args);
    return { command: 'export', skipPostAction: true };
  }

  if (command !== 'format') {
    if (command !== 'file') {
      return undefined;
    }
    return handleFileSessionCommand(args, state, runtime, allFiles, options);
  }

  const requestedFormat = args[0];
  if (requestedFormat && CLI_OUTPUT_FORMATS.includes(requestedFormat as CliOutputFormat)) {
    state.preferredFormat = requestedFormat as CliOutputFormat;
  } else if (requestedFormat) {
    return {
      command: 'format',
      output: `Unknown format "${sanitizeTerminalText(requestedFormat)}". Valid formats: ${CLI_OUTPUT_FORMATS.join(', ')}`,
      skipPostAction: true,
    };
  } else if (options.uiMode === 'legacy') {
    state.preferredFormat = await selectPreferredFormat(state.preferredFormat);
  } else {
    return {
      command: 'format',
      output: `Current format: ${state.preferredFormat}. Set a value explicitly, e.g. /format markdown. Valid formats: ${CLI_OUTPUT_FORMATS.join(', ')}`,
      skipPostAction: true,
    };
  }

  return {
    command: 'format',
    output: `Default format set to ${state.preferredFormat}.`,
    skipPostAction: true,
  };
}

function applyWorkspaceScope(
  state: ReturnType<typeof createSessionState>,
  runtime: CliRuntime,
  nextWorkspace: string,
): ReplActionResult {
  state.workspaceRoot = nextWorkspace;
  state.lastFile = undefined;
  state.lastSymbol = undefined;

  return {
    command: 'path',
    output: `Session workspace set to ${path.relative(runtime.workspaceRoot, state.workspaceRoot) || '.'}.`,
    skipPostAction: true,
  };
}

async function handlePathSessionCommand(
  args: string[],
  state: ReturnType<typeof createSessionState>,
  runtime: CliRuntime,
  allFiles: string[],
  options: TypedCommandOptions,
): Promise<ReplActionResult> {
  let targetDirectory: string;
  if (args[0]) {
    targetDirectory = path.isAbsolute(args[0])
      ? path.resolve(args[0])
      : path.resolve(state.workspaceRoot, args[0]);
  } else if (options.uiMode === 'ink') {
    return {
      command: 'path',
      output: `Current workspace scope: ${path.relative(runtime.workspaceRoot, state.workspaceRoot) || '.'}. Usage: /path <directory>`,
      skipPostAction: true,
    };
  } else {
    const selectedRelativeDirectory = await searchDirectory(
      getScopedFiles(allFiles, state.workspaceRoot),
      state.workspaceRoot,
    );
    targetDirectory = path.resolve(state.workspaceRoot, selectedRelativeDirectory || '.');
  }

  if (!isWithinRoot(targetDirectory, runtime.workspaceRoot)) {
    return {
      command: 'path',
      output: 'Refusing to set workspace scope outside project root.',
      skipPostAction: true,
    };
  }

  const stats = await fs.stat(targetDirectory).catch(() => undefined);
  if (!stats?.isDirectory()) {
    return {
      command: 'path',
      output: `Directory not found: ${sanitizeTerminalText(args[0] ?? '', 140)}`,
      skipPostAction: true,
    };
  }

  return applyWorkspaceScope(state, runtime, targetDirectory);
}

async function handleFileSessionCommand(
  args: string[],
  state: ReturnType<typeof createSessionState>,
  runtime: CliRuntime,
  allFiles: string[],
  options: TypedCommandOptions,
): Promise<ReplActionResult> {
  if (!args[0] && options.uiMode === 'ink') {
    return {
      command: 'file',
      output: state.lastFile
        ? `Current file context: ${path.relative(runtime.workspaceRoot, state.lastFile)}. Usage: /file <path>`
        : 'No file context set. Usage: /file <path>',
      skipPostAction: true,
    };
  }

  const resolvedFile = args[0]
    ? parseSymbolRef(args[0], state.workspaceRoot).filePath
    : path.resolve(
      state.workspaceRoot,
      await searchFile(getScopedFiles(allFiles, state.workspaceRoot), state.workspaceRoot),
    );

  state.lastFile = resolvedFile;
  state.lastSymbol = undefined;

  return {
    command: 'file',
    output: `Current file context set to ${path.relative(runtime.workspaceRoot, resolvedFile)}.`,
    contextFile: resolvedFile,
    skipPostAction: true,
  };
}

function parseFormatValue(
  value: string,
): { override: CliOutputFormat } | { invalid: string } | null {
  if (!value) return null;
  if (CLI_OUTPUT_FORMATS.includes(value as CliOutputFormat)) {
    return { override: value as CliOutputFormat };
  }
  return { invalid: value };
}

function readFormatFlag(
  arg: string,
  nextArg: string | undefined,
): { parsed: { override: CliOutputFormat } | { invalid: string }; skipNextArg: boolean } | undefined {
  if (arg === '--format' || arg === '-f') {
    return {
      parsed: parseFormatValue(nextArg ?? '') ?? { invalid: '(missing value)' },
      skipNextArg: true,
    };
  }

  if (!arg.startsWith('--format=')) {
    return undefined;
  }

  return {
    parsed: parseFormatValue(arg.slice('--format='.length)) ?? { invalid: '(missing value)' },
    skipNextArg: false,
  };
}

function applyImplicitFileContext(
  command: string,
  args: string[],
  state: ReturnType<typeof createSessionState>,
): string[] {
  if (args.length > 0) return args;
  if (!state.lastFile) return args;
  if (command !== 'summary' && command !== 'check' && command !== 'check-dependencies' && command !== 'cycles') return args;
  return [state.lastFile];
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getScopedFiles(allFiles: string[], workspaceScope: string): string[] {
  return allFiles.filter((filePath) => isWithinRoot(filePath, workspaceScope));
}

function resolveScopedFileArg(command: string, firstArg: string, state: ReturnType<typeof createSessionState>): string {
  if (command === 'trace') {
    const parsed = parseSymbolRef(firstArg, state.workspaceRoot);
    return parsed.symbolName ? `${parsed.filePath}#${parsed.symbolName}` : parsed.filePath;
  }

  if (command === 'check-dependencies' || command === 'cycles') {
    return parseSymbolRef(firstArg, state.workspaceRoot).filePath;
  }

  return firstArg;
}

function rebaseTypedArgs(
  command: string,
  args: string[],
  state: ReturnType<typeof createSessionState>,
): string[] {
  if (args.length === 0) {
    return args;
  }

  const fileLikeCommands = new Set(['trace', 'check-dependencies', 'cycles']);
  if (!fileLikeCommands.has(command)) {
    return args;
  }

  return [resolveScopedFileArg(command, args[0], state), ...args.slice(1)];
}

function extractFormatOverride(
  args: string[],
  preferredFormat: CliOutputFormat,
): { effectiveFormat: CliOutputFormat; cleanedArgs: string[]; invalidFormatValue?: string } {
  const cleanedArgs: string[] = [];
  let override: CliOutputFormat | undefined;
  let invalidFormatValue: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    const formatFlag = readFormatFlag(arg, args[i + 1]);
    if (formatFlag) {
      if ('override' in formatFlag.parsed) override = formatFlag.parsed.override;
      else invalidFormatValue = formatFlag.parsed.invalid;
      if (formatFlag.skipNextArg) {
        i += 1;
      }
      continue;
    }

    cleanedArgs.push(arg);
  }

  return { effectiveFormat: override ?? preferredFormat, cleanedArgs, invalidFormatValue };
}

function extractTraceDepthArg(args: string[]): { cleanedArgs: string[]; maxDepth?: number } {
  const cleanedArgs: string[] = [];
  let maxDepth: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--maxDepth' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        maxDepth = parsed;
      }
      i += 1;
      continue;
    }

    if (arg.startsWith('--maxDepth=')) {
      const parsed = Number.parseInt(arg.slice('--maxDepth='.length), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        maxDepth = parsed;
      }
      continue;
    }

    cleanedArgs.push(arg);
  }

  return { cleanedArgs, maxDepth };
}

function extractDepsDirectionArg(args: string[]): { cleanedArgs: string[]; direction: DependencyDirection } {
  const cleanedArgs: string[] = [];
  let direction: DependencyDirection = 'both';

  for (const arg of args) {
    if (arg === '--incoming' || arg === '--in') {
      direction = 'incoming';
      continue;
    }
    if (arg === '--outgoing' || arg === '--out') {
      direction = 'outgoing';
      continue;
    }
    if (arg === '--both') {
      direction = 'both';
      continue;
    }
    cleanedArgs.push(arg);
  }

  return { cleanedArgs, direction };
}

function normalizeTypedRunnerArgs(command: string, args: string[]): string[] {
  if (command !== 'architecture') {
    return args;
  }

  const normalized: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--maxFiles=')) {
      const value = arg.slice('--maxFiles='.length);
      normalized.push('--maxFiles', value);
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

async function runInkGuidedCommand(
  command: string,
  args: string[],
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult | undefined> {
  if (command === 'trace') {
    return runInkGuidedTrace(args, runtime, state, preferredFormat);
  }

  if (command === 'check-dependencies' || command === 'deps' || command === 'dependencies') {
    return runInkGuidedCheckDependencies(args, runtime, state, preferredFormat);
  }

  return undefined;
}

async function runInkGuidedTrace(
  args: string[],
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  const { cleanedArgs, maxDepth } = extractTraceDepthArg(args);
  const target = cleanedArgs[0] ?? buildDefaultTraceTarget(state);
  if (!target) {
    return {
      command: 'trace',
      output: 'Trace needs a file context. Usage: /trace <file#Symbol> or set a file with /file <path>.',
      skipPostAction: true,
    };
  }

  return runTraceOrExplainForTarget(target, maxDepth, runtime, state, preferredFormat);
}

function buildDefaultTraceTarget(state: ReturnType<typeof createSessionState>): string | undefined {
  if (!state.lastFile) return undefined;
  if (state.lastSymbol) return `${state.lastFile}#${state.lastSymbol}`;
  return state.lastFile;
}

async function runTraceOrExplainForTarget(
  target: string,
  maxDepth: number | undefined,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  const parsed = parseSymbolRef(target, state.workspaceRoot);
  if (parsed.symbolName) {
    const traceArgs = [`${parsed.filePath}#${parsed.symbolName}`];
    if (maxDepth !== undefined) {
      traceArgs.push('--maxDepth', String(maxDepth));
    }
    const { run } = await import('./trace.js');
    const result = await executeCommandForRepl('trace', traceArgs, runtime, preferredFormat, run);
    return { ...result, contextFile: parsed.filePath, contextSymbol: parsed.symbolName };
  }

  const { run } = await import('./explain.js');
  const result = await executeCommandForRepl('explain', [parsed.filePath], runtime, preferredFormat, run);
  return { ...result, contextFile: parsed.filePath };
}

async function runInkGuidedCheckDependencies(
  args: string[],
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  const { cleanedArgs, direction } = extractDepsDirectionArg(args);
  const fileArg = cleanedArgs[0] ?? state.lastFile;
  if (!fileArg) {
    return {
      command: 'check-dependencies',
      output: 'check-dependencies needs a file path. Usage: /check-dependencies <file> [--incoming|--outgoing|--both]',
      skipPostAction: true,
    };
  }

  const absoluteFile = parseSymbolRef(fileArg, state.workspaceRoot).filePath;
  return runCheckDepsWithDirection(direction, absoluteFile, runtime, preferredFormat);
}

function getDefaultSaveExtension(format: CliOutputFormat | undefined): string {
  switch (format) {
    case 'mermaid':
      return '.mmd';
    case 'json':
      return '.json';
    case 'toon':
      return '.toon';
    case 'markdown':
      return '.md';
    case 'text':
    default:
      return '.txt';
  }
}

function buildDefaultSavePathForFormat(command: string, format: CliOutputFormat | undefined): string {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const extension = getDefaultSaveExtension(format);
  return path.join('.graph-it', 'exports', `${stamp}-${command}${extension}`);
}

function stripSavedOutputNoise(content: string, format: CliOutputFormat | undefined): string {
  if (format !== 'mermaid' && format !== 'json' && format !== 'toon') {
    return content;
  }

  const cleaned = content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('%% output truncated')) return false;
      if (/^PARSING ERROR\b/i.test(trimmed)) return false;
      return true;
    })
    .join('\n');

  return cleaned;
}

async function runOneCycle(
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  allFiles: string[],
): Promise<boolean> {
  const selection = normalizeSelection(
    await selectMainActionWithRecovery(buildPromptChrome(state)),
  );
  if (selection.kind === 'quit') return true;

  try {
    const result = await runAction(selection, runtime, state, allFiles);
    applyResultToSession(state, result);
    if (result.shouldQuit) return true;
    if (result.skipPostAction) return false;
    return await handlePostResult(
      result.rawData,
      result.output,
      result.effectiveFormat,
      result.command,
      runtime,
      state,
      result.contextFile,
    );
  } catch (err) {
    if (err instanceof ExitPromptError) return true;
    process.stderr.write(`Error: ${formatTerminalError(err)}\n`);
    return false;
  }
}

async function selectMainActionWithRecovery(
  promptMessage: string,
): Promise<Awaited<ReturnType<typeof selectMainAction>>> {
  try {
    return await selectMainAction(promptMessage);
  } catch (err) {
    if (err instanceof ExitPromptError) {
      return { kind: 'quit' };
    }
    process.stderr.write(`Unexpected error: ${formatTerminalError(err)}\n`);
    return { kind: 'quit' };
  }
}

async function handleFollowUpAction(
  postAction: string,
  contextFile: string | undefined,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
): Promise<void> {
  const fileForFollowUp = contextFile ?? state.lastFile;

  if (postAction === 'followUpDeps' && fileForFollowUp) {
    const result = await runFileDrivenActionFor('checkDependencies', fileForFollowUp, runtime, state, state.preferredFormat);
    applyResultToSession(state, result);
    return;
  }

  if (postAction === 'followUpCycles' && fileForFollowUp) {
    const result = await runFileDrivenActionFor('cycles', fileForFollowUp, runtime, state, state.preferredFormat);
    applyResultToSession(state, result);
    return;
  }

  if (postAction === 'followUpTrace' && fileForFollowUp) {
    const result = await runFileDrivenActionForTrace(fileForFollowUp, runtime, state, state.preferredFormat);
    applyResultToSession(state, result);
    return;
  }

  if (postAction === 'followUpDeadCode') {
    const result = await runStickyContextAction('check', runtime, state, state.preferredFormat);
    applyResultToSession(state, result);
    return;
  }

  if (postAction === 'followUpArchitecture') {
    const result = await runStickyContextAction('architecture', runtime, state, state.preferredFormat);
    applyResultToSession(state, result);
  }
}

async function handlePostResult(
  rawData: unknown,
  output: string | undefined,
  effectiveFormat: CliOutputFormat | undefined,
  command: string,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  contextFile: string | undefined,
): Promise<boolean> {
  const resultTip = getTip(`result.${command}`, state.tipCounter);
  const tipSuffix = resultTip ? `\n${DIM}  💡 ${resultTip}${RESET}` : '';

  let postAction: Awaited<ReturnType<typeof selectPostResultAction>>;
  try {
    postAction = await selectPostResultAction(
      `${buildPromptChrome(state)}\n${DIM}current result:${RESET} ${sanitizeTerminalText(command, 40)}\n${DIM}tip:${RESET} Type ${BOLD}/${RESET} for follow-up actions.${tipSuffix}`,
      command,
    );
  } catch (err) {
    if (err instanceof ExitPromptError) return true;
    throw err;
  }

  if (postAction === 'quit') return true;

  if (postAction === 'export' && rawData !== undefined) {
    await handleExport(rawData, command);
  }

  if (postAction === 'saveToFile' && output) {
    await handleSaveToFile(output, command, runtime.workspaceRoot, rawData, effectiveFormat);
  }

  if (postAction === 'setFormat') {
    state.preferredFormat = await selectPreferredFormat(state.preferredFormat);
    process.stdout.write(`Default format set to ${state.preferredFormat}.\n`);
  }

  if (postAction === 'drillDown') {
    const drillDownFile = contextFile ?? state.lastFile;
    if (!drillDownFile) {
      process.stdout.write('Drill-down unavailable for this result (no file context).\n');
      return false;
    }
    await handleDrillDown(drillDownFile, runtime, state);
  }

  // Context-aware follow-up actions — delegated to helper to keep complexity low
  await handleFollowUpAction(postAction, contextFile, runtime, state);

  return false;
}

async function runAction(
  selection: MainActionSelection,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  allFiles: string[],
): Promise<ReplActionResult> {
  if (selection.kind === 'typed') {
    return runTypedCommandLine(
      runtime,
      state,
      state.preferredFormat,
      selection.commandLine ?? '',
      allFiles,
      LEGACY_TYPED_COMMAND_OPTIONS,
    );
  }

  const action = selection.action;
  const preferredFormat: CliOutputFormat = state.preferredFormat;

  if (!action) {
    return {
      command: 'help',
      output: buildReplHelpText(state),
      skipPostAction: true,
    };
  }

  if (action === 'command') {
    return runTypedCommandFromPrompt(runtime, state, preferredFormat, allFiles);
  }

  if (action === 'setPath') {
    const scopedFiles = getScopedFiles(allFiles, state.workspaceRoot);
    const selectedRelativeDirectory = await searchDirectory(scopedFiles, state.workspaceRoot);
    const nextWorkspace = path.resolve(state.workspaceRoot, selectedRelativeDirectory || '.');

    if (!isWithinRoot(nextWorkspace, runtime.workspaceRoot)) {
      return {
        command: 'path',
        output: 'Refusing to set workspace scope outside project root.',
        skipPostAction: true,
      };
    }

    state.workspaceRoot = nextWorkspace;
    state.lastFile = undefined;
    state.lastSymbol = undefined;

    return {
      command: 'path',
      output: `Session workspace set to ${path.relative(runtime.workspaceRoot, state.workspaceRoot) || '.'}.`,
      skipPostAction: true,
    };
  }

  if (action === 'format') {
    state.preferredFormat = await selectPreferredFormat(state.preferredFormat);
    return {
      command: 'format',
      output: `Default format set to ${state.preferredFormat}.`,
      skipPostAction: true,
    };
  }

  if (action === 'help') {
    return {
      command: 'help',
      output: buildReplHelpText(state),
      skipPostAction: true,
    };
  }

  if (action === 'query') {
    const question = await inputQueryQuestion();
    if (!question.trim()) {
      return {
        command: 'query',
        output: 'No question provided. Try: /query "how does Spider crawl files"',
        skipPostAction: true,
      };
    }
    return executeCommandForRepl('query', [question], runtime, preferredFormat, (await import('./query.js')).run);
  }

  if (action === 'wiki') {
    const outputDir = await inputWikiOutputDir();
    return executeCommandForRepl('wiki', outputDir ? ['--output', outputDir] : [], runtime, preferredFormat, (await import('./wiki.js')).run);
  }

  if (action === 'architecture' || action === 'summary' || action === 'check') {
    return runStickyContextAction(action, runtime, state, preferredFormat);
  }

  if (action === 'quit') {
    return { command: 'quit', shouldQuit: true, skipPostAction: true };
  }

  return runFileDrivenAction(action, runtime, state, allFiles, preferredFormat);
}

async function runStickyContextAction(
  action: ReplStickyAction,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  const actionConfig: Record<
    ReplStickyAction,
    {
      command: 'architecture' | 'summary' | 'check';
      getArgs: () => Promise<string[]> | string[];
      loadRunner: () => Promise<{
        run: (args: string[], rt: CliRuntime, fmt: CliOutputFormat) => Promise<string>;
      }>;
    }
  > = {
    architecture: {
      command: 'architecture',
      getArgs: async () => {
        const opts = await askArchitectureOptions(state.tipCounter);
        if (opts.maxFiles !== undefined) return [`--maxFiles=${opts.maxFiles}`];
        return [];
      },
      loadRunner: () => import('./architecture.js'),
    },
    summary: {
      command: 'summary',
      getArgs: () => (state.lastFile ? [state.lastFile] : []),
      loadRunner: () => import('./summary.js'),
    },
    check: {
      command: 'check',
      getArgs: () => (state.lastFile ? [state.lastFile] : []),
      loadRunner: () => import('./check.js'),
    },
  };

  const config = actionConfig[action];
  const { run } = await config.loadRunner();
  const args = await config.getArgs();
  const result = await executeCommandForRepl(
    config.command,
    args,
    runtime,
    preferredFormat,
    run,
  );

  return {
    ...result,
    contextFile: state.lastFile,
    contextSymbol: state.lastSymbol,
  };
}

async function runFileDrivenAction(
  action: ReplFileAction,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  allFiles: string[],
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  const scopedFiles = getScopedFiles(allFiles, state.workspaceRoot);
  const rel = await searchFile(
    scopedFiles,
    state.workspaceRoot,
    state.recentFiles,
    'trace.file',
    state.tipCounter,
  );
  const absoluteFile = path.resolve(state.workspaceRoot, rel);

  if (action === 'checkDependencies') {
    const opts = await askCheckDepsOptions(state.tipCounter);
    return runCheckDepsWithDirection(opts.direction, absoluteFile, runtime, preferredFormat);
  }

  if (action === 'cycles') {
    return runFileDrivenActionFor('cycles', absoluteFile, runtime, state, preferredFormat);
  }

  return runFileDrivenActionForTrace(absoluteFile, runtime, state, preferredFormat, rel);
}

/** Run check-dependencies, path, or path-in depending on chosen direction. */
async function runCheckDepsWithDirection(
  direction: 'both' | 'outgoing' | 'incoming',
  absoluteFile: string,
  runtime: CliRuntime,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  if (direction === 'outgoing') {
    const { run } = await import('./path.js');
    const result = await executeCommandForRepl('path', [absoluteFile], runtime, preferredFormat, run);
    return { ...result, contextFile: absoluteFile };
  }

  if (direction === 'incoming') {
    const { run } = await import('./pathIn.js');
    const result = await executeCommandForRepl('path-in', [absoluteFile], runtime, preferredFormat, run);
    return { ...result, contextFile: absoluteFile };
  }

  const { run } = await import('./checkDependencies.js');
  const result = await executeCommandForRepl('check-dependencies', [absoluteFile], runtime, preferredFormat, run);
  return { ...result, contextFile: absoluteFile };
}

/** Run cycles or checkDependencies for a pre-known file (used by follow-up actions). */
async function runFileDrivenActionFor(
  action: 'cycles' | 'checkDependencies',
  absoluteFile: string,
  runtime: CliRuntime,
  _state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  if (action === 'checkDependencies') {
    const { run } = await import('./checkDependencies.js');
    const result = await executeCommandForRepl('check-dependencies', [absoluteFile], runtime, preferredFormat, run);
    return { ...result, contextFile: absoluteFile };
  }

  const { run } = await import('./cycles.js');
  const result = await executeCommandForRepl('cycles', [absoluteFile], runtime, preferredFormat, run);
  return { ...result, contextFile: absoluteFile };
}

/** Run trace (with symbol autocomplete) for a pre-known file (used by follow-up actions). */
async function runFileDrivenActionForTrace(
  absoluteFile: string,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
  rel?: string,
): Promise<ReplActionResult> {
  const displayPath = rel ?? path.relative(state.workspaceRoot, absoluteFile);
  const symbols = await extractFileSymbols(absoluteFile, runtime);
  const opts = await askTraceOptions(state.tipCounter);
  const symbolName = await selectOrInputSymbol(displayPath, symbols, state.tipCounter, state.lastSymbol ?? '');

  if (symbolName.trim()) {
    const args: string[] = [`${absoluteFile}#${symbolName.trim()}`];
    if (opts.maxDepth !== undefined) args.push(`--maxDepth=${opts.maxDepth}`);
    const { run } = await import('./trace.js');
    const result = await executeCommandForRepl('trace', args, runtime, preferredFormat, run);
    return { ...result, contextFile: absoluteFile, contextSymbol: symbolName.trim() };
  }

  const { run } = await import('./explain.js');
  const result = await executeCommandForRepl('explain', [absoluteFile], runtime, preferredFormat, run);
  return { ...result, contextFile: absoluteFile };
}

/**
 * Silently extract symbol names from a file by running the explain command in JSON mode.
 * Returns an empty array on any error or timeout — never throws.
 */
async function extractFileSymbols(
  absoluteFile: string,
  runtime: CliRuntime,
): Promise<string[]> {
  try {
    const { run } = await import('./explain.js');
    const jsonOutput = await Promise.race([
      run([absoluteFile], runtime, 'json'),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 5000);
      }),
    ]);

    const parsed: unknown = JSON.parse(jsonOutput);
    if (typeof parsed !== 'object' || parsed === null) return [];

    const names = new Set<string>();
    const record = parsed as Record<string, unknown>;

    const extractFromArray = (arr: unknown): void => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          if (typeof obj['symbolName'] === 'string') names.add(obj['symbolName']);
          if (typeof obj['name'] === 'string') names.add(obj['name']);
        }
      }
    };

    extractFromArray(record['nodes']);
    extractFromArray(record['symbols']);

    return [...names].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function handleExport(rawData: unknown, command: string): Promise<void> {
  try {
    const fmt = await selectExportFormat();
    const exported = formatOutput(rawData, fmt, command);
    const sanitizedExport = stripSavedOutputNoise(exported, fmt);
    process.stdout.write(sanitizedExport.endsWith('\n') ? sanitizedExport : `${sanitizedExport}\n`);
  } catch (err) {
    if (err instanceof ExitPromptError) return;
    process.stderr.write(
      `Export error: ${formatTerminalError(err)}\n`,
    );
  }
}

async function handleSaveToFile(
  output: string,
  command: string,
  workspaceRoot: string,
  rawData?: unknown,
  effectiveFormat?: CliOutputFormat,
): Promise<void> {
  try {
    const chosenPath = await inputSavePath(buildDefaultSavePathForFormat(command, effectiveFormat));
    const resolvedPath = path.resolve(workspaceRoot, chosenPath);

    if (!(await isSafeWorkspaceWritePath(resolvedPath, workspaceRoot))) {
      process.stderr.write('Refusing to write outside workspace root.\n');
      return;
    }

    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

    // TOCTOU mitigation: re-validate after directory creation.
    if (!(await isSafeWorkspaceWritePath(resolvedPath, workspaceRoot))) {
      process.stderr.write('Refusing to write outside workspace root.\n');
      return;
    }

    // Symlink hardening: never follow a symlink at the target path.
    try {
      const stats = await fs.lstat(resolvedPath);
      if (stats.isSymbolicLink()) {
        process.stderr.write('Refusing to overwrite a symlink target.\n');
        return;
      }
    } catch (lstatErr) {
      const code = (lstatErr as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw lstatErr;
    }

    const baseContent = rawData !== undefined && effectiveFormat
      ? formatOutput(rawData, effectiveFormat, command)
      : output;
    const sanitizedContent = stripSavedOutputNoise(baseContent, effectiveFormat);

    await fs.writeFile(resolvedPath, sanitizedContent, 'utf-8');
    process.stdout.write(`Saved: ${path.relative(workspaceRoot, resolvedPath)}\n`);
  } catch (err) {
    if (err instanceof ExitPromptError) return;
    process.stderr.write(
      `Save error: ${formatTerminalError(err)}\n`,
    );
  }
}

async function handleDrillDown(
  filePath: string,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
): Promise<void> {
  const rel = path.relative(runtime.workspaceRoot, filePath);
  const symbols = await extractFileSymbols(filePath, runtime);
  const symbolName = await selectOrInputSymbol(rel, symbols, state.tipCounter, state.lastSymbol ?? '').catch(() => '');
  try {
    if (symbolName.trim()) {
      const { run } = await import('./trace.js');
      const result = await executeCommandForRepl(
        'trace',
        [`${filePath}#${symbolName.trim()}`],
        runtime,
        state.preferredFormat,
        run,
      );
      state.lastFile = filePath;
      state.lastSymbol = symbolName.trim();
      state.lastResult = result.rawData ?? result.output;
      const output = result.output ?? '';
      process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    } else {
      const { run } = await import('./explain.js');
      const result = await executeCommandForRepl(
        'explain',
        [filePath],
        runtime,
        state.preferredFormat,
        run,
      );
      state.lastFile = filePath;
      state.lastSymbol = undefined;
      state.lastResult = result.rawData ?? result.output;
      const output = result.output ?? '';
      process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    }
  } catch (err) {
    if (!(err instanceof ExitPromptError)) {
      process.stderr.write(
        `Error: ${formatTerminalError(err)}\n`,
      );
    }
  }
}
