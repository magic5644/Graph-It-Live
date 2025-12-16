import { describe, expect, it } from 'vitest';
import { normalizePath } from '../../src/shared/path';

describe('shared normalizePath', () => {
  it('normalizes Windows drive letter to lowercase', () => {
    expect(normalizePath(String.raw`C:\project\src\file.ts`)).toBe('c:/project/src/file.ts');
    expect(normalizePath('C:/project/src/file.ts')).toBe('c:/project/src/file.ts');
  });
});

