import { getLogger } from "../../shared/logger";

/**
 * Utility functions for extracting file paths from various formats.
 * 
 * This module breaks the circular dependency between LanguageService and parsers.
 * Previously, parsers imported LanguageService just to call extractFilePath(),
 * which created a circular dependency loop.
 */

/**
 * Extract file path from a potential symbol ID (format: "filePath:symbolName")
 * Returns the original path if no colon is found.
 * 
 * Symbol IDs have format "filePath:symbolName" - used internally for tracking
 * symbol-level dependencies. File paths should not have colons except for Windows
 * drive letters (e.g., C:\path).
 * 
 * @param pathOrSymbolId - Either a file path or a symbol ID
 * @returns The extracted file path
 * 
 * @example
 * ```typescript
 * extractFilePath("/src/file.ts:MyClass") // => "/src/file.ts"
 * extractFilePath("C:\\src\\file.ts:MyClass") // => "C:\\src\\file.ts"
 * extractFilePath("/src/file.ts") // => "/src/file.ts"
 * ```
 */
export function extractFilePath(pathOrSymbolId: string): string {
  // Symbol IDs have format "filePath:symbolName"
  // File paths should not have colons except for Windows drive letters (e.g., C:\path)
  // If we detect a colon after a file extension, it's likely a symbol ID
  
  // Use regex to find the first colon that follows a file extension
    const regex = /^(.+\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|vue|svelte|gql|graphql)):(.+)$/i;
    const match = regex.exec(pathOrSymbolId);
  
  if (!match) {
    // No symbol ID pattern found - return as is
    return pathOrSymbolId;
  }
  
  const filePath = match[1];
  const symbolName = match[3];
  
  // If there's no symbol name after the colon, return as-is (not a symbol ID)
  if (!symbolName) {
    return pathOrSymbolId;
  }
  
  // Check if the file path has a Windows drive letter - if so, verify it's valid
  if (filePath.length > 1 && filePath[1] === ":" && /^[a-zA-Z]:/.test(filePath)) {
    // Valid Windows path with drive letter
  }
  
  // This is a symbol ID - extract the file path part
  getLogger("PathExtractor").warn(
    `Symbol ID detected where file path expected: ${pathOrSymbolId}. ` +
      `Extracting file path: ${filePath}`,
  );
  return filePath;
}
