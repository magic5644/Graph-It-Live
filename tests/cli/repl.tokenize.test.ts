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
});
