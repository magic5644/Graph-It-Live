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
import { SourceFileCollector } from '../../analyzer/SourceFileCollector.js';
import { CLI_OUTPUT_FORMATS, formatOutput } from '../formatter.js';
import type { CliOutputFormat } from '../formatter.js';
import type { CliRuntime } from '../runtime.js';
import { normalizePathForComparison } from '../../shared/path.js';
import { loggerFactory, type LogLevel } from '../../shared/logger.js';
import { parseSymbolRef } from '../symbols.js';
import { createSessionState } from '../repl/sessionState.js';
import { sanitizeTerminalText } from '../repl/terminal.js';
import { tokenizeCommandLine } from '../repl/tokenize.js';
import {
  getSlashCommandHelpLines,
  runInkReplSession,
  type InkReplCommandResponse,
} from '../repl/ink/ReplInkApp.js';

const VERSION = process.env.CLI_VERSION ?? '0.0.0-dev';

// ANSI helpers — skipped when NO_COLOR is set (https://no-color.org)
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const DIM = useColor ? '\x1b[2m' : '';
const BOLD = useColor ? '\x1b[1m' : '';
const RESET = useColor ? '\x1b[0m' : '';

const NON_TTY_MESSAGE =
  'Interactive mode unavailable (no TTY).\n' +
  'Use direct commands: graph-it --help\n';

interface ReplActionResult {
  command: string;
  output?: string;
  effectiveFormat?: CliOutputFormat;
  contextFile?: string;
  contextSymbol?: string;
  shouldQuit?: boolean;
}

type DependencyDirection = 'both' | 'outgoing' | 'incoming';
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
  scan: () => import('./scan.js'),
  query: () => import('./query.js'),
  wiki: () => import('./wiki.js'),
  'review-pr': () => import('./reviewPr.js'),
} satisfies Record<string, () => Promise<{ run: ReplRunner }>>;

/** Symbol commands backed by an MCP tool through the `tool` runner. */
const REPL_SYMBOL_TOOLS = {
  callers: { tool: 'query_call_graph', params: { direction: 'callers' } },
  impact: { tool: 'get_impact_analysis', params: {} },
} as const;

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

function buildReplHelpText(state: ReturnType<typeof createSessionState>): string {
  const lastFile = state.lastFile ? path.relative(state.workspaceRoot, state.lastFile) : 'none';
  return [
    `${BOLD}Slash commands${RESET}`,
    ...getSlashCommandHelpLines(),
    '',
    `${DIM}Examples:${RESET}`,
    '  /scope src/cli',
    '  /file src/cli/index.ts',
    '  /check-dependencies',
    '  /cycles src/cli/index.ts',
    '  /trace src/index.ts#main',
    '  /callers src/index.ts#main',
    '  /impact --includeTransitive=true',
    '  /context "how is the index built" --detail compact',
    '  /review-pr --base origin/main',
    '  /architecture --format mermaid',
    '  /export --output my-graph.html',
    '',
    `${DIM}session:${RESET} format=${state.preferredFormat}  last-file=${lastFile}`,
  ].join('\n');
}

function normalizeSlashCommand(command: string): string {
  return command.startsWith('/') ? command.slice(1) : command;
}

function formatTerminalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(message, 240);
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
  } catch (err) {
    process.stderr.write(`Scan error: ${formatTerminalError(err)}\n`);
    return;
  }

  const collector = new SourceFileCollector({ excludeNodeModules: true });
  const allFiles = await runQuietlyDuringBootstrap(
    () => collector.collectAllSourceFiles(runtime.workspaceRoot),
  );
  const state = createSessionState(runtime.workspaceRoot);

  await runInkReplSession({
    version: VERSION,
    workspaceRoot: state.workspaceRoot,
    allFiles,
    preferredFormat: state.preferredFormat,
    lastFile: state.lastFile,
    lastSymbol: state.lastSymbol,
    listFileSymbols: (absoluteFile: string) => extractFileSymbols(absoluteFile, runtime),
    onSubmitCommand: async (commandLine: string) => {
      const prevWorkspaceRoot = state.workspaceRoot;
      const prevPreferredFormat = state.preferredFormat;
      const prevLastFile = state.lastFile;
      const prevLastSymbol = state.lastSymbol;

      const result = await runTypedCommandLine(runtime, state, state.preferredFormat, commandLine);

      applyResultToSession(state, result);

      const response: InkReplCommandResponse = {
        command: result.command,
        output: result.output
          ? stripSavedOutputNoise(result.output, result.effectiveFormat)
          : undefined,
        shouldQuit: result.shouldQuit,
      };

      // Propagate state changes back to the REPL for display/autocomplete
      const workspaceChanged = state.workspaceRoot !== prevWorkspaceRoot;
      const formatChanged = state.preferredFormat !== prevPreferredFormat;
      const lastFileChanged = state.lastFile !== prevLastFile;
      const lastSymbolChanged = state.lastSymbol !== prevLastSymbol;
      if (workspaceChanged || formatChanged || lastFileChanged || lastSymbolChanged) {
        response.updatedContext = {};
        if (workspaceChanged) {
          const newAllFiles = await collector.collectAllSourceFiles(state.workspaceRoot);
          response.updatedContext.workspaceRoot = state.workspaceRoot;
          response.updatedContext.allFiles = newAllFiles;
        }
        if (formatChanged) {
          response.updatedContext.preferredFormat = state.preferredFormat;
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

  process.stdout.write('\nGoodbye!\n');
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
): Promise<Pick<ReplActionResult, 'command' | 'output' | 'effectiveFormat'>> {
  const jsonOutput = await runner(args, runtime, 'json');
  const rawData = parseRawCommandOutput(jsonOutput);

  try {
    const output = formatOutput(rawData, preferredFormat, command);
    return { command, output, effectiveFormat: preferredFormat };
  } catch {
    const output = formatOutput(rawData, 'text', command);
    return { command, output, effectiveFormat: 'text' };
  }
}

function applyResultToSession(
  state: ReturnType<typeof createSessionState>,
  result: ReplActionResult,
): void {
  // A result without a file context (help, usage, workspace-wide commands) keeps the current context.
  if ('contextFile' in result) {
    state.lastFile = result.contextFile;
    state.lastSymbol = result.contextSymbol;
  }

  if (result.effectiveFormat && result.effectiveFormat !== state.preferredFormat) {
    process.stdout.write(
      `Rendered in ${result.effectiveFormat} (default ${state.preferredFormat} unsupported for this command).\n`,
    );
  }
}

async function runTypedCommandLine(
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
  commandLine: string,
): Promise<ReplActionResult> {
  const trimmedCommandLine = commandLine.trim();
  const parsed = tokenizeCommandLine(trimmedCommandLine);
  const tokens = parsed.tokens;

  if (parsed.error) {
    return {
      command: 'command',
      output: `Invalid command line: ${sanitizeTerminalText(parsed.error)}`,
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
    };
  }

  const { effectiveFormat, cleanedArgs, invalidFormatValue } = extractFormatOverride(rawArgs, preferredFormat);
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
  );
  if (sessionCommand) {
    return sessionCommand;
  }

  const contextualResult = await runContextualAnalysisCommand(
    normalizedCommand,
    contextualArgs,
    runtime,
    state,
    effectiveFormat,
  );
  if (contextualResult) {
    return contextualResult;
  }

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
    output: `Unknown REPL command "${sanitizeTerminalText(normalizedCommand)}". Try: /scope, /file, /trace, /explain, /callers, /impact, /context, /query, /review-pr, /help.`,
  };
}

async function handleTypedSessionCommand(
  command: string,
  args: string[],
  state: ReturnType<typeof createSessionState>,
  runtime: CliRuntime,
): Promise<ReplActionResult | undefined> {
  if (command === 'help') {
    return {
      command: 'help',
      output: buildReplHelpText(state),
    };
  }

  if (command === 'quit') {
    return { command: 'quit', shouldQuit: true };
  }

  if (command === 'scope' || command === 'path') {
    return handlePathSessionCommand(args, state, runtime);
  }

  if (command === 'export') {
    const workspaceName = path.basename(runtime.workspaceRoot);
    const { runExportHtml } = await import('./ExportHtmlCommand.js');
    // Respect /scope narrowing: if state.workspaceRoot was narrowed to a subdir,
    // use it as default scope so /export stays within the active workspace scope.
    const defaultScope = state.workspaceRoot !== runtime.workspaceRoot
      ? state.workspaceRoot
      : undefined;
    await runExportHtml(runtime, workspaceName, args, state.lastFile ?? defaultScope);
    return { command: 'export' };
  }

  if (command !== 'format') {
    if (command !== 'file') {
      return undefined;
    }
    return handleFileSessionCommand(args, state, runtime);
  }

  const requestedFormat = args[0];
  if (requestedFormat && CLI_OUTPUT_FORMATS.includes(requestedFormat as CliOutputFormat)) {
    state.preferredFormat = requestedFormat as CliOutputFormat;
  } else if (requestedFormat) {
    return {
      command: 'format',
      output: `Unknown format "${sanitizeTerminalText(requestedFormat)}". Valid formats: ${CLI_OUTPUT_FORMATS.join(', ')}`,
    };
  } else {
    return {
      command: 'format',
      output: `Current format: ${state.preferredFormat}. Set a value explicitly, e.g. /format markdown. Valid formats: ${CLI_OUTPUT_FORMATS.join(', ')}`,
    };
  }

  return {
    command: 'format',
    output: `Default format set to ${state.preferredFormat}.`,
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
    command: 'scope',
    output: `Session workspace set to ${path.relative(runtime.workspaceRoot, state.workspaceRoot) || '.'}.`,
  };
}

async function handlePathSessionCommand(
  args: string[],
  state: ReturnType<typeof createSessionState>,
  runtime: CliRuntime,
): Promise<ReplActionResult> {
  if (!args[0]) {
    return {
      command: 'scope',
      output: `Current workspace scope: ${path.relative(runtime.workspaceRoot, state.workspaceRoot) || '.'}. Usage: /scope <directory>`,
    };
  }
  const targetDirectory = path.isAbsolute(args[0])
    ? path.resolve(args[0])
    : path.resolve(state.workspaceRoot, args[0]);

  if (!isWithinRoot(targetDirectory, runtime.workspaceRoot)) {
    return {
      command: 'scope',
      output: 'Refusing to set workspace scope outside project root.',
    };
  }

  const stats = await fs.stat(targetDirectory).catch(() => undefined);
  if (!stats?.isDirectory()) {
    return {
      command: 'scope',
      output: `Directory not found: ${sanitizeTerminalText(args[0], 140)}`,
    };
  }

  return applyWorkspaceScope(state, runtime, targetDirectory);
}

async function handleFileSessionCommand(
  args: string[],
  state: ReturnType<typeof createSessionState>,
  runtime: CliRuntime,
): Promise<ReplActionResult> {
  if (!args[0]) {
    return {
      command: 'file',
      output: state.lastFile
        ? `Current file context: ${path.relative(runtime.workspaceRoot, state.lastFile)}. Usage: /file <path>`
        : 'No file context set. Usage: /file <path>',
    };
  }

  const resolvedFile = parseSymbolRef(args[0], state.workspaceRoot).filePath;

  state.lastFile = resolvedFile;
  state.lastSymbol = undefined;

  return {
    command: 'file',
    output: `Current file context set to ${path.relative(runtime.workspaceRoot, resolvedFile)}.`,
    contextFile: resolvedFile,
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

/** Commands that fall back to the session file/symbol context when typed without a target. */
async function runContextualAnalysisCommand(
  command: string,
  args: string[],
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult | undefined> {
  if (command === 'callers' || command === 'impact') {
    return runSymbolToolCommand(command, args, runtime, state, preferredFormat);
  }
  if (command === 'explain') {
    return runExplainCommand(args, runtime, state, preferredFormat);
  }
  if (command === 'context') {
    return runContextCommand(args, runtime, state, preferredFormat);
  }
  return undefined;
}

async function runSymbolToolCommand(
  command: keyof typeof REPL_SYMBOL_TOOLS,
  args: string[],
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  const hasTarget = args[0] !== undefined && !args[0].startsWith('-');
  const target = hasTarget ? args[0] : buildDefaultTraceTarget(state);
  const parsed = target ? parseSymbolRef(target, state.workspaceRoot) : undefined;
  if (!parsed?.symbolName) {
    return {
      command,
      output: `/${command} needs a symbol. Usage: /${command} <file#Symbol>, or pick one first with /trace <file#Symbol>.`,
    };
  }

  const { tool, params } = REPL_SYMBOL_TOOLS[command];
  const toolArgs = [
    tool,
    '--args',
    JSON.stringify({ ...params, filePath: parsed.filePath, symbolName: parsed.symbolName }),
    ...(hasTarget ? args.slice(1) : args),
  ];
  const { run } = await import('./tool.js');
  const result = await executeCommandForRepl(command, toolArgs, runtime, preferredFormat, run);
  return { ...result, contextFile: parsed.filePath, contextSymbol: parsed.symbolName };
}

async function runExplainCommand(
  args: string[],
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  const filePath = args[0] ? parseSymbolRef(args[0], state.workspaceRoot).filePath : state.lastFile;
  if (!filePath) {
    return {
      command: 'explain',
      output: 'Explain needs a file. Usage: /explain <file>, or set a file with /file <path>.',
    };
  }

  const { run } = await import('./explain.js');
  const result = await executeCommandForRepl('explain', [filePath], runtime, preferredFormat, run);
  const sameFile = state.lastFile !== undefined
    && normalizePathForComparison(state.lastFile) === normalizePathForComparison(filePath);
  return { ...result, contextFile: filePath, contextSymbol: sameFile ? state.lastSymbol : undefined };
}

async function runContextCommand(
  args: string[],
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  preferredFormat: CliOutputFormat,
): Promise<ReplActionResult> {
  let contextArgs = args;
  if (args.length === 0) {
    if (!state.lastFile || !state.lastSymbol) {
      return {
        command: 'context',
        output: 'Context needs a question or a symbol. Usage: /context "<question>" [--detail compact], or pick a symbol first with /trace <file#Symbol>.',
        };
    }
    contextArgs = ['--seeds', `${state.lastFile}#${state.lastSymbol}`];
  }

  const { run } = await import('./context.js');
  const result = await executeCommandForRepl('context', contextArgs, runtime, preferredFormat, run);
  return { ...result, contextFile: state.lastFile, contextSymbol: state.lastSymbol };
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
    };
  }

  const absoluteFile = parseSymbolRef(fileArg, state.workspaceRoot).filePath;
  return runCheckDepsWithDirection(direction, absoluteFile, runtime, preferredFormat);
}

/** Run check-dependencies, path, or path-in depending on chosen direction. */
async function runCheckDepsWithDirection(
  direction: DependencyDirection,
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

