import { describe, expect, it } from 'vitest';
import { normalizePath } from '../../../src/webview/utils/path';

describe('webview normalizePath', () => {
  it('normalizes Windows drive letter to lowercase', () => {
    expect(normalizePath(String.raw`C:\Root\src\file.ts`)).toBe('c:/Root/src/file.ts');
    expect(normalizePath('C:/Root/src/file.ts')).toBe('c:/Root/src/file.ts');
  });

  it('collapses slashes and trims trailing slash', () => {
    expect(normalizePath('c:\\\\root\\\\src\\\\')).toBe('c:/root/src');
    expect(normalizePath('c:/')).toBe('c:/');
  });
});

