/**
 * Language detection utilities for file extensions
 * Centralized language mapping to avoid duplication across codebase
 */

import * as path from 'node:path';

/**
 * Map of file extensions to language names
 * Used for consistent language detection across the application
 */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.rs': 'rust',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.gql': 'graphql',
  '.graphql': 'graphql',
};

/**
 * Detect language from file path or extension
 * @param filePathOrExt - Full file path or just the extension (with or without dot)
 * @returns Language name (e.g., 'typescript', 'python', 'rust') or 'unknown'
 */
export function detectLanguageFromExtension(filePathOrExt: string): string {
  let ext = filePathOrExt;
  
  // If it's a full path, extract the extension
  if (filePathOrExt.includes('/') || filePathOrExt.includes('\\')) {
    ext = path.extname(filePathOrExt).toLowerCase();
  } else if (ext.startsWith('.')) {
    ext = ext.toLowerCase();
  } else {
    // If it's an extension without dot, add it
    ext = '.' + ext;
    ext = ext.toLowerCase();
  }
  
  return LANGUAGE_BY_EXTENSION[ext] || 'unknown';
}

/**
 * Check if a file extension is supported for a specific language
 * @param filePathOrExt - Full file path or extension
 * @param language - Language to check (e.g., 'typescript', 'python')
 * @returns true if the extension matches the language
 */
export function isLanguage(filePathOrExt: string, language: string): boolean {
  return detectLanguageFromExtension(filePathOrExt) === language;
}

/**
 * Get all extensions for a specific language
 * @param language - Language name (e.g., 'typescript', 'python')
 * @returns Array of extensions (with dots) for that language
 */
export function getExtensionsForLanguage(language: string): string[] {
  return Object.entries(LANGUAGE_BY_EXTENSION)
    .filter(([, lang]) => lang === language)
    .map(([ext]) => ext);
}
