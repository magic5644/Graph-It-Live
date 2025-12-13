import { describe, it, expect } from 'vitest';
import { isSupportedSourceFile, shouldSkipDirectory } from '../../src/analyzer/SourceFileFilters';

describe('SourceFileFilters', () => {
  it('detects supported file extensions', () => {
    expect(isSupportedSourceFile('index.ts')).toBe(true);
    expect(isSupportedSourceFile('component.jsx')).toBe(true);
    expect(isSupportedSourceFile('style.css')).toBe(false);
  });

  it('skips ignored and hidden directories, respects node_modules toggle', () => {
    expect(shouldSkipDirectory('node_modules', true)).toBe(true);
    expect(shouldSkipDirectory('node_modules', false)).toBe(false);

    expect(shouldSkipDirectory('.git', true)).toBe(true);
    expect(shouldSkipDirectory('dist', true)).toBe(true);
    expect(shouldSkipDirectory('some-dir', true)).toBe(false);
    expect(shouldSkipDirectory('.hidden', true)).toBe(true);
  });
});
