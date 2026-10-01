import { describe, expect, it } from 'vitest';
import { tokenizeCommandLine } from '../../src/cli/repl/tokenize';

describe('tokenizeCommandLine', () => {
  it('supports quoted arguments with spaces', () => {
    expect(tokenizeCommandLine('/trace "src/my file.ts#main"')).toEqual({
      tokens: ['/trace', 'src/my file.ts#main'],
    });
  });

  it('supports escaped spaces without shelling out', () => {
    expect(tokenizeCommandLine(String.raw`/path src/my\ file.ts`)).toEqual({
      tokens: ['/path', 'src/my file.ts'],
    });
  });

  it('returns an error for unterminated quotes', () => {
    expect(tokenizeCommandLine('/trace "src/file.ts')).toEqual({
      tokens: [],
      error: 'unterminated " quote',
    });
  });

  it('keeps backslashes of Windows drive and UNC paths', () => {
    expect(tokenizeCommandLine(String.raw`/scope C:\repo\src`)).toEqual({
      tokens: ['/scope', String.raw`C:\repo\src`],
    });
    expect(tokenizeCommandLine(String.raw`/file \\server\share\a.ts#main`)).toEqual({
      tokens: ['/file', String.raw`\\server\share\a.ts#main`],
    });
  });

  it('keeps backslashes inside quotes and still escapes a quote', () => {
    expect(tokenizeCommandLine(String.raw`/file "C:\Program Files\app\a.ts"`)).toEqual({
      tokens: ['/file', String.raw`C:\Program Files\app\a.ts`],
    });
    expect(tokenizeCommandLine(String.raw`/file 'C:\dir\'`)).toEqual({
      tokens: ['/file', 'C:\\dir\\'],
    });
    expect(tokenizeCommandLine(String.raw`/query say \"hi\"`)).toEqual({
      tokens: ['/query', 'say', '"hi"'],
    });
  });

  it('keeps a trailing backslash literal', () => {
    expect(tokenizeCommandLine('/scope C:\\repo\\')).toEqual({
      tokens: ['/scope', 'C:\\repo\\'],
    });
  });
});
