# Spec: architecture delta diagram (#449, milestone 1.26.2)

Status: GATE-5 approved 2026-11-27 (decisions in section 11).
Depends on: #345 (`ArchitectureStructureDiff`, `docs/specs/2026-11-27-architecture-compare.md`, which listed this as out of scope).
Grammar: ADR 0012 of diagram-design (Before, Changes, After; `data-object-id`, `data-status`, one ledger entry per change).

## 1. Hard rule: one comparison

The delta only **renders** data that #345 already computes. No new matching, no second read of the trees.

- Units and unit edges/cycles: `ArchitectureStructureDiff.units` (`compareStructure`).
- Rule violations: `ArchitectureReview.rules[].newViolations/resolvedViolations` (`compareArchitecture`).
- Both come from one call of `ReviewGateAnalyzer.collectArchitecture` -> `reviewArchitecture(readReviewTrees)`; `review-pr` and `diagram --delta` share it.

## 2. Scope

In: units level; `graph-it diagram --delta --base <ref> [--head <ref>]` (SVG); `graph-it review-pr --deltaSvg <file>`; Review Gate optional artifact + link.
Out (stated, not silent): groups level (the diff exists, the drawing does not); MCP tool; VS Code tab; `--format html|diagram-spec|mermaid` for the delta (exit 4); MOVED status (one shared grid: a unit never moves); REWIRED on an edge (see 4.1).

## 3. Challenges to the proposed direction

1. **"Command that lists all" is not `--format markdown`.** `renderStructureMarkdown` caps each list at 20 (`MAX_MARKDOWN_ITEMS`, `capped()`, architectureStructure.ts:354). The complete list is `graph-it review-pr --base X --head Y --format json` (`structure.units`, `architecture.rules`). Name that command in the cut note.
2. **Unchanged unit edges cannot be drawn.** The diff holds changed edges only (`compared.unchangedEdges` is a count). Drawing "from the diff alone" means context units show only their changed edges; the caption says `N unchanged unit edges not drawn`. A third source (the snapshot) would be a second read: refused.
3. **Do not reuse `layoutDiagram` as is.** It builds cycle compound blocks with `cyclesOf(input.edges)`; the union of base and head edges creates cycles that exist on neither side (removed A->B plus added B->A). It also assigns ELK partitions from layers the diff does not have. New `layoutDelta` (section 6) on the same ELK + `ELK_LAYERED_OPTIONS` with `"elk.partitioning.activate": "false"`, no compounds. Cycles are drawn as a ring plus text on members, never a block.
4. **Collision (d) is real.** Base unit `a` unmatched (Dice < 0.5) gives `REMOVED a`; an unrelated head unit `a` gives `ADDED a`; or `REMOVED a` next to `RENAMED b -> a`. `diffEdges` keeps identity apart (`baseId` prefixes `\u0001`) but then prints both as `a`, so a REMOVED edge `a -> x` cannot say which `a`. Fix at the root (section 4.2), not in the renderer.
5. **`ArchitectureViolation.from/to` are not always unit keys.** They are `label(element, instance)` (equal to the unit key when units come from elements, `workspaceUnits.ts:99`), unit keys for `noCycles`, but also `"(no element)"` or a `", "`-joined list (architectureRules.ts:448, 468). Key space: `newViolations` ends are head labels; `resolvedViolations` ends are **base** labels (architectureReview.ts:137). Before matching, a resolved end is mapped base -> drawn id: a RENAMED item's `previousKey` -> its head key, a REMOVED item's key -> `-<key>`, else unchanged. Rule: an end, once mapped, highlights a node only when it is a unit key of the head or of the mapped base; such a unit joins the drawn set as context. Otherwise (`(no element)`, a joined list) the ledger row says `ends are not units: not drawn`. No node is invented from a string.

## 4. Decisions

