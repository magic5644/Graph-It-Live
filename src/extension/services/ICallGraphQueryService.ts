/**
 * Interface for querying call graph data from the SQLite database.
 * Used by SymbolViewService to enrich the symbol view with cross-file callers
 * without coupling it to CallGraphViewService directly.
 */

export interface ExternalCallerResult {
  /** Name of the symbol being called (in the target file) */
  targetSymbolName: string;
  /** Display name of the calling symbol */
  callerName: string;
  /** Normalized absolute path of the caller's file */
  callerFilePath: string;
  /** 0-based start line of the calling symbol */
  callerStartLine: number;
}

export interface ICallGraphQueryService {
  /**
   * Find symbols from other files that call the given symbols.
   * Returns [] if the DB is not yet indexed.
   *
   * @param filePath       Normalized absolute path of the target file
   * @param symbolNames    Names of exported symbols to search callers for
   * @param maxResults     Maximum total results (default: 50)
   */
  findExternalCallers(
    filePath: string,
    symbolNames: string[],
    maxResults?: number,
  ): ExternalCallerResult[];

  /** Whether the workspace call graph has been indexed at least once. */
  isIndexed(): boolean;
}
