/**
 * CallGraphSymbolLookup — resolves one symbol node in the call graph database.
 *
 * Node IDs embed the declaration line, so they are only valid for the current
 * graph revision. A selector (`symbolId` or `startLine`) that no longer matches
 * is reported as stale; it is never redirected to a same-name homonym.
 */

import type { Database } from "sql.js";
import { normalizePath } from "@/shared/path";

export interface CallGraphSymbol {
  id: string;
  name: string;
  type: string;
  lang: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface CallGraphSymbolSelector {
  filePath: string;
  symbolName: string;
  /** Exact node id from a previous result, valid for the current graph revision */
  symbolId?: string;
  /** Declaration line of the symbol (same numbering as `startLine` in results) */
  startLine?: number;
}

export type CallGraphSymbolMiss = "not_found" | "ambiguous" | "stale_selector";

export type CallGraphSymbolLookup =
  | { symbol: CallGraphSymbol }
  | { symbol: null; reason: CallGraphSymbolMiss; candidates: CallGraphSymbol[] };

const SELECT_SYMBOLS =
  "SELECT id, name, type, lang, path, start_line, end_line, is_exported FROM nodes WHERE path = ? AND name = ?";

function queryCandidates(
  db: Database,
  normalizedPath: string,
  symbolName: string,
  extraClause = "",
  extraParams: Array<string | number> = [],
): CallGraphSymbol[] {
  const rows = db.exec(`${SELECT_SYMBOLS}${extraClause} ORDER BY start_line, id`, [
    normalizedPath,
    symbolName,
    ...extraParams,
  ]);
  return (rows[0]?.values ?? []).map((row) => ({
    id: row[0] as string,
    name: row[1] as string,
    type: row[2] as string,
    lang: row[3] as string,
    filePath: row[4] as string,
    startLine: row[5] as number,
    endLine: row[6] as number,
    isExported: (row[7] as number) === 1,
  }));
}

function exactClause(selector: CallGraphSymbolSelector): {
  clause: string;
  params: Array<string | number>;
} {
  const clause: string[] = [];
  const params: Array<string | number> = [];
  if (selector.symbolId !== undefined) {
    clause.push(" AND id = ?");
    params.push(selector.symbolId);
  }
  if (selector.startLine !== undefined) {
    clause.push(" AND start_line = ?");
    params.push(selector.startLine);
  }
  return { clause: clause.join(""), params };
}

/**
 * Looks the symbol up inside `selector.filePath` only: an exact selector narrows
 * the name match, it never reaches a node of another file.
 */
export function lookupCallGraphSymbol(
  db: Database,
  selector: CallGraphSymbolSelector,
): CallGraphSymbolLookup {
  const normalizedPath = normalizePath(selector.filePath);
  const { clause, params } = exactClause(selector);
  const matches = queryCandidates(db, normalizedPath, selector.symbolName, clause, params);
  if (matches.length === 1) return { symbol: matches[0] };
  if (matches.length > 1) return { symbol: null, reason: "ambiguous", candidates: matches };

  if (clause === "") return { symbol: null, reason: "not_found", candidates: [] };
  // The name exists here but the selector no longer points at it: the index moved on.
  const sameName = queryCandidates(db, normalizedPath, selector.symbolName);
  return {
    symbol: null,
    reason: sameName.length > 0 ? "stale_selector" : "not_found",
    candidates: sameName,
  };
}
