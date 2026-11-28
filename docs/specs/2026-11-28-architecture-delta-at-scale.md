# Spec: architecture delta readable at scale (#843, milestone 1.26.2)

Follows `2026-11-27-architecture-delta.md` (#449). Analyzer only, plus two lines of CLI glue. No new option, no JSON change.

## 1. Data: head unit edges, no second comparison

- `reviewArchitecture()` (`architectureReview.ts`) also returns `headUnitEdges: ReadonlyMap<string, number>` = `head.structure.units.edges` (keys `from\0to` in head unit keys, value = file pairs), the map the snapshot already holds. Absent when the head has no snapshot.
- `SymbolDependentsProvider.reviewArchitecture` type, `collectArchitecture` and `analyzeArchitecture()` carry it. `ArchitectureDeltaSource` gains `headUnitEdges?`. `src/mcp/tools/impact.ts:77` (the provider) returns `reviewArchitecture()` as is, so it passes through; its type and the provider mocks in tests follow. Head snapshot without a base one: `structure` is undefined, nothing is drawn (as today).
- MCP `review_pr` and the VS Code callers (`BranchWatchService`, `LmToolsService`) keep `analyze()`: they draw no SVG. `analyze()` picks `review` and `structure` by name, so the extra key never reaches the result.
- `ReviewGateResult` does not: the `review-pr` JSON, TOON, markdown and SARIF stay byte-identical. `analyze()` keeps its signature; a new `analyzeWithDelta()` returns `{ result, headUnitEdges? }` and `analyze()` = `(await analyzeWithDelta()).result`. `review-pr --deltaSvg` calls `analyzeWithDelta` and renders `{ ...result, headUnitEdges }`.
- Why the head map is enough: `diffEdges` keys base edges in head key space; an edge is unchanged iff it is in both with the same pairs. So unchanged edges = head edges whose `(from, to)` is not an ADDED or CHANGED diff edge. Their ends are head keys = drawn ids (a REMOVED unit has no unchanged edge; a `gone` collision makes the head edge ADDED). The model checks the count against `compared.unchangedEdges`; a mismatch adds a warning, never a silent drop.

## 2. Model (`architectureDelta.ts`)

Order in `buildDeltaModel`: items → changed edges → cycles → context → violations → **fold** (ADDED/REMOVED) → select units → **context fill** → **unchanged edges** → select edges → cycles marked → ledger → cut.

### 2.1 Fold (A)

- `MIN_FOLD = 4`. **Revised after the cal.com run (human decision, 2026-11-28): only ADDED and REMOVED units fold** (repeated siblings whose identity matters less than their count); REWIRED, CHANGED, RENAMED and context units never fold (a `packages/* · REWIRED · 10 units` fold hid lib, prisma, trpc…; past the cap, the existing selection and cut line apply). Cycle members DO fold (cal.com: one resolved cycle holds all 40 removed packages); cycle ids are remapped to the fold id, the ring is drawn on the fold, the ledger cycle row keeps every key. Eligible unit: status ADDED or REMOVED, not an end (`fromId`/`toId`) of any violation row of any kind (new, accepted, resolved), so a merged edge never carries `violation` or `rules`; not a member of any diff cycle; key holds a `/` (parent = key up to the last `/`). Group by `(status, parent)`; a group of ≥ `MIN_FOLD` becomes one node. Immediate parent only, so `a/*` and `a/b/*` are distinct folds and a unit is in one fold.
- Fold node: `id = "<status>:<parent>/*"` (unique per status and folder, never a unit key), `key = label = "<parent>/*"`, `status` of its members, `fileCount` summed per side, `fold: string[]` = member keys sorted. `deltaMeta` → `REMOVED · 40 units · files 312`.
- Edges: each end remapped member id → fold id, then merged per `(from, to, status)` with pairs summed per side. Edges inside one fold are removed from the drawing and counted on the fold (`foldEdges`), shown in its ledger row.
- Below `MIN_FOLD` no node changes: without `headUnitEdges` the output is byte-identical to main. With it, only the UNCHANGED edges and the unchanged cut lines differ (tested separately).
- A fold row counts as one row for `MAX_DELTA_LEDGER`, a fold as one unit for `MAX_DELTA_UNITS`.
- Counts line uses the unfolded nodes (counts stay unit counts).

### 2.2 Unchanged edges (B)

- `DeltaEdge.status` gains `"UNCHANGED"`, `pairs = { before: n, after: n }`, rules `[]`.
- Built from `headUnitEdges` after unit selection, ends remapped to fold ids and merged, kept only when both ends are drawn and different. Never creates a node, never enters `select()` degree, never a ledger row.
- **Context fill (GATE-5 decision):** with `headUnitEdges`, free unit slots under `MAX_DELTA_UNITS` (after folding and unit selection, so filled units are never folded) are filled with head units of the map that are not yet nodes, status UNCHANGED, `fileCount {}`, ranked by count of unchanged edges to already drawn nodes, then summed pairs of those edges, then key.  Implementation note: rank candidates once against the changed+context set (no iterative growth). Undrawn unchanged units are counted in a cut line: `N unchanged units not drawn: graph-it architecture --level units --format json`.
- `selectEdges`: violation edges, then changed edges, then unchanged, each by weight; `MAX_DELTA_EDGES` applies to the sum.
- `markCycles`: UNCHANGED edges count as drawn cycle edges on both sides, so `cycleEdgesHidden` is only set when an edge is really missing.

### 2.3 Ledger and cut

- Fold row (rank unit): `REMOVED 40 units packages/app-store/* (files 312; 3 edges inside): a, b, c … and 37 more: graph-it review-pr --base X --head Y --format json`. Names are member keys without the parent, added while the row fits `LEDGER_CELLS = 170` (moved from deltaSvg `MAX_LINE_CELLS`, which imports it); the tail is omitted when every name fits.
- Edge rows label ends by node key (fold key for a fold).
- Cut lines replace `N unchanged unit edges not drawn`:
  - with `headUnitEdges`: `N unchanged unit edges between drawn units not drawn (cap 60): graph-it architecture --level units --format json` when the cap cuts some; `M unchanged unit edges to units not drawn: graph-it architecture --level units --format json` for the rest (one end is an undrawn unchanged unit).
  - without: `N unchanged unit edges not drawn: the review passed no head snapshot` (draws as today otherwise).
  - `graph-it architecture --level units --format json` lists `units` and `unitEdges` of the checked-out tree: when `headRef !== "HEAD"` the line reads `… not drawn: at <head>, graph-it architecture --level units --format json`.

## 3. SVG (`deltaSvg.ts`)

- UNCHANGED edge: kind `down` (muted line colour, `arrow-down` marker), width `DELTA.UNCHANGED.width` (1), solid, same count label in both panels, drawn before changed edges (beneath them).
- Legend sample `UNCHANGED (context)` becomes `UNCHANGED (context unit or edge)`.
- Fold node: same border/status word as its members; the meta line says the unit count.

## 4. Unchanged

`deltaChanged` (a size-only change draws nothing), `deltaUnchangedLine`, CLI options, Review Gate action, `structure` JSON.

## 5. Tests (each a failing case first)

`tests/analyzer/diagram/architectureDelta.test.ts`, `deltaSvg.test.ts`, `deltaFixtures.ts`, `tests/analyzer/ReviewGateAnalyzer*.test.ts`, `architectureReview` test:
- fold of `MIN_FOLD` REMOVED siblings → one node, summed files, one edge per other end with summed pairs, one ledger row with names + command; `MIN_FOLD - 1` without `headUnitEdges` → SVG byte-equal to main; B alone (no fold) changes only edges and cut lines.
- an accepted-violation end stays outside folds.
- context fill: free slots get the unchanged units most linked to drawn ones; never above `MAX_DELTA_UNITS`; none without `headUnitEdges`; the "unchanged units not drawn" count; `at <head>,` prefix when head ≠ HEAD.
- fold never mixes statuses or parents; RENAMED, REWIRED, CHANGED, context and violation ends stay single; a cycle member folds and the ring is on the fold.
- nested `a/*` + `a/b/*`: two folds, each unit once.
- all units of the level in one fold; fold whose only edges reach undrawn units (box drawn, edges in the cut line).
- `gone` collision: REMOVED fold `-…` members and ADDED same keys → two distinct fold ids.
- unchanged edges: drawn in both panels with kind `down`; cap orders them after changed; cut lines with and without `headUnitEdges`; count mismatch → warning.
- `analyzeWithDelta` returns the head map; `analyze()` JSON keys unchanged (snapshot test of the keys).
- `deltaChanged` false on a size-only diff even with `headUnitEdges`.

## 6. Hand-back checks

Estimate: M (model, snapshot plumbing, renderer, tests; no new layer, no `graphit.architecture.json` change).

Existing tests and docs asserting `unchanged unit edges not drawn` are updated (`grep -rn "unchanged unit edge" tests docs`). Docs: `docs/CLI.md` § Architecture delta (folds, unchanged edges, cut lines), CHANGELOG `Unreleased`. Local Sonar on touched files (or the stated limitation). Corrupt or truncated `.graph-it/cache` before `review-pr --deltaSvg`: rebuilds, same SVG.

`npx vitest run` on touched tests with coverage ≥ 80 % per touched file; lint; typecheck; `graph-it check-architecture` 0/0; `npm run build`. Black-box: fixture repo, cal.com (clone --depth 1, commit removing 40 `packages/app-store/*` and renaming 5) via both `diagram --delta` and `review-pr --deltaSvg` → identical SVG, width and height ≤ 4,000 px, opened at real size; private monorepo fresh clone cold and warm, warm `review-pr` time not above main.

## 7. Panels stacked past 4,000 px (human decision, 2026-11-28)

When `2 × (panel + margin) + GAP > 4000`, After is drawn below Before on the same grid (same x per unit); otherwise side by side as before. Unchanged edges join the graph into one component and no ELK option kept the width under 4,000 px on cal.com.
