/**
 * Minimal tokenizer for REPL command lines.
 *
 * Supports spaces, single/double quotes, and backslash escapes without trying
 * to emulate a full shell. A backslash escapes only whitespace or a quote, so
 * Windows paths (C:\repo\src, \\server\share) keep their separators.
 * Single quotes keep their content literal.
 */

export interface TokenizeResult {
  tokens: string[];
  error?: string;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isEscapable(char: string | undefined): boolean {
  return char !== undefined && (isWhitespace(char) || char === '"' || char === "'");
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

  const chars = [...input];
  for (const [index, char] of chars.entries()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'" && isEscapable(chars[index + 1])) {
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

  if (quote) {
    return { tokens: [], error: `unterminated ${quote} quote` };
  }

  pushCurrent();
  return { tokens };
}
