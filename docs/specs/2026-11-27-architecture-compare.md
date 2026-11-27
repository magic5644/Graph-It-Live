# Spec: architecture structure diff in review-pr (#345, epic #300, milestone 1.26.2)

Status: round 1 fixes of julien-spec-devil applied by the main conversation (2026-11-27). GATE-5 approved 2026-11-27.
Issue: #345 (scope decision and acceptance criteria 2026-11-27). Next ticket #449 renders this shape.

## 1. Scope

Extend `compareArchitecture()` with an optional `structure` diff over two levels, as the Architecture view shows them in path mode:

- `units`: `workspaceUnits(...).units` (declared elements, else detected projects).
- `groups`: unit-scoped folder groups, `groupByUnit(...)` as `viewUnitLevel` calls it (all groups, no `maxGroups` cut).

Out: Louvain, plain path communities, `graph-it diagram --delta` (#449), new MCP tool, new CLI option.
Surface: `review-pr` only. CLI `src/cli/commands/reviewPr.ts`, MCP `src/mcp/tools/impact.ts`, LM tool `src/extension/services/LmToolsService.ts:1684` all reach `ReviewGateAnalyzer.collectArchitecture` -> `readReviewTrees` -> `reviewArchitecture`: one computation, parity by construction.

## 2. Layers and files

| Layer | Dev | Files |
| --- | --- | --- |
| shared | lucas | `src/shared/architecture-model.ts` (result types, section 3) |
| analyzer | lucas | new `src/analyzer/architecture/architectureStructure.ts`; edit `architectureReview.ts`, `workspaceUnits.ts` (extract helper), `architectureView.ts` (export `cycleUnits`), `ReviewGateAnalyzer.ts` (`collectArchitecture`, markdown), `BranchWatchAnalyzer.ts` (`renames`) |
| mcp | marco | `src/mcp/tools/impact.ts` (pass `renames` in the host), `src/mcp/toolDescriptions.ts` + `npm run sync:tool-descriptions` |
| cli + extension | kevin | `reviewPr.ts` (nothing to render by hand: JSON/TOON via `formatOutput`, markdown via analyzer), `LmToolsService.ts` host wiring if it builds its own host, parity test, E2E |

`graphit.architecture.json`: no new folder. `src/shared` stays a leaf (types only, no import from analyzer); analyzer imports shared (allowed); architectureReview and architectureStructure are siblings. Expect `check-architecture` 0/0 with no config edit. #449 imports the types from `src/shared/architecture-model.ts` (shared: reachable from analyzer, mcp, cli, extension, webview).

## 3. Interfaces (`src/shared/architecture-model.ts`)

All new members optional on exported results (our review gate rates a new required member breaking).

```ts
export type StructureStatus = "ADDED" | "REMOVED" | "CHANGED" | "RENAMED";
export type StructureLevel = "units" | "groups";

export interface StructureCount { before?: number; after?: number }   // absent side = item missing there

export interface StructureItemDiff {
  status: StructureStatus;
  /** Head key; base key when REMOVED. Units: unit key. Groups: folder group key. */
  key: string;
  /** Base key when RENAMED (also set on CHANGED when it moved to another unit: groups). */
  previousKey?: string;
  name: string;
  /** Groups only: owning unit key (head; base when REMOVED); `previousUnit` when it changed. */
  unit?: string;
  previousUnit?: string;
  fileCount: StructureCount;
  /** Units only. */
  role?: { before?: string; after?: string };
}

export interface StructureEdgeDiff {
  status: "ADDED" | "REMOVED" | "CHANGED";
  /** Item keys in the head key space (a matched base item shows its head key; a REMOVED item its base key). */
  from: string;
  to: string;
  /** Distinct file pairs, as `fileEdgeCount`. */
  pairs: StructureCount;
}

export interface StructureMovedFile { file: string; from: string; to: string }  // head path; item keys, base then head

export interface StructureCycleDiff { status: "ADDED" | "REMOVED"; members: string[] } // sorted keys

export interface StructureLevelDiff {
  items: StructureItemDiff[];
  edges: StructureEdgeDiff[];
  cycles: StructureCycleDiff[];             // "ADDED" = appeared, "REMOVED" = resolved
  movedFiles: StructureMovedFile[];
  /** Compared sizes, so "unchanged" is never empty. */
  compared: { items: StructureCount; edges: StructureCount; unchangedItems: number; unchangedEdges: number };
}

export interface ArchitectureStructureDiff {
  /** changed: any item, edge, cycle or moved file differs. empty: neither side has an analyzable file. */
  verdict: "changed" | "unchanged" | "empty";
  units: StructureLevelDiff;
  groups: StructureLevelDiff;
  files: StructureCount;                    // analyzed files per side
  /** Rename detection: files mapped, and whether Git stopped early. */
  renames: { mapped: number; complete: boolean };
  /** Wording in section 6; always shown to the user (markdown, JSON, TOON). */
  warnings: string[];
}
```

In `architectureReview.ts`:

```ts
// ArchitectureReview is unchanged (user decision 2026-11-27: structure at the result root).
export interface ArchitectureSide { ...; structure?: StructureSnapshot }   // analyzer-internal (architectureStructure.ts), section 4: never in src/shared, which imports nothing from analyzer
export interface ArchitectureReviewHost {
  ...;
  /** Git renames from `from` to `to` (undefined = working tree), base path -> head path. Absent: no rename info (warning). */
  renames?(from: string, to: string | undefined): Promise<{ moves: ReadonlyMap<string, string>; complete: boolean }>;
}
```

User decision (GATE-5, 2026-11-27): `structure?: ArchitectureStructureDiff` is a new optional member at the root of `ReviewGateResult` (and so of MCP `ReviewPrResult`), next to `architecture`. `architecture` keeps today's presence and meaning (absent without `graphit.architecture.json`): no existing consumer, SARIF or risk score changes. `structure` is present whenever the review trees were read, with or without a config. It never changes verdict, score or gate (informational only).

## 4. Computation

### 4.1 Snapshot per side (readSide, no graph kept)

`readSide` gains a `structureConfig` argument (head: its own config; base: `config ?? head.config`, also when the head has none; the rules argument `rulesFor` is unchanged). It always builds `structure` after `readTreeImports`:

```ts
export interface StructureSnapshot {
  configFrom: "own" | "head" | "none";
  unitsFrom: "elements" | "manifests";
  files: number;
  units: LevelSnapshot;
  groups: LevelSnapshot;
}
interface LevelSnapshot {
  items: Map<string, { name: string; fileCount: number; unit?: string; role?: string }>;
  fileItem: Map<string, string>;        // normalized workspace-relative file -> item key
  edges: Map<string, number>;           // `${from}\0${to}` -> fileEdgeCount
  cycles: string[][];                   // strongly connected sets of 2+ item keys; groups: within a unit
}
```

Build (`buildStructureSnapshot(graph, root, config)` in architectureStructure.ts):

1. Extract from `workspaceUnits` the pure part (assignUnits, buildArchitectureUnits, resolveElements, elementAssignment) into `declaredStructure(graph, root, config)` returning `{ units, assignment }`; `workspaceUnits` calls it and keeps its output byte-identical (existing tests unchanged). The structure code calls only `declaredStructure`: `checkArchitecture` is NOT run a second time (readSide already ran `checkGraphArchitecture` when rules apply). Remaining duplicate cost is assignUnits + unit build + resolveElements, O(files + edges); measure in the bench.
2. Units level: `units.units` (key, name, fileCount, role), `units.unitEdges` (from/to/fileEdgeCount, only `kind` for cycles), `fileItem` from `assignment.unitOf`, cycles = `cycleUnits(units)` (export it from architectureView.ts; do not copy).
3. Groups level: `groupByUnit(graph, units, assignment)` -> `overviewArchitecture(grouped, Infinity)` groups (`CommunityGroup.key`, `fileCount`), `groupEdges` (id -> key through `CommunityGroup`), `groupUnits[id]` for `unit`, `fileItem` from `grouped.nodes[].communityKey`. Group cycles: `layerGroupsWithinUnits(...).groupEdgeKinds` entries `"cycle"` -> `stronglyConnectedComponents` (same helper `cycleUnits` uses).
4. Drop the graph; keep only the snapshot (memory: two file maps per side, O(files)).

Unit cycles here are cycles between the displayed units (elements when declared). They differ from `review.unitCycles` (detected projects, rule-independent). Markdown labels them "structure" cycles.

### 4.2 Matching (`compareStructure(base, head, renames)` in architectureStructure.ts)

One generic `matchLevel(baseLevel, headLevel, rename)` used for both levels. Never by key or id alone.

1. `mapped(f) = rename.get(f) ?? f` for every base file (renames from Git `-M`, section 5).
2. Single pass over base files: `h = headLevel.fileItem.get(mapped(f))`; if defined, `overlap[b\0h]++`. O(files).
3. Candidates: pairs with overlap >= 1 and `dice = 2*overlap / (|b| + |h|) >= MATCH_MIN_DICE (0.5)`. Constant exported and documented.
4. Greedy one-to-one, order: dice desc, overlap desc, same key first, base key then head key by `byCodeUnit`. Deterministic, independent of Map order.
5. Matched pair: key equal -> `CHANGED` if fileCount or role (units) or owning unit (groups) differs, else unchanged (counted, not listed); key differs -> `RENAMED` (`previousKey`; +`previousUnit` for a group moved to another unit; it is still one item).
6. Unmatched base -> `REMOVED`; unmatched head -> `ADDED`. Splits and merges need no extra field: `movedFiles` shows where the files went. Split: base `A` 10 files -> head `A1` 6 + `A2` 4: `A1` matches (dice 0.75) and is RENAMED, `A2` ADDED, 4 moved files `A -> A2`. Merge: base `B` 10 files into head `C` 40 files (30 own): dice 2*10/50 = 0.4 -> `B` REMOVED, `C` CHANGED, 10 moved files `B -> C` (honest: `B` no longer exists).
7. Same key but overlap 0 or dice < 0.5 is REMOVED + ADDED (no key-only match): the key now names other files, so it is another item. A unit renamed by config keeps its files, so its overlap is high and it reads RENAMED.
8. Moved files: base file `f` (raw base path) present at the head as `mapped(f)`; `X` = head match of `base.fileItem.get(f)` (lookup by the raw base path, never `mapped(f)`); if `head.fileItem.get(mapped(f)) !== X` it is moved: `{ file: mapped(f), from: baseKey, to: headKey }`. Sorted by `file`.
8b. Case-only rename (`Foo.ts` -> `foo.ts`): `normalizePath` keeps the case of relative paths, Git reports it as `R100`, and each tree copy lists its own spelling, so the pair maps like any rename (test it).
9. Edges: translate each endpoint of a base edge to its head key (matched) or `\0base\0<key>` (unmatched, output as the base key). Compare with head edges by translated `from\0to`: only head -> ADDED, only base -> REMOVED, both with different `fileEdgeCount` -> CHANGED (`pairs`). A renamed unit thus yields no edge noise.
10. Cycles: member sets translated the same way, compared as sorted joined strings: only head = ADDED (appeared), only base = REMOVED (resolved).
11. Output order: items and edges by `byCodeUnit` on key (edges: from then to); lists complete in JSON.

Complexity O(files + edges + P log P), P <= files candidate pairs. No O(units x files): ines not required; measure anyway (hand-back).

Verdict: `empty` if both sides have 0 files (levels empty, `files` shows 0/0); `changed` if any list is non-empty; else `unchanged` with `compared` counts filled.

## 5. Git rename read (`BranchWatchAnalyzer.renames`)

```ts
async renames(from: string, to: string | undefined): Promise<{ moves: Map<string, string>; complete: boolean }>
```

- Args: `diff --no-ext-diff --no-textconv -M --name-status -z --diff-filter=R <from> [<to>] --`; same `execFile` path as `git()` (`this.gitPath`, `core.fsmonitor=false`, no shell, `GIT_OPTIONAL_LOCKS=0`). Add `LC_ALL=C` to read stderr. Do not add a new execFile: refactor `git()` into `run(args, { maxBuffer, timeout }) -> { stdout, stderr }` and keep `git()` as `(await run(args)).stdout`.
- Limits for this call: maxBuffer 64 MiB (as `CHANGED_FILE_LIST_MAX_BYTES`), timeout 30 s (the default 4 MiB / 10 s is too small for a mass rename).
- Refs untrusted: reject a ref starting with `-` and use `--` (as `validateRef`). `from` = base ref (explicit head: the merge base, as `readReviewTrees` already picks), `to` = explicit head, or `undefined` for the working tree.
- Parse `R<score>\0old\0new\0`; `normalizePath` both; drop an entry that is absolute or contains `..` (CWE-22; keys only, never opened).
- `complete = false` when stderr contains `inexact rename detection was skipped` (`diff.renameLimit`; git exits 0 then) or when a record does not parse (odd field count, unknown status): unparseable output is incomplete, never trusted. Failure (any other error): `moves` empty, `complete = false`, and the reason goes into the warning (never throw: refs were validated earlier). The stderr wording is checked by a real-git integration test, so a Git change fails the test, not the user.
- Untracked working-tree files are not in the diff: they count as added (documented in the warning when head is `HEAD`).

`readReviewTrees` computes `baseTreeRef = headRef === "HEAD" ? baseRef : await host.mergeBase(baseRef, headRef)` once, before both calls, and passes the same value to `withRefTree` and to `host.renames(baseTreeRef, headRef === "HEAD" ? undefined : headRef)` in parallel with the tree reads, passes the result to `reviewArchitecture` through `ReviewTrees.renames`. MCP host: `renames: (from, to) => git.renames(from, to)`. LM tool: same host (reuse `reviewTreeProvider`; check `LmToolsService` does not build a second host).

## 6. Warnings (exact wording, `structure.warnings`, also in markdown)

Each is added only when its condition holds, in this order (four warnings):

1. Config differs: `Units differ in definition between base and head (<detail>): units are matched by file overlap, not by name.` Detail, `; `-joined: `base has no graphit.architecture.json: built with the head's` / `head has no graphit.architecture.json: detected projects` / `base graphit.architecture.json is invalid (<reason>): built with the head's` / `elements added: a, b` / `removed: c` / `changed: d` / `roles changed`. Reuse `namedChanges` on `config.elements` and the `roles` JSON compare. Names `safe`-sanitized in markdown.
2. Rename information incomplete: `Git rename detection <stopped at diff.renameLimit | failed (<first line of the reason, 240 chars>) | is unavailable>: files moved beyond it count as removed + added.`
3. Moves Git cannot see, shown when a level has both a REMOVED and an ADDED item (where a move Git missed would show): `Renames and moved files cover what Git detects (git diff -M, 50 % similarity)<; untracked working-tree files count as added>: a file moved and heavily edited counts as removed + added.` The bracketed part only when the head is the working tree.
4. One side without analyzable file: `No analyzable file at <ref>: every unit and group reads as <added|removed>.`

Failure cases of the issue and where they land:

| Case | Behavior |
| --- | --- |
| Unknown ref | unchanged: `Unknown Git ref "<ref>": pass a branch, tag or commit of this repository.`, exit 1 (`ReviewGateAnalyzer` validates before the trees) |
| Invalid config at a ref | Head: config/baseline parse error rethrown (new `ArchitectureReviewError` thrown by readSide), CLI exit 1 `<ref>: <reason>`, MCP/LM tool error with the same message. Base: built with the head config, warning 1 detail `base graphit.architecture.json is invalid (<reason>): built with the head's`; rules review of the base as when it has no config. Other read errors stay limitations. Update the existing test that expects the swallowed error. |
| Base without config, head with one | warning 1 |
| Source of units or definitions differ | warning 1 |
| No structural change | `verdict: "unchanged"` with `compared` counts, JSON/TOON only |
| Ref without analyzable file | warning 4 / verdict `empty`, `files` counts |
| Rename limit or unparseable rename output | warning 2, `renames.complete: false` |
| Moved and heavily edited, untracked file | warning 3 |

## 7. Wiring and cost

- `collectArchitecture` (or a sibling `collectStructure` sharing the same `read()`): the structure is read even when its rules early return applies (no config at head and not in diff); the rules result stays as today. The trees are already read once and shared with `findFileCycles` via the `read()` promise cache in `impact.ts`; the added cost per side is the snapshot build. With `fileCycles: false` and no config the trees are now read only for structure: see open question 2.
- `reviewArchitecture` returns `{ review?, structure?, limitations }`: `review` exactly as today (`compareArchitecture`, unchanged, absent without any config); `structure = compareStructure(base.structure, head.structure, renames)` always when both sides carry a snapshot (hand-built sides in old tests: no `structure`).
- `readSide` still runs the cycles/rules exactly as today (one parse, one `checkGraphArchitecture`).

## 8. Rendering (markdown; JSON/TOON are the full object)

`renderArchitectureMarkdown` is unchanged; a new `renderStructureMarkdown(structure, safe)` appends after it, via the existing `capped()` (20 lines, `- … N more`), only when `structure.verdict !== "unchanged"` or `warnings.length > 0`:

```
### Architecture structure: CHANGED            (EMPTY / UNCHANGED + warnings only)
Units: <b> -> <a>. Groups: <b> -> <a>. Files: <b> -> <a>. Rename detection: <mapped> file(s)[, incomplete].
<warnings as "- warning: …">
#### Units added | removed | renamed | changed      (one list each, `- <key> (<n> files[, role <x> -> <y>])`, renamed: `<old> -> <new>`)
#### Groups added | removed | renamed | changed
#### Files moved between units | groups              (`- <file>: <from> -> <to>`)
#### Unit edges added | removed | changed             (`- <from> -> <to> (<n> pairs[, was <m>])`)
#### Group edges added | removed | changed
#### Cycles appeared | resolved (units, groups)       (`- a, b, c`)
```

Every key/path goes through `safe`. The "only when changed" rule is the issue's; the warnings-alone addition keeps "no silent fallback". Text format of the CLI is markdown for `--format markdown`; json/toon are `formatOutput` of the result (nested objects: add a toon round-trip test).

## 9. Estimate: L

Two snapshots + generic matcher + git rename read + three-surface wiring + two behavior changes (always-present `architecture`, invalid config exit 1) + bench on a large repository. No Marc-level layer redesign.

## 10. ADR

None required: no layer relationship change, shared types only. New optional root field only: no existing field changes presence or meaning.

## 11. Hand-back checks

Lucas (analyzer + shared):
- Golden cases (real fixture repo, two commits each): folder rename (RENAMED, no edge noise), split at dice 0.6 (RENAMED + ADDED + moved files), merge at dice 0.4 (REMOVED + CHANGED + moved files), file moved and edited beyond -M similarity (removed + added, warning 3), unit renamed via config (RENAMED, warning 1), case-only rename (`R100`, mapped).
- Unit tests: same key zero overlap (REMOVED+ADDED), tie-break determinism (shuffle input order, same output), threshold 0.49/0.5, group moved to another unit, edge CHANGED pair counts, cycles appeared/resolved at both levels, `unchanged` with `compared` counts, `empty` verdict, one-sided empty (warning 4), each config-differs detail (warning 1), rename incomplete/failed/absent/unparseable (warning 2), no config at either ref (`structure` present, `architecture` absent, SARIF and risk score unchanged), side without `structure`, `baseTreeRef` shared by `withRefTree` and `renames` (explicit head uses the merge base).
- `renames()`: real temporary Git repo integration test (git mv, 51% content, `diff.renameLimit=1` for incomplete: asserts the real stderr wording under `LC_ALL=C`), ref starting with `-`, `..`/absolute entries dropped, truncated/odd `-z` output = incomplete.
- `workspaceUnits` output unchanged (existing tests) and `checkArchitecture` not called twice (spy).
- Corrupt input: invalid config at base and at head (behaviour per open question 1), corrupt baseline file, snapshot with a file missing from `fileItem`, corrupt or truncated `.graph-it/cache/` before review-pr (rebuilt, same `structure`).
- Visual/markdown output at >= 50 units and >= 50 groups: caps 20 + `… N more`, sanitized keys with `|`, newline, backtick.
- Update existing tests that assumed `architecture` absent without config and the swallowed config error; list them in the PR.
- Coverage >= 80 % per touched file; Sonar S3776 <= 15 counted by hand on `matchLevel`, `compareStructure`, `buildStructureSnapshot`, `renames` parser and the renderer; no `await` in loops; duplication < 3 %; `graph-it check-architecture` 0 violations 0 unmatched, no config warning; `npm run lint`, `npm run check:types`, `npm run build`.

Marco (mcp): tool description WHEN/WHY/WHAT mention of `structure` and `sync:tool-descriptions`; MCP result carries `structure` in JSON and TOON; black-box call on a repo without `graphit.architecture.json`.

Kevin (cli + extension):
- Parity test: same fixture repo, CLI JSON, MCP `review_pr`, LM tool `graph-it-live_review_pr` return deep-equal `structure`.
- Black-box as a user: unknown ref (exit 1, exact message), invalid config at base/head (exit 1, `<ref>: <reason>`), no-config repo, rename-only branch, unchanged branch, empty ref, working-tree head with an untracked file.
- VS Code E2E: LM tool returns `structure` (targeted suite).
- A/B bench: `node scripts/bench-e2e.mjs --corpus <cal.com corpus>` on the branch and on main (`scripts/bench-compare.mjs`) plus `graph-it review-pr --base <ref>` timing cold and warm on cal.com, within +/-5 % of main (over it: profile and fix in this PR; first candidate: group-level edges); JSON full, markdown capped and stating what it left out; one run per touched language corpus (TS at least; others only if matching reads language-specific units).
- Security: Nathan light review on `git -M` (refs, output paths, buffers).

## 12. GATE-5 decisions (2026-11-27)

1. Decided (user, GATE-5): invalid at the head = exit 1 `<ref>: <reason>` (the user can fix it); invalid at the base = base built with the head config + warning 1 (a PR that fixes a broken base config must stay reviewable).
2. Decided: `fileCycles: false` and no config still read both trees for `structure`; bench the cost.
3. Decided: `structure` at the result root; `architecture` unchanged.
4. Dice threshold 0.5, exported constant; golden cases at 0.4 / 0.6.
