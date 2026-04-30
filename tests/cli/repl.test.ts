/**
 * Tests for REPL utilities: sessionState and fileSearch.
 */
import { describe, expect, it } from 'vitest';
import {
  createSessionState,
  type SessionState,
} from '../../src/cli/repl/sessionState.js';

describe('createSessionState', () => {
  it('sets workspaceRoot from argument', () => {
    const state = createSessionState('/home/user/project');
    expect(state.workspaceRoot).toBe('/home/user/project');
  });

  it('defaults preferredFormat to text', () => {
    const state = createSessionState('/tmp/ws');
    expect(state.preferredFormat).toBe('text');
  });

  it('has no lastFile or lastResult initially', () => {
    const state = createSessionState('/tmp/ws');
    expect(state.lastFile).toBeUndefined();
    expect(state.lastResult).toBeUndefined();
  });

  it('allows mutating lastFile on the returned object', () => {
    const state: SessionState = createSessionState('/tmp/ws');
    state.lastFile = '/tmp/ws/src/index.ts';
    expect(state.lastFile).toBe('/tmp/ws/src/index.ts');
  });
});