### 4.1 REWIRED
Edges carry ADDED / REMOVED / CHANGED (pair count `before -> after`), as in the diff. REWIRED is a **unit** status: a unit absent from `units.items` (same files, same role, same key) that is an endpoint of at least one ADDED or REMOVED edge. It means "its connections changed, not its content". Pure derivation from the diff, no guess. A unit that is only an endpoint of CHANGED edges, cycles or violations is `unchanged` (context). A unit with an item status keeps it (its edge changes appear in the ledger as edge rows).
Dropped: REWIRED on an edge. The diff has no identity beyond `(from, to)`; pairing a removed and an added edge sharing an endpoint would be a second inference. This deviates from ADR 0012 (REWIRED = relationship); stated in the SVG legend and the PR. We do not run `verify-architecture-delta.py` (see 8, open question 1).
RENAMED: one node, label `new (was old)`, id = head key, present in both panels.

### 4.2 Root fix in `compareStructure` (additive)
In `src/shared/architecture-model.ts`:
```ts
export interface StructureEdgeDiff {
  // ...existing
  /** REMOVED only: the ends (`from`/`to`) that are base keys with no head match, i.e. a REMOVED item, not the head item of that key. */
  gone?: ("from" | "to")[];
}
export interface StructureCycleDiff {
  // ...existing
  /** REMOVED only: members that are base keys with no head match. */
  gone?: string[];
}
```
`architectureStructure.ts`: `diffEdges` computes `gone` from the raw base `from`/`to` (before `translateEdges` replaces them with the shown key: `translateEdges` returns the raw ends too) with `!pairs.has(baseKey)` for the REMOVED edges; `diffCycles` sets it for REMOVED cycles. Set only when non-empty, so every unaffected output stays byte-identical. Consumers checked (grep): no Zod output schema on `structure`; `tests/mcp/responseFormatter.test.ts`, `tests/shared/toonSections.test.ts`, `tests/cli/formatter.test.ts`, `tests/analyzer/ReviewGateAnalyzer.test.ts` build their own objects (optional field: unaffected); goldens of `compareStructure` gain `gone` where a REMOVED end is a REMOVED unit. Applies to both levels. ADDED/CHANGED edges and ADDED cycles are in head key space, unique: no flag. Additive JSON field of `review-pr` and the MCP impact tool: changelog line, not breaking.
Node id rule (renderer): `REMOVED` item id = `-<key>`; every other id = `<key>`. A REMOVED edge/cycle end maps to `-<key>` when flagged, else `<key>`.

### 4.3 review-pr option (b)
`graph-it review-pr --base X [--head Y] --deltaSvg <file>`: after `analyze()`, `renderArchitectureDelta(result)` from the structure it already holds, written with `writeWorkspaceFile`. No second read of the trees. CI calls only `review-pr`. Name: camelCase like `--maxFiles`; `commandSpec.ts` `review-pr.options["--deltaSvg"] = "value"`. Written only when `structure.verdict === "changed"`.
`diagram --delta` is the standalone entry (agents, local use) and runs the same pipeline through `ReviewGateAnalyzer.analyzeArchitecture` (6).

### 4.4 Unchanged / empty verdict (c)
- "Changed" for the delta = `structure.verdict === "changed"` **or** `architecture.verdict !== "unchanged"` (a rules-file edit gives new or resolved violations with no structural change: the diagram then shows the violation ends as context units and the ledger lists the violations). Unit cycles drawn are `structure.units.cycles` only; `architecture.unitCycles` (detected projects, another notion) is not drawn.
- `unchanged` (both unchanged): no file, exit 0 (the answer "nothing changed" is a valid result, not a missing target). File mode: one stdout line `No architecture change between <base> and <head> (N units, M unit edges compared): no diagram written.` `--output -`: the line goes to stderr, stdout is empty. A stale file is never touched; the Review Gate removes the file before running.
- `empty` (no analyzable file on either side): `diagram --delta` exit 1 (`GENERAL_ERROR`; exit 3 means "not indexed", wrong meaning), message `No analyzable file at <base> or <head>: nothing to compare.` `review-pr --deltaSvg`: the review itself is the result: stderr line, no file, exit 0.
- `structure` undefined (no snapshot): `diagram --delta` exit 1 naming `limitations`; `review-pr`: stderr line, no file.
Never an empty or placeholder image.

## 5. CLI contract

