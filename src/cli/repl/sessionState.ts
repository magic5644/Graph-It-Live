/**
 * REPL Session State
 *
 * In-memory context shared across the REPL loop for a single invocation.
 * No persistence — state lives only for the duration of the REPL session.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { CliOutputFormat } from '../formatter.js';

export interface SessionState {
  workspaceRoot: string;
  lastFile?: string;
  lastSymbol?: string;
  lastResult?: unknown;
  preferredFormat: CliOutputFormat;
}

/**
 * Create a fresh session state for the given workspace root.
 */
export function createSessionState(workspaceRoot: string): SessionState {
  return {
    workspaceRoot,
    preferredFormat: 'text',
  };
}
