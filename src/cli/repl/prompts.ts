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
    message: 'Que voulez-vous faire ?',
    choices: [
      { name: 'Analyser un fichier ou symbole', value: 'trace' },
      { name: "Cartographier les dépendances d'un fichier", value: 'path' },
      { name: 'Trouver du code mort', value: 'check' },
      { name: 'Résumé du workspace', value: 'summary' },
      { name: 'Quitter', value: 'quit' },
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
    message: 'Rechercher un fichier',
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
export async function inputSymbol(displayPath: string): Promise<string> {
  return input({
    message: `Symbole à analyser dans ${displayPath} (laisser vide = tout le fichier)`,
    default: '',
  });
}

/** Post-result menu. */
export async function selectPostResultAction(): Promise<PostResultAction> {
  return select<PostResultAction>({
    message: 'Que faire ensuite ?',
    choices: [
      { name: 'Explorer un nœud de ce graphe', value: 'drillDown' },
      { name: 'Exporter (json / markdown / mermaid)', value: 'export' },
      { name: 'Nouvelle analyse', value: 'newAnalysis' },
      { name: 'Quitter', value: 'quit' },
    ],
  });
}

/** Export format selector. */
export async function selectExportFormat(): Promise<ExportFormat> {
  return select<ExportFormat>({
    message: "Format d'export",
    choices: [
      { name: 'JSON', value: 'json' },
      { name: 'Markdown', value: 'markdown' },
      { name: 'Mermaid', value: 'mermaid' },
    ],
  });
}

/** Offer to re-index when the workspace has no index yet. */
export async function confirmScan(reason: string): Promise<boolean> {
  return confirm({ message: `${reason} Scanner maintenant ?`, default: true });
}