`diagram`: add `"--delta": "flag"`, `"--base": "value"`, `"--head": "value"` to `commandSpec.ts`.

| Input | Result |
| --- | --- |
| `diagram --delta --base main` (no `--format`: the delta defaults to svg, not html) | SVG to `architecture-delta.svg` (`defaultDiagramFile` gets a `delta` name); stdout `Diagram written to <rel>: <counts>.` Exit 0 |
| `--delta` without `--base` | exit 1 `--delta compares two refs: pass --base <git-ref>` |
| `--base`/`--head` without `--delta` | exit 1 `--base and --head apply to --delta` |
| `--delta` + `--view`, `--folder`, `--spec`, `--rules`, `--config`, `--baseline`, `--maxSteps`, `--startLine`, `--depth`, `--maxMessages`, `--participants`, or a positional | exit 1 `--delta draws the structure diff of two refs: drop <flag>` (first flag found, checked before any indexing) |
| unknown ref | exit 1 `Unknown Git ref "x": pass a branch, tag or commit of this repository.` (`assertCommit`, no `git` text) |
| not a git repo / git missing | exit 1, existing `assertCommit` messages |
| `--format html`, `diagram-spec`, `mermaid`, or `--output x.html` / `x.mmd` / `x.json` without `--format` | exit 4 `graph-it diagram --delta writes --format svg` |
| `--output x.svg` without `--format` | svg, exit 0 |
| `--theme blue` | exit 1, existing `readChoiceOption` message |
| `--format json/csv/...` | exit 4 by `commandSpec` (existing) |
| `--output x.json` with `--format svg` | exit 1 existing `--output ... does not match --format svg` |
| `--output ../x.svg` | exit 5 (`resolveInWorkspace`), before indexing |
| `--output -` | SVG alone on stdout; cut note on stderr |
| `--theme dark` | accepted (svg only) |
| verdict unchanged / empty / no structure | 4.4 |
| `renames.complete === false` | success; every `structure.warnings` entry is drawn in the footer and sent to stderr in full |
| > 40 candidate units | success; cut note (6.3) |

`review-pr --deltaSvg`: missing value exit 1 (`readStringOption`); `-` or non-`.svg` exit 1 `--deltaSvg writes a .svg file of the workspace`; outside workspace exit 5. `--deltaSvg` with `--format sarif|json|toon|markdown` is fine: stdout still holds the review only.
Help (`commandSpec`) and CLI docs list `--delta`, `--base`, `--head`, `--deltaSvg`.

## 6. Interfaces (analyzer, no vscode)

### 6.1 `src/analyzer/ReviewGateAnalyzer.ts`
```ts
export type ArchitectureDeltaSource = Pick<ReviewGateResult, "baseRef" | "headRef" | "architecture" | "structure"> & { limitations: string[] };
/** analyze() minus the symbol work: validateRef + assertCommit + getChangedFiles(base, head, Number.POSITIVE_INFINITY) (only rules-file edits are read from it) + collectArchitecture; throws its `fatal`. Needs the Spider: the CLI calls `runtime.ensureIndexed` after the flag checks. */
async analyzeArchitecture(options: { baseRef: string; headRef?: string }): Promise<ArchitectureDeltaSource>;
```
Extract the shared 4-line prologue (`validateRef` x2, `assertCommit` x2) into a private method used by both. `analyze()` behaviour unchanged.

