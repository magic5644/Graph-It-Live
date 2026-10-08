import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { ts } from "ts-morph";
import { normalizePath } from "../../shared/path";

/** The tsconfig fields the analyzer reads; values stay `unknown` until checked. */
export interface TsConfigJson {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

/**
 * Parse tsconfig text the way `tsc` does: JSONC with comments, trailing commas and a BOM.
 * Returns undefined when the text is not a JSON object.
 */
export function parseTsConfig(file: string, text: string): TsConfigJson | undefined {
  // TypeScript asserts on backslash file names when it reports a diagnostic (Windows paths).
  const { config, error } = ts.parseConfigFileTextToJson(normalizePath(file), text);
  return error ? undefined : (config as TsConfigJson);
}

/**
 * Resolve an `extends` value (string or array, TS >= 5.0) to config file paths, in
 * declaration order so later entries override earlier ones. Relative and absolute
 * specifiers resolve from the config directory; package specifiers resolve through
 * node_modules. Unresolvable package specifiers are skipped.
 */
export function resolveExtendsTargets(file: string, extendsValue: unknown): string[] {
  const specifiers = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
  return specifiers
    .filter((specifier): specifier is string => typeof specifier === "string" && specifier.length > 0)
    .map((specifier) => resolveExtendsTarget(file, specifier))
    .filter((target): target is string => target !== undefined);
}

function resolveExtendsTarget(file: string, specifier: string): string | undefined {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    const base = path.resolve(path.dirname(file), specifier);
    const json = base.endsWith(".json") ? base : `${base}.json`;
    // A missing target keeps its .json-less path so a later addition is still detected.
    return fs.existsSync(json) ? json : base;
  }
  const require = createRequire(file);
  for (const candidate of [specifier, `${specifier}/tsconfig.json`]) {
    try {
      const resolved = require.resolve(candidate);
      if (resolved.endsWith(".json")) return toConfigPathSpace(path.dirname(file), resolved);
    } catch {
      // Not resolvable as written; try the package's tsconfig.json.
    }
  }
  return undefined;
}

/**
 * require.resolve returns a realpath. Re-express it under the config's own (possibly
 * symlinked) ancestors so workspace containment checks compare like with like.
 */
function toConfigPathSpace(configDir: string, resolved: string): string {
  for (let dir = configDir; ; dir = path.dirname(dir)) {
    const relative = path.relative(fs.realpathSync(dir), resolved);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return path.join(dir, relative);
    if (path.dirname(dir) === dir) return resolved;
  }
}
