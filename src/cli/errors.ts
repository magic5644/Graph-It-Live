/**
 * CLI Error Handling
 *
 * Structured exit codes and error messages for the Graph-It-Live CLI.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

/** CLI exit codes */
export const ExitCode = {
  /** Command completed successfully */
  SUCCESS: 0,
  /** General/unspecified error */
  GENERAL_ERROR: 1,
  /** Symbol reference is ambiguous (multiple matches) */
  AMBIGUOUS_SYMBOL: 2,
  /** Workspace not found or not indexed */
  WORKSPACE_NOT_FOUND: 3,
  /** Unsupported format/command combination */
  UNSUPPORTED_FORMAT: 4,
  /** Path outside workspace (security violation) */
  SECURITY_VIOLATION: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * CLI-specific error with structured exit code
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * Map well-known error patterns to appropriate exit codes.
 */
export function classifyError(error: unknown): { message: string; exitCode: ExitCode } {
  if (error instanceof CliError) {
    return { message: error.message, exitCode: error.exitCode };
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Path traversal") || message.includes("outside workspace")) {
    return { message, exitCode: ExitCode.SECURITY_VIOLATION };
  }

  if (message.includes("not initialized") || message.includes("Workspace not") || message.includes("no rootDir")) {
    return { message, exitCode: ExitCode.WORKSPACE_NOT_FOUND };
  }

  return { message, exitCode: ExitCode.GENERAL_ERROR };
}