### 6.2 `src/analyzer/diagram/architectureDelta.ts` (model + layout)
```ts
export const MAX_DELTA_UNITS = 40;        // drawn nodes; tune after opening the SVG on cal.com
export const MAX_DELTA_LEDGER = 60;       // ledger rows
export type DeltaStatus = "ADDED" | "REMOVED" | "CHANGED" | "RENAMED" | "REWIRED" | "UNCHANGED";
export interface DeltaNode {
  id: string;                      // 4.2
  key: string; label: string;      // RENAMED: "new (was old)"
  status: DeltaStatus;
  fileCount: StructureCount; role?: { before?: string; after?: string };
  inCycle?: "ADDED" | "REMOVED"; violations: { new: number; resolved: number };
}
export interface DeltaEdge { from: string; to: string; status: "ADDED" | "REMOVED" | "CHANGED"; pairs: StructureCount; violation?: "new" | "accepted" | "resolved"; rules: string[] }
export interface DeltaLedgerRow { target: string; change: string; text: string }  // unique (target, change)
export interface DeltaModel { refs: { base: string; head: string }; nodes: DeltaNode[]; edges: DeltaEdge[]; ledger: DeltaLedgerRow[]; cut: string[]; counts: string; warnings: string[] }
export function buildDeltaModel(source: ArchitectureDeltaSource): DeltaModel;   // pure, sync
export interface DeltaLayout { model: DeltaModel; width: number; height: number; nodes: (DeltaNode & Box & { text: string; meta: string })[]; edges: (DeltaEdge & { points: Point[] })[]; ... }
export async function layoutDelta(model: DeltaModel): Promise<DeltaLayout>;      // one ELK run
```
Selection: union = units in `units.items` + endpoints of `units.edges` + members of `units.cycles` + violation ends that are units (3.5). One ranking when > `MAX_DELTA_UNITS`: cycle or violation members first, then non-context before context, then changed-edge count descending, ties by `byCodeUnit(key)`. Edges drawn only when both ends are drawn. Input sorted by key so the layout is deterministic. Ledger over `MAX_DELTA_LEDGER`: same priority, rest cut.
`cut` lines (always name the command): `N changed units not drawn (A added, R removed, ...): graph-it review-pr --base <base> --head <head> --format json` plus `K edges, V violations not drawn`. Always (not only past the cap): `M unchanged unit edges not drawn` (`compared.unchangedEdges`), and when `units.movedFiles` is not empty `F files moved between units: not drawn (same command)`; a cycle ring whose unchanged edges are not drawn says so in its meta (`in new cycle · unchanged edges not drawn`). A cut note is in the SVG footer and stderr.
Ledger row text starts with the status word: `ADDED unit billing (12 files)`, `CHANGED edge api -> db (2 -> 5 file pairs)`, `ADDED cycle a, b, c`, `RESOLVED violation no-ui-in-core: ui -> core (3 file pairs)`. One row per `(target, change)`; a unit with two changes (RENAMED + files/role) has one row carrying both facts (the diff holds one status per unit).
Violations: one row per `(rule, from, to, new|accepted|resolved)` with file-pair count; `accepted` is a word in the row, no extra style.

### 6.3 `src/analyzer/diagram/deltaSvg.ts`
```ts
export function renderDeltaSvg(layout: DeltaLayout, theme?: DiagramTheme): string;
export async function renderArchitectureDelta(source: ArchitectureDeltaSource, options?: { theme?: DiagramTheme }):
  Promise<{ markup: string; counts: string; cut: string[]; warnings: string[] }>;
```
`diagramSvg.ts` exports `variables`, `CLASSES`, `markers`, `text` (no copy). Output grammar: `svg[data-diagram="architecture-delta"]`; two `g[data-snapshot="before|after"][data-grid]` at the same local coordinates (only the group translate differs); node `g[data-object-id][data-kind="unit"][data-status][data-signature]` holding `rect[data-role="bounds"]`; edge `path[data-object-id][data-kind="edge"][data-from][data-to][data-status]`; ledger below, full width, `text[data-target][data-change]`. Nodes: Before = union minus ADDED; After = union minus REMOVED; a retained unit has the same x, y in both. Edges: Before = REMOVED + CHANGED (label `before` count); After = ADDED + CHANGED (label `after` count); an edge is drawn in a panel only when both its ends are in that panel.
Status key, shape first, colour second (accent for changes, `error` for violations, `cycle` for the ring, muted for context). Each status has a unique (border width, dash) pair, listed in a drawn legend, and its word in the node's meta line: ADDED thick solid; REMOVED dashed `6 3`; CHANGED dotted `2 3`; RENAMED `8 2 2 2`; REWIRED `12 3 2 3`; UNCHANGED thin solid, meta `context`. CHANGED meta: `files 12 -> 15 · role lib -> app`. Cycle member: outer ring plus meta `in new cycle` / `in resolved cycle`. Edges: ADDED thick solid, REMOVED dashed, CHANGED dotted with label `2 -> 5`; violation edge uses LEGEND `error`. Header counts line in words (`units: 3 added, 1 removed ...`), identical to the numbers of the review-pr structure line (parity test). No `<script`, `<foreignObject`, external URL; every string through `escapeXml`/`fitLabel`; refs and names are untrusted (PR content).

