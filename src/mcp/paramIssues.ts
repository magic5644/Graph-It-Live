/**
 * One readable message for invalid tool parameters (#769), shared by the MCP
 * server, the MCP worker and `graph-it tool`: the parameter, what it accepts
 * and what was received, never the raw Zod issue list.
 */

import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { closestNames } from "../analyzer/utils/SymbolLookup";

type Issue = z.core.$ZodIssue;

/** `seeds[0].filePath` from a Zod issue path. */
function paramName(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) => {
      if (typeof key === "number") return `[${key}]`;
      return index === 0 ? String(key) : `.${String(key)}`;
    })
    .join("");
}

/** The received value, short: `"xml"`, `0`, `an object`. */
function shown(input: unknown): string {
  if (typeof input === "string") {
    const text = input.length > 60 ? `${input.slice(0, 57)}...` : input;
    return JSON.stringify(text);
  }
  if (Array.isArray(input)) return "an array";
  if (input === null) return "null";
  if (typeof input === "object") return "an object";
  return String(input as string | number | boolean | bigint | symbol | undefined);
}

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  number: "a number",
  int: "an integer",
  boolean: "true or false",
  array: "an array",
  object: "an object",
};

function bound(issue: Issue & { code: "too_small" | "too_big" }): string {
  const value = Number(issue.code === "too_small" ? issue.minimum : issue.maximum);
  const unit = { string: " characters", array: " items" }[issue.origin as string] ?? "";
  if (unit) return issue.code === "too_small" ? `at least ${value}${unit}` : `at most ${value}${unit}`;
  const operator = issue.code === "too_small" ? ">" : "<";
  return `${operator}${issue.inclusive ? "=" : ""} ${value}`;
}

/** What the parameter accepts, as one phrase; undefined when only the issue's own message says it. */
function expectation(issue: Issue): string | undefined {
  switch (issue.code) {
    case "invalid_type":
      return TYPE_NAMES[issue.expected] ?? issue.expected;
    case "invalid_value":
      return issue.values.length === 1
        ? shown(issue.values[0])
        : `one of ${issue.values.map((value) => (typeof value === "string" ? value : shown(value))).join(", ")}`;
    case "too_small":
    case "too_big":
      return bound(issue);
    case "invalid_format":
      return issue.format === "regex" && "pattern" in issue ? `a string matching ${String(issue.pattern)}` : `a valid ${issue.format}`;
    case "not_multiple_of":
      return `a multiple of ${String(issue.divisor)}`;
    case "invalid_union": {
      const branches = issue.errors.flatMap((branch) => branch.map(expectation)).filter((text) => text !== undefined);
      return branches.length > 0 ? [...new Set(branches)].join(" or ") : undefined;
    }
    default:
      return undefined;
  }
}

const MAX_UNKNOWN_KEYS = 5;

function unknownKeysMessage(keys: readonly string[], path: readonly PropertyKey[], known: readonly string[]): string {
  const where = path.length > 0 ? ` in "${paramName(path)}"` : "";
  const named = keys.slice(0, MAX_UNKNOWN_KEYS).map((key) => {
    const [closest] = path.length === 0 ? closestNames([...known], key, 1) : [];
    const hint = closest ? ` Did you mean "${closest}"?` : "";
    return `Unknown parameter "${key}"${where}.${hint}`;
  });
  const more = keys.length > MAX_UNKNOWN_KEYS ? [`And ${keys.length - MAX_UNKNOWN_KEYS} more unknown parameters.`] : [];
  const list = path.length === 0 ? [`Parameters: ${known.join(", ")}.`] : [];
  return [...named, ...more, ...list].join(" ");
}

function issueMessage(issue: Issue, known: readonly string[]): string {
  if (issue.code === "unrecognized_keys") return unknownKeysMessage(issue.keys, issue.path, known);
  const name = paramName(issue.path);
  const input = (issue as { input?: unknown }).input;
  if (issue.code === "invalid_type" && input === undefined && name !== "") {
    return `Missing required parameter "${name}" (${TYPE_NAMES[issue.expected] ?? issue.expected}).`;
  }
  const expected = expectation(issue);
  if (expected === undefined) return name === "" ? issue.message : `"${name}": ${issue.message}`;
  const sized = Array.isArray(input) && (issue.code === "too_big" || issue.code === "too_small");
  const received = sized ? `${input.length} items` : shown(input);
  const got = input === undefined ? "" : `; got ${received}`;
  const subject = name === "" ? "Parameters" : JSON.stringify(name);
  return `${subject} must be ${expected}${got}.${schemaMessage(issue)}`;
}

/** A message written in the schema, not Zod's default: it says what the bound alone cannot (`1-based`). */
function schemaMessage(issue: Issue): string {
  const generic = z.config().localeError?.(issue as Parameters<NonNullable<z.core.$ZodConfig["localeError"]>>[0]);
  const text = typeof generic === "string" ? generic : generic?.message;
  return issue.message === text ? "" : ` ${issue.message}.`;
}

/** Top-level parameter names a schema accepts, in declaration order. */
export function schemaParameters(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, unknown> };
  return Object.keys(json.properties ?? {});
}

/** One line per issue: unknown, missing or invalid parameter, with the accepted values. */
export function formatParamIssues(schema: z.ZodType, issues: readonly Issue[]): string {
  const known = issues.some((issue) => issue.code === "unrecognized_keys") ? schemaParameters(schema) : [];
  return [...new Set(issues.map((issue) => issueMessage(issue, known)))].join(" ");
}

/** Parse with the received values kept in the issues, for {@link formatParamIssues}. */
export function parseToolParams<S extends z.ZodType>(
  schema: S,
  params: unknown,
): { success: true; data: z.output<S> } | { success: false; error: string; issues: Issue[] } {
  const result = schema.safeParse(params, { reportInput: true });
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: formatParamIssues(schema, result.error.issues), issues: result.error.issues };
}

/**
 * MCP `inputSchema` validating with {@link formatParamIssues}: the SDK prints
 * `path: message` per issue, so the single issue has no path. Listing still
 * uses the Zod JSON Schema.
 */
export function toolInputSchema<S extends z.ZodType>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const standard = schema["~standard"] as unknown as StandardSchemaWithJSON<z.input<S>, z.output<S>>["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => {
        const result = parseToolParams(schema, value);
        return result.success ? { value: result.data } : { issues: [{ message: result.error }] };
      },
    },
  };
}
