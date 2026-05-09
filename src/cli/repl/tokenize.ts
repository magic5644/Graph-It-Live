/**
 * Minimal tokenizer for REPL command lines.
 *
 * Supports spaces, single/double quotes, and backslash escapes without trying
 * to emulate a full shell.
 */

export interface TokenizeResult {
  tokens: string[];
  error?: string;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function handleQuotedChar(
  char: string,
  quote: "'" | '"',
  current: string,
): { current: string; quote?: "'" | '"' } {
  if (char === quote) {
    return { current, quote: undefined };
  }
  return { current: current + char, quote };
}

function handleUnquotedChar(
  char: string,
  current: string,
): { current: string; quote?: "'" | '"'; pushCurrent?: boolean } {
  if (char === '"' || char === "'") {
    return { current, quote: char };
  }

  if (isWhitespace(char)) {
    return { current, pushCurrent: true };
  }

  return { current: current + char };
}

export function tokenizeCommandLine(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushCurrent = (): void => {
    if (!current) return;
    tokens.push(current);
    current = '';
  };

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      const next = handleQuotedChar(char, quote, current);
      current = next.current;
      quote = next.quote;
      continue;
    }

    const next = handleUnquotedChar(char, current);
    current = next.current;
    quote = next.quote;
    if (next.pushCurrent) {
      pushCurrent();
    }
  }

  if (escaped) {
    return { tokens: [], error: 'dangling escape at end of command' };
  }

  if (quote) {
    return { tokens: [], error: `unterminated ${quote} quote` };
  }

  pushCurrent();
  return { tokens };
}
