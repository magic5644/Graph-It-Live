/**
 * Terminal text helpers for the CLI REPL.
 *
 * Ensures user-derived text stays safe and readable when echoed back into
 * ANSI-capable terminals.
 */

function isControlOrBidiCodePoint(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    codePoint === 0x1b ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

export function sanitizeTerminalText(input: string, maxLength = 80): string {
  let sanitized = '';

  for (const char of input) {
    if (sanitized.length >= maxLength) break;
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    sanitized += isControlOrBidiCodePoint(codePoint) ? ' ' : char;
  }

  return sanitized.replaceAll(/\s+/g, ' ').trim();
}
