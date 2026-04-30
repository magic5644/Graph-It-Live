/**
 * Tests for REPL utilities: sessionState and fileSearch.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSessionState,
  type SessionState,
} from '../../src/cli/repl/sessionState';

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

import { filterFiles } from '../../src/cli/repl/fileSearch';

describe('filterFiles', () => {
  const workspaceRoot = path.join('home', 'user', 'project');
  const files = [
    path.join(workspaceRoot, 'src', 'index.ts'),
    path.join(workspaceRoot, 'src', 'utils', 'helpers.ts'),
    path.join(workspaceRoot, 'src', 'cli', 'commands', 'scan.ts'),
    path.join(workspaceRoot, 'tests', 'cli', 'repl.test.ts'),
  ];

  it('returns all files when query is empty', () => {
    const result = filterFiles(files, '', workspaceRoot);
    expect(result).toHaveLength(4);
  });

  it('filters by substring (case-insensitive)', () => {
    const result = filterFiles(files, 'cli', workspaceRoot);
    expect(result).toContain('src/cli/commands/scan.ts');
    expect(result).toContain('tests/cli/repl.test.ts');
    expect(result).not.toContain('src/index.ts');
  });

  it('returns relative paths (not absolute)', () => {
    const result = filterFiles(files, 'index', workspaceRoot);
    expect(result).toContain('src/index.ts');
    expect(result.every((r: string) => !path.isAbsolute(r))).toBe(true);
  });

  it('returns results sorted alphabetically', () => {
    const result = filterFiles(files, '', workspaceRoot);
    const sorted = [...result].sort((a, b) => a.localeCompare(b));
    expect(result).toEqual(sorted);
  });

  it('returns empty array when nothing matches', () => {
    const result = filterFiles(files, 'zzznomatch', workspaceRoot);
    expect(result).toHaveLength(0);
  });

  it('matches against uppercase input', () => {
    const result = filterFiles(files, 'INDEX', workspaceRoot);
    expect(result).toContain('src/index.ts');
  });
});
