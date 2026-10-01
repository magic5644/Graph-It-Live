/**
 * Tests for REPL utilities: session state and terminal text sanitizing.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSessionState,
  type SessionState,
} from '../../src/cli/repl/sessionState';
import { sanitizeTerminalText } from '../../src/cli/repl/terminal';

describe('createSessionState', () => {
  it('sets workspaceRoot from argument', () => {
    const state = createSessionState('/home/user/project');
    expect(state.workspaceRoot).toBe('/home/user/project');
  });

  it('defaults preferredFormat to text', () => {
    const state = createSessionState('/tmp/ws');
    expect(state.preferredFormat).toBe('text');
  });

  it('has no lastFile or lastSymbol initially', () => {
    const state = createSessionState('/tmp/ws');
    expect(state.lastFile).toBeUndefined();
    expect(state.lastSymbol).toBeUndefined();
  });

  it('allows mutating lastFile on the returned object', () => {
    const state: SessionState = createSessionState('/tmp/ws');
    state.lastFile = '/tmp/ws/src/index.ts';
    expect(state.lastFile).toBe('/tmp/ws/src/index.ts');
  });
});

describe('sanitizeTerminalText', () => {
  it('removes ANSI, control and bidi characters', () => {
    const raw = 'hello\u001b[31m world\u202Eevil\u009bboom';
    expect(sanitizeTerminalText(raw)).toBe('hello [31m world evil boom');
  });
});
