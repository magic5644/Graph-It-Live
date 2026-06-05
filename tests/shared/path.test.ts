import { describe, expect, it } from 'vitest';
import { getRelativePath, normalizePath, normalizePathForComparison } from '../../src/shared/path';

describe('shared normalizePath', () => {
  it('normalizes Windows drive letter to lowercase', () => {
    expect(normalizePath(String.raw`C:\project\src\file.ts`)).toBe('c:/project/src/file.ts');
    expect(normalizePath('C:/project/src/file.ts')).toBe('c:/project/src/file.ts');
  });

  it('collapses repeated separators and trims trailing slash for non-root paths', () => {
    expect(normalizePath('C://project///src///')).toBe('c:/project/src');
    expect(normalizePath('/workspace//src///feature/')).toBe('/workspace/src/feature');
  });

  it('keeps root paths intact when trailing slash is present', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('C:/')).toBe('c:/');
  });

  it('returns empty input unchanged', () => {
    expect(normalizePath('')).toBe('');
  });
});

describe('shared normalizePathForComparison', () => {
  it('normalizes equivalent paths to same comparison string', () => {
    const a = normalizePathForComparison(String.raw`C:\repo\src\index.ts`);
    const b = normalizePathForComparison('c:/repo/src/index.ts/');
    expect(a).toBe('c:/repo/src/index.ts');
    expect(b).toBe('c:/repo/src/index.ts');
    expect(a).toBe(b);
  });

  it('keeps roots untouched while stripping non-root trailing slash', () => {
    expect(normalizePathForComparison('C:/')).toBe('c:/');
    expect(normalizePathForComparison('/repo/src/')).toBe('/repo/src');
  });
});

describe('shared getRelativePath', () => {
  it('returns normalized relative path when inside workspace', () => {
    expect(getRelativePath('/repo/src/module/file.ts', '/repo')).toBe('src/module/file.ts');
  });

  it('returns absolute path unchanged when outside workspace', () => {
    const outside = '/other/place/file.ts';
    expect(getRelativePath(outside, '/repo')).toBe(outside);
  });
});

