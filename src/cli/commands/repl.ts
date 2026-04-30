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
import { ExitPromptError } from '@inquirer/core';
import { SourceFileCollector } from '../../analyzer/SourceFileCollector.js';
import { formatOutput } from '../formatter.js';
import type { CliRuntime } from '../runtime.js';
import {
  confirmScan,
  inputSymbol,
  searchFile,
  selectExportFormat,
  selectMainAction,
  selectPostResultAction,
} from '../repl/prompts.js';
import { createSessionState } from '../repl/sessionState.js';

const NON_TTY_MESSAGE =
  'Interactive mode unavailable (no TTY).\n' +
  'Use direct commands: graph-it --help\n';

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

  // ── Initialise workspace ────────────────────────────────────────────────
  try {
    await runtime.init();
  } catch {
    process.stderr.write('Workspace not found or not accessible.\n');
    return;
  }

  // ── Lazy index: offer to scan if not yet indexed ─────────────────────────
  try {
    await runtime.ensureIndexed();
  } catch {
    const doScan = await confirmScan('Index missing or stale.').catch(() => false);
    if (!doScan) {
      process.stdout.write('Goodbye!\n');
      return;
    }
    try {
      await runtime.ensureIndexed();
    } catch (err) {
      process.stderr.write(
        `Scan error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }
  }

  // ── Collect all source files for fuzzy search ────────────────────────────
  const collector = new SourceFileCollector({ excludeNodeModules: true });
  const allFiles = await collector.collectAllSourceFiles(runtime.workspaceRoot);

  const state = createSessionState(runtime.workspaceRoot);

  process.stdout.write('\n  Graph-It-Live — interactive mode  (Ctrl+C to quit)\n\n');

  // ── Main loop ────────────────────────────────────────────────────────────
  let quit = false;
  while (!quit) {
    quit = await runOneCycle(runtime, state, allFiles);
  }

  process.stdout.write('\nGoodbye!\n');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run one full REPL cycle: pick action → execute → post-result menu.
 * Returns `true` when the user wants to quit.
 */
async function runOneCycle(
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  allFiles: string[],
): Promise<boolean> {
  let action: Awaited<ReturnType<typeof selectMainAction>>;
  try {
    action = await selectMainAction();
  } catch (err) {
    if (err instanceof ExitPromptError) return true; // Ctrl+C at main menu
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return true;
  }

  if (action === 'quit') return true;

  try {
    const output = await runAction(action, runtime, state, allFiles);

    if (output) {
      state.lastResult = output;
      process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    }

    return await handlePostResult(output, action, runtime, state);
  } catch (err) {
    if (err instanceof ExitPromptError) return true;
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return false; // Non-fatal — continue loop
  }
}

/**
 * Show the post-result menu and handle the chosen action.
 * Returns `true` when the user wants to quit.
 */
async function handlePostResult(
  output: string | undefined,
  command: string,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
): Promise<boolean> {
  let postAction: Awaited<ReturnType<typeof selectPostResultAction>>;
  try {
    postAction = await selectPostResultAction();
  } catch (err) {
    if (err instanceof ExitPromptError) return true;
    throw err;
  }

  if (postAction === 'quit') return true;
  if (postAction === 'export' && output) await handleExport(output, command);
  if (postAction === 'drillDown' && state.lastFile) {
    await handleDrillDown(state.lastFile, runtime, state);
  }
  return false; // 'newAnalysis' or handled above → keep looping
}

async function runAction(
  action: 'trace' | 'path' | 'check' | 'summary',
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
  allFiles: string[],
): Promise<string | undefined> {
  if (action === 'summary') {
    const { run } = await import('./summary.js');
    return run([], runtime, state.preferredFormat);
  }

  if (action === 'check') {
    const { run } = await import('./check.js');
    return run([], runtime, state.preferredFormat);
  }

  // 'trace' and 'path' both need a file picker
  const rel = await searchFile(allFiles, runtime.workspaceRoot);
  const absoluteFile = path.join(runtime.workspaceRoot, rel);
  state.lastFile = absoluteFile;

  if (action === 'path') {
    const { run } = await import('./path.js');
    return run([absoluteFile], runtime, state.preferredFormat);
  }

  // 'trace' — optionally pick a symbol
  const symbolName = await inputSymbol(rel);
  if (symbolName.trim()) {
    const { run } = await import('./trace.js');
    return run([`${absoluteFile}#${symbolName.trim()}`], runtime, state.preferredFormat);
  }

  // No symbol entered → explain (intra-file analysis)
  const { run } = await import('./explain.js');
  return run([absoluteFile], runtime, state.preferredFormat);
}

async function handleExport(output: string, command: string): Promise<void> {
  try {
    const fmt = await selectExportFormat();
    const data: unknown = (() => {
      try { return JSON.parse(output); } catch { return output; }
    })();
    const exported = formatOutput(data, fmt, command);
    process.stdout.write(exported.endsWith('\n') ? exported : `${exported}\n`);
  } catch (err) {
    if (err instanceof ExitPromptError) return;
    process.stderr.write(
      `Export error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function handleDrillDown(
  filePath: string,
  runtime: CliRuntime,
  state: ReturnType<typeof createSessionState>,
): Promise<void> {
  const rel = path.relative(runtime.workspaceRoot, filePath);
  const symbolName = await inputSymbol(rel).catch(() => '');
  try {
    if (symbolName.trim()) {
      const { run } = await import('./trace.js');
      const output = await run(
        [`${filePath}#${symbolName.trim()}`],
        runtime,
        state.preferredFormat,
      );
      state.lastResult = output;
      process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    } else {
      const { run } = await import('./explain.js');
      const output = await run([filePath], runtime, state.preferredFormat);
      state.lastResult = output;
      process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    }
  } catch (err) {
    if (!(err instanceof ExitPromptError)) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