### 6.4 CLI
- `src/cli/commands/diagram.ts`: `runDelta(args, runtime, format)`: flag checks (5) before `ensureIndexed`; same analyzer construction as review-pr (extract `createReviewAnalyzer(runtime)` from `reviewPr.ts`); `renderArchitectureDelta`; `writeDiagram` (reuses the stdout/stderr rule). Per-theme default `light`.
- `src/cli/commands/reviewPr.ts`: `--deltaSvg` after `analyze()`.
- `src/analyzer/diagram/diagramStyle.ts`: `defaultDiagramFile` name for the delta; `DELTA` legend constants.

## 7. Review Gate (`.github/actions/graph-it-review-gate`)

- New input `delta-diagram` (default `"true"`, GATE-5 decision). The action passes `--deltaSvg .graph-it/review/architecture-delta.svg` only when the input is `"true"` **and** the installed CLI is >= 1.26.2 (`verifyCliVersion.mjs` already parses `graph-it --version`: reuse `parseCliVersion`/`compareSemver`, export a `supportsDeltaSvg` check; `local-dist` = the repo build, always supported). An older pinned CLI: no flag, no image, one `::notice::` line naming the version needed; the action never fails for it. The file is inside the workspace (`resolveInWorkspace`), removed with `rm -f` before the run, path and flag passed in `env`, never interpolated.
- The step then sets output `delta-file` only if the file exists (verdict `changed`).
- New step `Upload architecture delta` with `id: delta`, `if: steps.review.outputs.delta-file != ''`, `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2` (the SHA already pinned in `reusable-ci.yml`), `name: graph-it-architecture-delta`, `overwrite: true` (a re-run of the same run), `retention-days: 14`, `if-no-files-found: error`. Needs no write permission.
- `Update review comment` gets `DELTA_ARTIFACT_URL: ${{ steps.delta.outputs.artifact-url }}`. `comment.mjs` passes `{ deltaUrl: process.env.DELTA_ARTIFACT_URL || undefined }` as third argument of `renderReviewComment(result, extensionId, options = {})`. Without a URL the output is byte-identical to today (existing `tests/actions/commentHelpers.test.ts` unchanged). With one, a single line: `Architecture changed: [before / after diagram](<url>) (artifact, zip download).` The URL is accepted only if it matches `^https://github\.com/[^\s)]+$`, else ignored (no link, no throw).
- Fork PRs: the artifact contains only escaped workspace-relative names; the SVG has no script. Same risk class as the comment body.

## 8. Required ADRs and estimate

ADR: none cross-layer (no new layer relationship). Antoine to confirm: (1) `analyzeArchitecture` public on `ReviewGateAnalyzer` (CLI -> analyzer, existing edge); (2) additive `gone` fields on the shared diff (changelog). If Marine objects to the ADR 0012 deviations (4.1), record them in a short ADR.
Estimate **L**: new layout + SVG renderer (the largest part), a root change in `compareStructure`, two CLI surfaces, one composite action change. Not XL: no new data computed, one shared pipeline.

Files: new `architectureDelta.ts`, `deltaSvg.ts` (analyzer/diagram); edit `architecture-model.ts`, `architectureStructure.ts`, `ReviewGateAnalyzer.ts`, `diagramSvg.ts` (exports), `diagramStyle.ts`, `diagram.ts`, `reviewPr.ts`, `commandSpec.ts`, `action.yml`, `comment.mjs`, `commentHelpers.mjs`, docs (CLI reference, review gate README, CHANGELOG line). Layer config: all under existing folders; run `graph-it check-architecture`.

