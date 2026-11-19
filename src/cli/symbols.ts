/**
 * Deterministic Symbol Addressing
 *
 * Supports syntax: file.ts#FunctionName or file.ts#ClassName.method
 * Resolves relative to workspace root or cwd.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { closestPathsHint } from "../analyzer/utils/SymbolLookup";
import { normalizePath } from "../shared/path";
import { isPathWithinRootCanonical } from "../shared/pathSecurity";
import { CliError, ExitCode } from "./errors";

/**
 * Parsed symbol reference: { filePath, symbolName? }
 */
export interface SymbolRef {
  /** Absolute file path */
  filePath: string;
  /** Optional symbol name (function, class, method, etc.) */
  symbolName?: string;
}

/**
 * Parse a symbol address string.
 *
 * Formats:
 * - `file.ts` → file only
 * - `file.ts#FunctionName` → file + symbol
 * - `file.ts#ClassName.method` → file + dotted symbol
 * - `/absolute/path/file.ts#Symbol` → absolute path
 *
 * Relative paths are resolved against `workspaceRoot`.
 */
export function parseSymbolRef(ref: string, workspaceRoot: string): SymbolRef {
  if (!ref || ref.trim().length === 0) {
    throw new CliError("Symbol reference cannot be empty", ExitCode.GENERAL_ERROR);
  }

  const hashIndex = ref.indexOf("#");

  let rawPath: string;
  let symbolName: string | undefined;

  if (hashIndex >= 0) {
    rawPath = ref.slice(0, hashIndex);
    symbolName = ref.slice(hashIndex + 1);
    if (!symbolName || symbolName.trim().length === 0) {
      throw new CliError(
        `Invalid symbol reference "${ref}": symbol name after # is empty`,
        ExitCode.GENERAL_ERROR,
      );
    }
  } else {
    rawPath = ref;
  }

  if (!rawPath || rawPath.trim().length === 0) {
    throw new CliError(
      `Invalid symbol reference "${ref}": file path is empty`,
      ExitCode.GENERAL_ERROR,
    );
  }

  // Resolve to absolute path
  const filePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);

  // Security check: ensure path is within workspace, symlinks included
  const normalizedFile = path.resolve(filePath);
  if (!isPathWithinRootCanonical(normalizedFile, workspaceRoot)) {
    throw new CliError(
      `File path "${rawPath}" resolves outside workspace: ${normalizedFile}`,
      ExitCode.SECURITY_VIOLATION,
    );
  }

  return { filePath: normalizedFile, symbolName };
}

/** parseSymbolRef for a command's target file: a missing file or a folder exits 1, naming the closest files. */
export function parseTargetRef(ref: string, workspaceRoot: string): SymbolRef {
  const parsed = parseSymbolRef(ref, workspaceRoot);
  const stats = fs.statSync(parsed.filePath, { throwIfNoEntry: false });
  if (stats?.isFile()) return parsed;
  const relative = normalizePath(path.relative(workspaceRoot, parsed.filePath));
  if (stats) throw new CliError(`${relative} is a folder: pass a file.`, ExitCode.GENERAL_ERROR);
  throw new CliError(`File not found: ${relative}.${closestPathsHint(parsed.filePath, workspaceRoot)}`, ExitCode.GENERAL_ERROR);
}
