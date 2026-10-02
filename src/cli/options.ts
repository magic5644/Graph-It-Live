/**
 * Shared parsing of command option values.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { CliError, ExitCode } from "./errors";

/**
 * Integer value of `flag` (e.g. `--maxDepth 3`), or undefined when the flag is
 * absent. A missing, non-integer or out-of-range value is a usage error: a
 * silently ignored typo would run the command with a different limit.
 */
export function readIntegerOption(
  args: string[],
  flag: string,
  range: { min: number; max?: number },
): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;

  const raw = args[index + 1];
  const missing = raw === undefined || raw.startsWith("--");
  const parsed = missing || raw.trim() === "" ? Number.NaN : Number(raw);
  const { min, max } = range;
  if (Number.isInteger(parsed) && parsed >= min && (max === undefined || parsed <= max)) {
    return parsed;
  }

  const expected = max === undefined ? `an integer >= ${min}` : `an integer between ${min} and ${max}`;
  const got = missing ? "no value" : `"${raw}"`;
  throw new CliError(`${flag} must be ${expected}, got ${got}`, ExitCode.GENERAL_ERROR);
}
