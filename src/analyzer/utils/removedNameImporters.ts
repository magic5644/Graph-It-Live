import { mapWithConcurrency } from '../../shared/concurrency';
import { readImportBindings } from './pyRsImports';
import { readModuleReExports } from './reExports';

/** What the walk reads; paths are workspace-relative, as review_pr reports them. */
export interface ImporterSource {
  /** Files the index says reference `file`, or why they could not be listed. */
  referencingFiles(file: string): Promise<string[] | string>;
  /** Content at the reviewed ref; null when unreadable or not a language the walk parses. */
  read(file: string): Promise<string | null>;
  /** File `specifier`, written in `fromFile`, resolves to; null when unresolved. */
  resolve(fromFile: string, specifier: string): Promise<string | null>;
}

/** A module and the name it exports the removed symbol under. */
interface Target {
  module: string;
  name: string;
}

/**
 * Files that still import `name` from `module`, which no longer exports it (#524): a named import of it, or a
 * whole-module import (namespace, default, Python `import m` / `from m import *`) whose file names it. A referrer
 * whose import form is not parsed (`require()`, `import()`, a Vue SFC) counts when it names it. Barrels that
 * re-export it (`export *`, `export { name as x } from`, Python `from m import name`) are followed under the
 * name they give it; a named re-export breaks too, so that barrel is listed. Returns why a referrer list could not
 * be read instead, so the caller can report the gap.
 */
export async function findRemovedNameImporters(
  module: string,
  name: string,
  extraCandidates: readonly string[],
  source: ImporterSource,
): Promise<string[] | string> {
  const found = new Set<string>();
  const root = { module, name };
  const failure = await walkLevel([root], new Set([targetKey(root)]), extraCandidates, { found, source });
  return failure ?? [...found].sort((left, right) => left.localeCompare(right));
}

interface WalkState {
  found: Set<string>;
  source: ImporterSource;
}

/**
 * One breadth-first level over the barrels found so far; returns the first failure. `extraCandidates` are files the
 * index may not list yet (the diff's own files), checked on the first level only.
 */
async function walkLevel(frontier: Target[], seen: Set<string>, extraCandidates: readonly string[], state: WalkState): Promise<string | undefined> {
  if (frontier.length === 0) return undefined;
  const visits = await Promise.all(frontier.map((target) => visitTarget(target, extraCandidates, state.source)));
  const next: Target[] = [];
  for (const visit of visits) {
    if (typeof visit === 'string') return visit;
    for (const file of visit.consumers) state.found.add(file);
    for (const onward of visit.onward) {
      const key = targetKey(onward);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(onward);
    }
  }
  return walkLevel(next, seen, [], state);
}

function targetKey({ module, name }: Target): string {
  return `${module}\0${name}`;
}

async function visitTarget(
  target: Target,
  extraCandidates: readonly string[],
  source: ImporterSource,
): Promise<{ consumers: string[]; onward: Target[] } | string> {
  const referrers = await source.referencingFiles(target.module);
  if (typeof referrers === 'string') return referrers;
  const indexed = new Set(referrers);
  const candidates = [...new Set([...referrers, ...extraCandidates])].filter((file) => file !== target.module);
  // Candidates can be every importer in the index: read a bounded number at a time.
  const imports = await mapWithConcurrency(candidates, 8, (file) => classifyImporter(file, target, indexed.has(file), source));
  return {
    consumers: candidates.filter((_file, index) => imports[index].consumer),
    onward: candidates.flatMap((file, index) => imports[index].reexportedAs.map((name) => ({ module: file, name }))),
  };
}

/** How `file` reaches `target.name` from `target.module`: whether it breaks, and the names it re-exports it under. */
async function classifyImporter(
  file: string,
  target: Target,
  indexed: boolean,
  source: ImporterSource,
): Promise<{ consumer: boolean; reexportedAs: string[] }> {
  const content = await source.read(file);
  if (content === null) return { consumer: false, reexportedAs: [] };
  const bindings = readImportBindings(file, content);
  const reExports = readModuleReExports(file, content).reExports;
  const specifiers = [...new Set([...bindings.map((binding) => binding.specifier), ...reExports.map((reExport) => reExport.specifier)])];
  const resolved = await Promise.all(specifiers.map((specifier) => source.resolve(file, specifier).catch(() => null)));
  const fromModule = new Set(specifiers.filter((_specifier, index) => resolved[index] === target.module));
  if (fromModule.size === 0) return { consumer: indexed && mentionsIdentifier(content, target.name), reexportedAs: [] };

  const { name } = target;
  const moduleReExports = reExports.filter((reExport) => fromModule.has(reExport.specifier));
  const imported = bindings.some((binding) => fromModule.has(binding.specifier)
    && (binding.imported === name || (isWholeModule(binding.imported) && mentionsIdentifier(content, name))));
  const reexportedByName = moduleReExports.some((reExport) => reExport.names !== 'all' && reExport.names.some((pair) => pair.imported === name));
  return {
    consumer: imported || reexportedByName,
    reexportedAs: moduleReExports.flatMap((reExport) => (reExport.names === 'all'
      ? [name]
      : reExport.names.filter((pair) => pair.imported === name).map((pair) => pair.exported))),
  };
}

/** A namespace, Python module or star import, or a default import (an object whose members are not followed). */
function isWholeModule(imported: string): boolean {
  return imported === '*' || imported === 'default';
}

const IDENTIFIER_CHAR = /[\w$]/;

/** Whether `content` contains `name` as a whole identifier (a comment or string mention counts: unknown is kept). */
export function mentionsIdentifier(content: string, name: string): boolean {
  if (name === '') return false; // `indexOf('')` matches everywhere and would never advance past the end
  for (let at = content.indexOf(name); at >= 0; at = content.indexOf(name, at + 1)) {
    const before = at > 0 ? content[at - 1] : '';
    const after = content[at + name.length] ?? '';
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return true;
  }
  return false;
}