## 9. Acceptance criteria (issue -> checks)

1. Same grid: for every unit drawn in both panels, identical local x/y (unit test on the SVG).
2. ADDED/REMOVED/CHANGED/RENAMED/REWIRED/UNCHANGED, edges ADDED/REMOVED/CHANGED, cycle and violation added/resolved: fixture test below.
3. Status by word + shape: test that the five statuses have unique (width, dash) pairs and that the status word is in each node's meta and ledger row; test passes with colours removed (no `fill`/`stroke` colour in the assertion).
4. Ledger: exactly one row per `(data-target, data-change)`; every non-unchanged drawn object has one; none duplicated.
5. Review Gate: image only when the delta is "changed" (4.4: structure changed or violations differ); absent file leaves comment unchanged. Black-box includes a rules-only change (new rule, no import change).
6. Fixture git repo with two commits: added unit, removed edge, new cycle, resolved violation (+ a rename and a collision case `REMOVED a` / `ADDED a`).

## 10. Hand-back checks for the developer

Unit tests (success + edge/failure, files >= 80 %):
- `buildDeltaModel`: each status; REWIRED derivation; collision `a` (REMOVED edge with `gone`, ADDED edge to head `a`); RENAMED label; cycle ADDED/REMOVED; violation end not a unit (listed, not drawn); accepted vs new; cap at 40 and 60 with the priority order and the cut note naming `review-pr ... --format json`; `compared` unchanged edges in the caption.
- `compareStructure`: `gone` set/absent; existing goldens (`architectureStructureGolden.test.ts`) updated; JSON snapshot of review-pr/MCP impact updated for the additive field.
- `layoutDelta`/`renderDeltaSvg`: determinism (two runs byte-identical), escaping of a unit named `<script>"&'`, no `<script`, `<foreignObject`, `http`, light and dark, data-attribute grammar (parse, do not grep).
- Corrupt input: `ArchitectureStructureDiff` with an edge end absent from items, empty `items`, empty `edges`; a RENAMED-only diff; `verdict` empty/unchanged never reaches the renderer.
- Gate: `renderReviewComment` with/without `deltaUrl`, hostile URL ignored; action workflow lint (`actionlint` if available), env-only inputs.
- Contract: rows in `tests/cli/contract.e2e.test.ts` and `commandSpec.test.ts` for every line of the table in 5 (command x valid / unknown option / invalid value / missing target); `reviewPr.test.ts` for `--deltaSvg`. Fixture repo test on two real commits through the CLI (not mocks), plus the "unchanged" repo (no file written, stdout line, exit 0).
- Black-box as a user, pasted in the PR *User-facing check*: `tests/demo/legacy-shop` (two commits) and cal.com (never private code) with >= 50 changed units: open the SVG, every node labelled, status readable with colours off, cut note present, command in it works; cold and warm timing (warm must not re-read both trees more than review-pr does); a fresh clone without build outputs; unknown ref, no `--base`, each combined flag, `--output ../x.svg`, `--output -`, `--format html`.
- Quality: `graph-it check-architecture` 0 violations / 0 unmatched; lint, `check:types`, `npm run build`; Sonar S3776 <= 15, S4043 `toSorted`, S4624 no nested template literal, S7737, S9382 no `await` in a loop; zero new duplication.

## 11. GATE-5 decisions (human, 2026-11-27)

1. ADR 0012 deviations accepted: REWIRED on units, no MOVED, budget 40 units / 60 rows, `verify-architecture-delta.py` not run (our tests check the shared grid and the ledger).
2. `delta-diagram` default `true`, gated on CLI >= 1.26.2 (section 7).
3. Comment links the artifact (zip); no inline image, no write permission (works on forks).
4. Out of scope confirmed: MCP delta view, VS Code tab.
5. (after the self black-box) "Changed" in 4.4 is topology only: a unit added/removed/renamed or with another role, a unit edge added/removed, a cycle, or a moved rules verdict. File and file-pair counts alone (nearly every PR) draw nothing; the line names how many units and edges only changed size. One predicate: `deltaChanged` in deltaSvg.ts.
