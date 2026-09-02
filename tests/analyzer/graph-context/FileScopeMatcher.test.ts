import { describe, expect, it } from 'vitest';
import { compileFileScope } from '../../../src/analyzer/graph-context/FileScopeMatcher';

describe('compileFileScope', () => {
  it('matches recursive paths under the requested directory only', () => {
    const scope = compileFileScope('/workspace', 'src/analyzer/**');

    expect(scope.matches('/workspace/src/analyzer/path.ts')).toBe(true);
    expect(scope.matches('/workspace/src/analyzer/nested/path.ts')).toBe(true);
    expect(scope.matches('/workspace/src/webview/path.ts')).toBe(false);
  });

  it('keeps a single star within one path segment', () => {
    const scope = compileFileScope('/workspace', 'src/*.ts');

    expect(scope.matches('/workspace/src/index.ts')).toBe(true);
    expect(scope.matches('/workspace/src/nested/index.ts')).toBe(false);
  });

  it('supports globstars and single-character wildcards together', () => {
    const scope = compileFileScope('/workspace', 'src/**/path?.ts');

    expect(scope.matches('/workspace/src/path1.ts')).toBe(true);
    expect(scope.matches('/workspace/src/analyzer/pathA.ts')).toBe(true);
    expect(scope.matches('/workspace/src/analyzer/path.ts')).toBe(false);
  });

  it('treats an empty pattern as the whole workspace', () => {
    const scope = compileFileScope('/workspace', '');

    expect(scope.matches('/workspace/src/index.ts')).toBe(true);
    expect(scope.matches('/other/src/index.ts')).toBe(false);
  });

  it('normalizes Windows separators in roots, patterns, and candidates', () => {
    const scope = compileFileScope('C:\\workspace', 'src\\analyzer\\**');

    expect(scope.sqlGlob).toBe('c:/workspace/src/analyzer/*');
    expect(scope.matches('C:\\workspace\\src\\analyzer\\path.ts')).toBe(true);
    expect(scope.matches('C:\\workspace\\src\\webview\\path.ts')).toBe(false);
  });

  it('rejects a pattern that escapes the workspace root', () => {
    expect(() => compileFileScope('/workspace', '../outside/**')).toThrow(
      'File scope must stay within the workspace root',
    );
  });

  it('rejects candidate paths outside the workspace', () => {
    const scope = compileFileScope('/workspace', '**');

    expect(scope.matches('/workspace/src/index.ts')).toBe(true);
    expect(scope.matches('/workspace-other/src/index.ts')).toBe(false);
    expect(scope.matches('/outside/src/index.ts')).toBe(false);
  });

  it('escapes literal SQLite GLOB character classes', () => {
    const scope = compileFileScope('/workspace', 'src/literal[1].ts');

    expect(scope.sqlGlob).toBe('/workspace/src/literal[[]1].ts');
    expect(scope.matches('/workspace/src/literal[1].ts')).toBe(true);
    expect(scope.matches('/workspace/src/literal1.ts')).toBe(false);
  });

  it('treats wildcard characters in the workspace root as literals', () => {
    const scope = compileFileScope('/work*space', 'src/**');

    expect(scope.sqlGlob).toBe('/work[*]space/src/*');
    expect(scope.matches('/work*space/src/index.ts')).toBe(true);
    expect(scope.matches('/workspace/src/index.ts')).toBe(false);
  });
});
