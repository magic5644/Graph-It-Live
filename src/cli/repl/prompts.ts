/**
 * REPL Prompts
 *
 * All @inquirer/prompts questions used by the REPL, centralised here
 * so each can be updated independently from the REPL loop.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { confirm, input, search, select } from '@inquirer/prompts';
import { filterFiles } from './fileSearch.js';

// ============================================================================
// Action types
// ============================================================================

export type MainAction = 'trace' | 'path' | 'check' | 'summary' | 'quit';
export type PostResultAction = 'drillDown' | 'export' | 'newAnalysis' | 'quit';
export type ExportFormat = 'json' | 'markdown' | 'mermaid';

// ============================================================================
// Prompts
// ============================================================================

/** Main menu: what would you like to do? */
export async function selectMainAction(): Promise<MainAction> {
  return select<MainAction>({
    message: 'What would you like to do?',
    choices: [
      { name: 'Analyse a file or symbol', value: 'trace' },
      { name: 'Map dependencies of a file', value: 'path' },
      { name: 'Find dead code', value: 'check' },
      { name: 'Workspace summary', value: 'summary' },
      { name: 'Quit', value: 'quit' },
    ],
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
  return search<string>({
    message: 'Search for a file',
    source: async (input) => {
      const matches = filterFiles(allFiles, input ?? '', workspaceRoot);
      return matches.slice(0, 20).map((rel) => ({ name: rel, value: rel }));
    },
  });
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
    message: `Symbol to analyse in ${displayPath} (leave empty for whole file)`,
    default: defaultSymbol,
  });
}

/** Post-result menu. */
export async function selectPostResultAction(): Promise<PostResultAction> {
  return select<PostResultAction>({
    message: 'What next?',
    choices: [
      { name: 'Drill into a node from this graph', value: 'drillDown' },
      { name: 'Export (json / markdown / mermaid)', value: 'export' },
      { name: 'New analysis', value: 'newAnalysis' },
      { name: 'Quit', value: 'quit' },
    ],
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

/** Offer to re-index when the workspace has no index yet. */
export async function confirmScan(reason: string): Promise<boolean> {
  return confirm({ message: `${reason} Scan now?`, default: true });
}
