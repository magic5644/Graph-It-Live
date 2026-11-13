/**
 * Dead code by cascade (#726): the files that only dead files and tests import, found from the importers the
 * unreferenced-file scan already read from the reverse index. Pure functions; no I/O.
 */
import { meetsConfidence, type DeadCodeConfidence } from "./deadCodeConfidence";

/**
 * The files of `importersOf` that no live production file imports, each with its production importers (`via`, all
 * dead). Liveness is propagated rather than death, so dead cycles (A imports B, B imports A, nothing else does) are
 * found too. A production importer is live unless it is `dead` or itself a candidate no live file reaches: an importer
 * the scan did not read (out of scope, beyond maxFiles) or a file kept by `live` (an entry point) keeps its targets.
 * `dead` and `live` files and files with no production importer are never returned.
 */
export function deadByCascade(
  importersOf: ReadonlyMap<string, readonly string[]>,
  dead: ReadonlySet<string>,
  live: ReadonlySet<string>,
  isTest: (file: string) => boolean,
): Map<string, string[]> {
  const via = new Map<string, string[]>();
  for (const [file, importers] of importersOf) {
    if (dead.has(file) || live.has(file)) continue;
    const production = importers.filter((importer) => !isTest(importer));
    if (production.length > 0) via.set(file, production);
  }
  for (const file of reachedFromLive(via, dead)) via.delete(file);
  return via;
}

/** The candidates a live production file reaches: one importer neither dead nor a candidate, then what those import. */
function reachedFromLive(via: ReadonlyMap<string, readonly string[]>, dead: ReadonlySet<string>): Set<string> {
  const targetsOf = new Map<string, string[]>();
  for (const [file, production] of via) {
    for (const importer of production) {
      // push, not spread: a barrel importing thousands of files would copy its list each time
      const targets = targetsOf.get(importer);
      if (targets) targets.push(file);
      else targetsOf.set(importer, [file]);
    }
  }
  const queue = [...via].filter(([, production]) => production.some((importer) => !dead.has(importer) && !via.has(importer))).map(([file]) => file);
  const alive = new Set(queue);
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const target of targetsOf.get(file) ?? []) {
      if (!alive.has(target)) {
        alive.add(target);
        queue.push(target);
      }
    }
  }
  return alive;
}

/**
 * The confidence of each cascade file: the lowest of its dead importers' levels and of its own `cap` (`medium` when
 * another reason applies, such as a computed import reaching it). Lowered until stable, so a chain carries the level
 * of its root. A dead cycle no direct dead file reaches is `low`, like a file nothing imports.
 */
export function cascadeConfidence(
  via: ReadonlyMap<string, readonly string[]>,
  direct: ReadonlyMap<string, DeadCodeConfidence>,
  cap: ReadonlyMap<string, DeadCodeConfidence>,
): Map<string, DeadCodeConfidence> {
  const result = new Map<string, DeadCodeConfidence>();
  const lower = (a: DeadCodeConfidence, b: DeadCodeConfidence): DeadCodeConfidence => (meetsConfidence(b, a) ? a : b);
  // Levels only go down once set, so the loop ends.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [file, importers] of via) {
      const known = importers.flatMap((importer) => direct.get(importer) ?? result.get(importer) ?? []);
      if (known.length === 0) continue;
      const level = known.reduce((lowest, importer) => lower(lowest, importer), cap.get(file) ?? "high");
      if (level !== result.get(file)) {
        result.set(file, level);
        changed = true;
      }
    }
  }
  for (const file of via.keys()) if (!result.has(file)) result.set(file, "low");
  return result;
}
