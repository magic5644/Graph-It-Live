# ADR-776: Architecture units come from declared elements, with finer roles and no fixture units

## Status

Accepted (#776), GATE-5 approved by the maintainer on 2026-11-20.

## Context

The units view (`graph-it architecture --level units`, the `explore_architecture` MCP tool with
`level: "units"`, the `init` report and the VS Code Architecture view) gets its units from one place,
`assignUnits()` in `src/analyzer/architecture/architectureUnits.ts`. That function puts each file in
its deepest folder that holds a project manifest. If no such folder exists, the file goes to `(root)`.
The roles come from `src/analyzer/architecture/unitRoles.ts`. Five call sites copy the same
three steps: `assignUnits` → `buildArchitectureUnits` → `loadDeclaredRoles`. They are the CLI
`architecture.ts`, the MCP `tools/architecture.ts`, `init.ts`, `workspaceDiagram.ts` and
`architectureView.ts` (through `ArchitectureViewService`).

Measured on `main` (b006e5cb) with `graph-it architecture --level units`:

| Workspace | Units today | Problem |
| --- | --- | --- |
| this repository | 6, all `tooling`: `tests` 460, `tests/vscode-e2e` 35, `(root)` 337, 3 fixture projects | 8 declared elements and 9 rules are ignored. `roles["src"]` matches nothing. Half of the units are test data. |
| gson | 7: `gson` library, `graal-native-image-test` tooling, 5 `unknown` (including the test-only `shrinker-test`) | `examples/android-proguard-example` (Ant, no `pom.xml`) sits in `(root)` |
| nuxt.com | 2: `(root)` 556 frontend, `layers/nuxi` 159 library | `app/`, `server/`, `test/` and the root config files form one unit |
| private monorepo | 96 units: 11 `unknown`, 29 `tooling` | `tooling` mixes test suites, fixtures and scripts |

The VS Code view marks a low-confidence role as `[tooling?]`, which says nothing about the evidence.

## Decision

### 1. Declared elements are the units, and rules are drawn on the edges they check

**One source.** A new analyzer module, `src/analyzer/architecture/workspaceUnits.ts`, is the only
code that builds units. Every surface calls it, so the CLI, `init`, MCP and VS Code switch together
by construction:

```ts
export interface WorkspaceUnitsOptions {
  /** Workspace-relative config; false reads none (detected projects only). Default graphit.architecture.json; a missing default file means no config. */
  config?: string | false;
  /** As ArchitectureRulesFileNames.baseline. */
  baseline?: string | false;
}

export interface WorkspaceUnits extends UnitSource {          // UnitSource = { graph, units, assignment } (architectureView.ts)
  /** The detected (manifest) assignment: `unit`/`role` selectors and noCycles "units" read it. */
  detected: UnitAssignment;
  /** The rule check when a config was read (also with no elements: its configWarnings still apply). */
  check?: WorkspaceArchitectureCheck;
}

/** Reads the config and baseline, then calls workspaceUnits. Throws ArchitectureRulesFileError on a refused config. */
export async function loadWorkspaceUnits(graph: ArchitectureGraph, workspaceRoot: string, options?: WorkspaceUnitsOptions): Promise<WorkspaceUnits>;
/** The same from a config held in memory (init's merged config, review's config). */
export function workspaceUnits(graph: ArchitectureGraph, workspaceRoot: string, config?: ArchitectureConfig, baseline?: readonly BaselineEntry[], files?: { configFile: string; baselineFile?: string }): WorkspaceUnits;
```

**Where units come from.** `ArchitectureUnits.unitsFrom` records the source:

- `"elements"`: the config declares at least one element. Each file goes to the **first declared
  element** that selects it, using the existing `resolveElements` membership. An element with
  `each: true` gives one unit per instance, keyed with the existing label, `element (instance)`.
  An element that is first for no file is not a unit. This is what happens to init's
  `acyclic-units`, which is declared after the per-unit elements. Files that no element selects
  form one unit, `(unmatched)`, and add a config warning. The unit is never dropped.
- `"manifests"`: there is no config, the config has no elements, or the caller passes
  `config: false`. The detected projects are used, with the changes in points 3 and 4.

**Element units.** For an element unit:

- `key` is the element name.
- `name` is also the element name, with one exception. An element made of a single `unit` selector
  that selects exactly one detected unit takes that unit's name. A config written by `init` then
  keeps the #774 names.
- `folder` is the deepest folder that holds every file of the unit, or `""`.
- The role is inferred from the unit's files and its `folder`, as in point 2. A unit whose `folder`
  is `""` never gets evidence from the root manifest.
- `roles` patterns in the config match element unit keys and names, as they matched detected
  units before.

**Rule ↔ edge.** A rule *checks* a file pair (source → target) as follows:

| Rule kind | Checks the pair when |
| --- | --- |
| `forbid`, `allowOnly` | the source file belongs to an element listed in `from` (membership, not only the first element) |
| `noCycles: "units"` | source and target are in different **detected projects** (manifest assignment, never element units) |
| `noCycles: <element with each>` | source and target are in different instances of that element |

**Two kinds of cycle, two names.** Once elements are the units, the view's `cycles` (and
`cycleKind` on its edges) are cycles between **element units**. `noCycles: "units"` and the review
gate keep the **detected projects**: `architectureReview.ts` (`unitCyclePairs(graph, assignment)`)
is passed `WorkspaceUnits.detected`, never the element assignment. The config value `"units"` and
the JSON field `unitCycles` keep their names (no config or JSON break). All text that a user
reads names the detected projects:

- the `noCycles: "units"` violation and the review section: `cycle between detected projects a, b`;
- review markdown headings `#### New cycles between detected projects` and `#### Resolved cycles
  between detected projects`, and the summary line `Detected-project cycles: N new, …`;
- the `review_pr` description in `toolDescriptions.ts`: "cycles
  between detected projects";
- the doc comment of `unitCycles` in `ArchitectureReview`.

The view header says `Cycles between declared elements` when `unitsFrom` is `"elements"`.
Rejected: renaming the config value to `"projects"`, which breaks every existing config for a
wording change.

A rule is **attached to a unit edge** when it checks at least one pair of that edge, or when one
of its violations falls on that edge. The **verdict** of a rule on an edge comes from the existing
`checkArchitecture` violations whose pair falls on that edge:

- `violated`: at least one of those violations is new;
- `accepted`: there are violations, and the baseline holds all of them;
- `pass`: there are none.

Rules with `severity: "off"` are never attached. A `forbid` or `allowOnly` rule is also attached
to every unit of an element in its `from`, over the pairs that leave that unit. A leaf rule such as
`shared-is-a-leaf` has no outgoing edge, so it still shows on its unit. When the config has rules
but no elements (only `noCycles: "units"`), the same attachment runs on the manifest units.

**Failure behaviour (user contract):**

- CLI and MCP: a refused config fails the command with the one-line `ArchitectureRulesFileError`
  message (workspace-relative file, JSON path, issue). This is what `loadDeclaredRoles` does
  today. There is no silent fallback.
- VS Code: the Rules panel shows the error, as it does today. The view calls `loadWorkspaceUnits`
  again with `config: false` and states `Units: detected projects (graphit.architecture.json
  refused)` in the header.

*Alternatives:* a hybrid view (elements, plus detected units for unmatched files) mixes two naming
schemes and makes key collisions possible. A CLI flag that turns the switch on (`--units
declared`) would let the surfaces differ, which the issue rules out.

### 2. Roles

```ts
export const UNIT_ROLES = ["application", "function", "micro-frontend", "frontend", "service", "library", "test", "fixture", "tooling", "unknown"] as const;
```

The order is the priority order: a unit takes the first role it has evidence for. A declared role
wins over every inferred one (existing).

**Evidence that drops other evidence.** Test-like evidence is checked before the priority order,
because a test module usually also has a manifest that looks like a product:

| Evidence present | Evidence dropped |
| --- | --- |
| file-kind (`test`, `fixture`, `tooling`: every file is of those kinds) | `library` (#468), `application`, inherited |
| name pattern `test` (below) | `application`, `library`, inherited |

So gson `shrinker-test` (17 of its 18 files under `src/main/java`, no `<packaging>`, an
exec-plugin `<mainClass>`) is `test`. Direct manifest evidence for `function`, `micro-frontend`,
`frontend` and `service` is never dropped: a test package that declares `react` stays frontend.

The new rules:

- **Product importers only.** Only pairs whose source file has kind `other` count as `library`
  evidence (`imported by`). Tests that import a folder no longer make it a library.
- **Inherited evidence.** A unit whose folder holds no manifest reads the manifest of the
  workspace root, when the root holds one. This covers the units created by point 4. The evidence
  detail ends with ` (workspace root manifest)`. Element units with `folder: ""` never inherit.
  The manifest unit `(root)` does not inherit either: its folder is the workspace root, so the
  root manifest and root configs are its own, direct evidence.
- **Unknown has a reason.** A unit with no evidence gets one entry:
  `{ role: "unknown", detail: "no evidence: no manifest field, framework, entry point or product importer found" }`.
  `evidence` is never empty.

**File kinds.** Each file has one kind, from its normalized workspace-relative path. The first
match wins, in the order fixture, then test, then tooling, then `other`:

| Kind | Segment anywhere in the folder path | Segment at the project root only | File name |
| --- | --- | --- | --- |
| fixture | `fixtures`, `__fixtures__`, `fixture`, `testdata`, `test-data` | `examples`, `example`, `samples`, `sample`, `demo`, `demos` | |
| test | `test`, `tests`, `__tests__`, `__mocks__`, `spec`, `specs`, `e2e` | | `*.test.*`, `*.spec.*` (JS/TS), `*_test.go`, `test_*.py`, `*_test.py`, `*Test.java`, `*Tests.java`, `*IT.java`, `*Test.kt`, `*Tests.cs` |
| tooling | `.github` | `scripts`, `script`, `tools`, `bench`, `benchmarks` | tool configs: `{eslint,prettier,stylelint,vitest,jest,playwright,cypress,evalite,karma,commitlint,typedoc,knip}[.*].config.{js,ts,mjs,cjs,mts,cts}` |

- **Project root.** The project root of a file is the deepest folder above it that holds a
  manifest (folded projects included), else the workspace root. A "project root only" segment
  counts only as the **first** folder below that root. `examples/` and `scripts/` at the top of a
  repository count. `src/mcp/tools/`, nuxt.com `server/mcp/tools/`, `layers/nuxi/agent/tools/`
  (project `layers/nuxi`, segment second) and `server/api/examples/` do not: they are product code.
  The kind is a property of the file, so it is the same in manifest and element mode.
- **Configs are an explicit list.** Only the tool configs above are tooling. Every other
  `*.config.*` is `other`: runtime and build configs such as `app.config.*`, `nuxt.config.*`,
  `vite.config.*`, `webpack.config.*`, `next.config.*`, `tailwind.config.*`, `postcss.config.*`
  ship with or build the product. `BUNDLER_CONFIG` stays frontend evidence. `TOOLING_FILE`
  in `unitRoles.ts` (any `*.config.*`) is replaced by this list.

**Evidence per role.** Manifests are only parsed as JSON or searched as text. Nothing is executed.

| Role | Evidence (detail text names the file and field) |
| --- | --- |
| `application` (new) | `package.json` `bin`; `package.json` `engines.vscode` with `main` (editor extension); `pyproject.toml` `[project.scripts]`; `Cargo.toml` `[[bin]]` or `src/main.rs`; `main.go` declaring `package main`; `pom.xml` with `spring-boot-maven-plugin`, or a `<mainClass>` inside the `<plugin>` of `maven-jar-plugin`, `maven-shade-plugin` or `maven-assembly-plugin` (the jar manifest). A `<mainClass>` of `exec-maven-plugin` or any other plugin is not evidence: it runs a tool at build time |
| `function`, `micro-frontend`, `frontend` | unchanged |
| `service` | unchanged, plus `pom.xml` `<packaging>war</packaging>` |
| `library` | imported by another unit through a product pair; `package.json` `exports`, `main` or `module` (without `engines.vscode`); `pom.xml` packaging `jar`, explicit or by default (not `pom`); `Cargo.toml` `src/lib.rs` |
| `test` (new) | every file is test or fixture kind, and test files are the majority; **or** the unit name or folder basename matches `/(^\|[-_.])(tests?\|it\|e2e\|integration-tests?\|testing)$/i` (test-only modules: gson `shrinker-test`, `graal-native-image-test`). The name match drops `application`, `library` and inherited evidence (table above) |
| `fixture` (new) | every file is test or fixture kind, and fixture files are the majority |
| `tooling` | every file is test, fixture or tooling kind, and tooling files are the majority (a tie goes to test, then fixture) |
| `unknown` | none of the above; the reason entry above |

`init` writes no `roles`. Writing inferred roles into the config would turn them into declarations:
wrong guesses would be frozen and lose their dashed border. A config written by `init` selects one
detected unit per element, so the element units have the same files and get the same inferred roles.

*Alternatives:* majority-based file kinds without the "every file" condition would make a package
with more test files than source files a `test` unit. Putting `application` after `service` would
make a VS Code extension that depends on `express` a service.

### 3. Fixture projects fold into their parent

In `assignUnits`, a project folder is not a unit when a **strict ancestor** path segment is a test
folder (`test`, `tests`, `__tests__`, `spec`, `specs`, `e2e`). Its files go to the nearest
enclosing unit: an ancestor project, else the top-level folder unit of point 4. A folder stays a
unit when the config declares it, through a `roles` key or an element `unit` pattern that matches
its key or name. Each pattern keeps only the projects it matches, with the existing `*` glob of
`unitRoles.ts` (`*` matches any characters): `tests/fixtures/*` keeps every project below
`tests/fixtures`, and
`tests/fixtures/a` keeps `a` and not its siblings. A pattern made only of `*` keeps nothing,
because it would keep every fixture.

This repository without a config: `tests/analyzer/fixtures/*`, `tests/demo/legacy-shop` and
`tests/vscode-e2e` fold into `tests`, which then has role `test`. The fold also changes what
`noCycles: "units"` sees (see point 6).

`assignUnits(workspaceRoot, files, declared?: readonly string[])` takes the declared patterns.
`checkGraphArchitecture` and `workspaceUnits` pass `Object.keys(config.roles)` plus every element
`unit` pattern.

*Alternative:* folding only projects under a `fixtures`/`demo` segment would keep
`tests/vscode-e2e`. It misses `src/test/resources/<project>` and gains nothing, because a folded
suite keeps the role `test`.

### 4. One unit per top-level folder instead of a catch-all `(root)`

A file outside every project goes to its top-level folder, using
`folders.find(isProject) ?? folders.at(-1) ?? ROOT_UNIT`. The top-level folder is the first
segment of the path after `normalizePath()`, so a Windows path `src\cli\x.ts` gives `src`, never
`src\cli`. This is the rule that already applies
when the workspace has no project at all. `(root)` keeps only the files that sit directly at the
workspace root. This holds even when the root itself holds a manifest: the split units inherit
that manifest's evidence (point 2).

`UnitAssignment` gains `folders: Map<string, string>`, which maps each unit key to its folder:

- `""` for `(root)`, for `(unmatched)` and for element units that span several folders;
- the key itself for manifest units.

`folderKeys(relativePath, unit, folder)`, `groupByUnit`, `directoryFolderKey` and `folderLevel`
read the folder, never the key. Every command that takes a path uses `unit.folder`: the
`graph-it check <folder> --unreferencedFiles` hints in `architectureAssessment.ts` and
`initReport.ts`, and `init --focus`.

**Configs that name `(root)`.** A `roles` key, or an element `unit` pattern, equal to `(root)`
gets a config warning. The text is the same on every surface:

- `$.roles["(root)"]: "(root)" now holds only the 5 files at the workspace root; files outside every project moved to the units src, scripts, tests, media, .github: name those instead`
- With no root file: `$.roles["(root)"]: "(root)" matches no unit; files outside every project are now in the units …`

At most 10 unit names are listed, followed by `and N more`. A `roles` key that matches no unit, in
either namespace, now also warns: `$.roles["src"]: matches no unit`. Before, it matched nothing
silently, which is how this repository's `roles["src"]` went unnoticed.

*Alternative:* keeping `(root)` whenever the root holds a manifest would keep 337 files in one box
here and `examples` inside `(root)` on gson, so the issue would not be solved.

### 5. The `?` gives way to a dashed border, with the evidence on hover

| Output | Declared role | Inferred role |
| --- | --- | --- |
| VS Code node | badge `[library]`, solid border | badge `[library]` (never `?`), **dashed** border |
| VS Code tooltip | `Role: library, declared by roles["analyzer"] in graphit.architecture.json` | `Role: library, inferred from:` then one evidence per line |
| VS Code legend | | entry `Dashed border: role inferred (hover for the evidence)` |
| SVG / HTML diagram (`graph-it diagram`, `export_architecture_diagram`, `init` page) | solid node | node `stroke-dasharray` from a new `LEGEND` kind `inferred-role` in `diagramStyle.ts`, plus an SVG `<title>` with role and evidence; legend line `dashed border: role inferred` |
| CLI text / markdown | Role column `library`; new **Evidence** column `declared` | new Evidence column: first evidence of the chosen role, cut at 60 cells with `…` |
| JSON / TOON | unchanged `role`, `confidence`, `evidence` | unchanged |

`DiagramNode` gains `confidence?: UnitRoleInfo["confidence"]` and `roleEvidence?: string[]`
(units level only). A colour never tells the two cases apart on its own: the dash pattern does.

### 6. Compatibility

**Config:**

- `roles` values: `tooling` stays valid and keeps its meaning when declared. Configs are never
  remapped.
- Element `role: "tooling"` selectors: when inferred `test` or `fixture` units would have matched
  before, the config warning reads `$.elements.x.role: "tooling" no longer selects test and
  fixture units (a, b); add "test", "fixture" to keep them`.
- `schemas/architecture.schema.json` is regenerated, because the role enum grows. The existing
  test checks it against the Zod schema.
- This repository's `graphit.architecture.json` changes `roles` to element names:
  `shared`/`analyzer` library, `mcp`/`cli`/`extension` application, `webview` frontend, `tooling`
  tooling. `assets` stays inferred. This change is needed because `.claude/rules/architecture.md`
  requires zero config warnings.

**Baselines.** Entries are rule name plus file pair, so `forbid` and `allowOnly` entries on `path`
elements do not change. The following entries go to `resolved` (reported, never dropped silently):

- entries of elements that select `(root)` or a folded fixture project;
- `noCycles: "units"` entries between a folded project and its parent.

**Older `init` configs** (element `root` = `unit: "(root)"`) get the `(root)` warning. Running
`init` again adds elements for the new units. It never deletes an element (existing contract) and
prints the warning.

**JSON output** of `architecture --level units`, `explore_architecture` and the webview message:

| Change | Fields |
| --- | --- |
| added on `ArchitectureUnits` | `unitsFrom`, `configFile?`, `baselineFile?`, `configWarnings?`, `rules?` |
| added on `ArchitectureUnit` | `folder`, `rules?` |
| added on `ArchitectureUnitEdge` | `rules?`, `ruleVerdict?` |
| changed values (**breaking**) | unit keys (`(root)` split, fixtures folded, element names); `role` gains `application`, `test`, `fixture`; `tooling` is narrower; `unknown` units carry one evidence entry |
| renamed or removed | none |

The changelog gets an entry under **Changed — breaking**:

> The units view now draws the elements of graphit.architecture.json when it declares any.
> Without a config, files outside every project form one unit per top-level folder; `(root)` keeps
> only the root files. Fixture projects under a test folder fold into their parent. The `tooling`
> role splits into `test`, `fixture` and `tooling`, and the new `application` role is added.
> Configs that name `(root)` or select `role: "tooling"` get a config warning.

**Cache and index.** There is no change. Units are never persisted: they are computed from the
graph at query time. `context.revision` already hashes unit key, name, role and confidence. It now
also hashes `unitsFrom` and, when there is a config, `check.context.revision` (config and
baseline). A stale webview request is refused as it is today. No index or cache version bump is
needed.

**Performance.** There is no extra scan:

- `workspaceUnits` reuses the graph's nodes and edges.
- Membership is the existing `resolveElements` cost (elements × files × depth).
- Attaching rules is O(rules × cross-unit pairs).
- Manifest reads stay one per unit folder, plus the root manifest once, cached in a per-build
  `Map`.
- The view stops checking twice (`checkRules` plus a separate unit build): it reuses
  `WorkspaceUnits.check`.

Budget: warm and cold `architecture --level units` on this repository and on the private
monorepo within +10% of `main`. `tests/cli/architectureWarmRun.test.ts` must still parse nothing
on a warm run.

**MCP payload.** Edges stay paged by `limit`. `rules` per edge is bounded by the rule count
(at most 256, `MAX_RULES`). `MCP_PAYLOAD_LIMITS.md` does not change.

## Frozen shared contract (`src/shared/architecture-model.ts`)

Set A lands this first, as one commit. Sets B and C start from it and never edit it.

```ts
export const UNIT_ROLES = ["application", "function", "micro-frontend", "frontend", "service", "library", "test", "fixture", "tooling", "unknown"] as const;

/** One rule's result on a unit edge, or on the pairs leaving a unit. */
export interface UnitRuleCheck {
  name: string;
  kind: ArchitectureRuleKind;
  severity: "error" | "warning";
  /** File pairs of the edge (or leaving the unit) the rule checks. */
  checkedPairs: number;
  violations: number;
  newViolations: number;
  /** violated: a new violation; accepted: violations, all in the baseline; pass: none. */
  verdict: "pass" | "accepted" | "violated";
}

export interface ArchitectureUnit {
  /** manifests: folder or "(root)"; elements: element name, "element (instance)" with each, or "(unmatched)". */
  key: string;
  name: string;
  /** Folder holding every file of the unit; "" for (root), (unmatched) or files across top-level folders. Paths for commands come from here, never from key. */
  folder: string;
  // fileCount, internalEdgeCount, layer, role, confidence, evidence: unchanged
  /** forbid/allowOnly rules whose `from` names this unit's element, over the pairs leaving it. */
  rules?: UnitRuleCheck[];
}

export interface ArchitectureUnitEdge {
  // from, to, fileEdgeCount, kind, typeOnlyEdgeCount?, cycleKind?: unchanged
  /** Rules that check at least one pair of this edge, by config order. */
  rules?: UnitRuleCheck[];
  /** Worst verdict of `rules`; absent without rules. */
  ruleVerdict?: UnitRuleCheck["verdict"];
}

export interface ArchitectureUnits {
  // context, units, unitEdges, upwardEdges, cycles, layerCount, roleCounts, totals: unchanged
  unitsFrom: "elements" | "manifests";
  configFile?: string;
  baselineFile?: string;
  /** Present whenever a config was read; the check's warnings plus (unmatched) and overlap warnings. */
  configWarnings?: string[];
  /** Every rule of the config with its totals; absent without rules. */
  rules?: ArchitectureRuleSummary[];
}
```

`unitSecondaryName(unit)` (`src/shared/unitDisplayName.ts`) returns `unit.folder` when it is not
`""` and differs from `unit.name`. Manifest units are unchanged, because their folder equals
their key.

**Analyzer signatures frozen by the contract commit.** A changes these in that commit and never
again; B and C code against them:

| Function (file) | Today | Frozen | Callers |
| --- | --- | --- | --- |
| `loadWorkspaceUnits`, `workspaceUnits` (`architecture/workspaceUnits.ts`, new) | none | as in point 1 (a stub that throws `not implemented` until A lands) | B, C |
| `viewArchitecture` (`architecture/architectureView.ts`) | `(graph, workspaceRoot, maxGroups, declaredRoles?: DeclaredRoles)` | `(graph: ArchitectureGraph, workspaceRoot: string, maxGroups: number, source?: WorkspaceUnits)`; without `source` it calls `workspaceUnits(graph, workspaceRoot)` (no config) | C: `ArchitectureViewService.ts:714` |
| `folderLevel` (`architecture/architectureUnits.ts`) | `(graph, workspaceRoot, folder)` | `(source: UnitSource, folder: string)`; `folder` is a unit key (resolved through `assignment.folders`) or a group key of a folder level; same error text when nothing is below | B: `cli/commands/architecture.ts:140`, `mcp/tools/architecture.ts:48` |

**Analyzer signatures that do not change.** `src/analyzer/diagram/**` (set B) changes
`architectureDiagramInput` inside its body only, to read `source.units.unitEdges[].rules` and the
dashed roles. It calls set A code whose signatures A must keep:

- `architectureDiagramInput(source: UnitSource, workspaceRoot: string, options?: DiagramInputOptions): DiagramInput` (B, kept for its callers);
- `rulesByEdge(violations, keyOf: (file) => string | number | undefined): Record<string, string[]>` (`architectureRules.ts`);
- `unitCyclePairs(graph, assignment: UnitAssignment)` (`architectureRules.ts`, called with the detected assignment);
- `byCodeUnit(left, right)`, `countPair`, `cycleKind`, `UnitPair` (`architectureUnits.ts`);
- `cycleCuts(matrix: ArchitectureMatrix<string>): CycleCut[]` (`architectureAssessment.ts`).

A test in A (`architectureContract.test.ts`) imports each of these with a typed call, so a
signature change fails A's own suite before B rebases.

## Impact on the four layers

| Layer | Files | Change |
| --- | --- | --- |
| shared | `architecture-model.ts`, `unitDisplayName.ts`, `architecture-types.ts` | contract above. E2E state gains `unitLevel.inferredRoleBorders` and `unitLevel.ruledEdges` (C) |
| analyzer | `architecture/{workspaceUnits (new), architectureUnits, unitRoles, architectureRules, architectureReview, architectureView, ArchitectureExplorer, architectureAssessment, architectureInit}.ts`, `diagram/*`, `export/HtmlExporter.ts` | one unit builder; fold, split, kinds, evidence, warnings, rule attachment; review gate keeps the detected assignment and says `detected projects`; diagrams draw inferred roles dashed |
| CLI / MCP | `cli/commands/{architecture, architectureTables, init, initReport, initPage, diagram}.ts`, `mcp/tools/architecture.ts`, `mcp/{toolDescriptions, types, markdownViews}.ts` | call `loadWorkspaceUnits`; Evidence and Rules columns; Config warnings section; descriptions list the new roles |
| extension / webview | `extension/services/ArchitectureViewService.ts`, `webview/components/architecture/{ArchitectureGraph.tsx, architectureElements.ts}` | one `loadWorkspaceUnits` call per build; dashed border, tooltip, legend entry, edge rule tooltips, units-source header |

No `vscode` import enters analyzer or MCP. `graphit.architecture.json` needs no new element: the
new module is under `src/analyzer/`.

## Implementation split (three disjoint worktrees)

| Set | Owns | Starts |
| --- | --- | --- |
| **A, analyzer/shared** | `src/shared/architecture-model.ts`, `src/shared/unitDisplayName.ts`, `src/analyzer/architecture/**` (incl. new `workspaceUnits.ts`), `schemas/architecture.schema.json`, `graphit.architecture.json`, `tests/analyzer/architecture/**` (and snapshots), `tests/shared/unitDisplayName*` | first commit = frozen contract |
| **B, CLI/MCP and static outputs** | `src/cli/commands/{architecture, architectureTables, init, initReport, initPage, diagram}.ts`, `src/mcp/tools/architecture.ts`, `src/mcp/{toolDescriptions, types, markdownViews}.ts`, `src/analyzer/diagram/**`, `src/analyzer/export/HtmlExporter.ts` (shows `unitDisplayName`), `docs/CLI.md`, `changelog.md`, README role lists, `tests/cli/**`, `tests/mcp/**`, `tests/analyzer/diagram/**`, `tests/analyzer/export/HtmlExporter.test.ts`, `tests/integration/architectureUnitsParity.test.ts` | from the contract commit; rebases on A to run |
| **C, extension/webview** | `src/shared/architecture-types.ts`, `src/extension/services/ArchitectureViewService.ts`, `src/webview/components/architecture/**`, `tests/extension/ArchitectureViewService*.test.ts`, `tests/webview/components/architecture/**`, `tests/vscode-e2e/suite/architectureView.test.ts` and its fixture workspace | from the contract commit |

Merge order: A, then B and C in either order. Then the parity test (owned by B) goes green with all
three. Each set runs `graph-it check-architecture` (0 violations, 0 unmatched, 0 config warnings),
lint, typecheck and its targeted tests.

## Test plan

**Unit tests (A).** Each new function gets a success test and an edge or failure test:

- `unitRoles.test.ts`:
  - every evidence row of the table, including the negatives: react without a page or bundler is
    not a frontend; tests importing a folder are not library evidence;
  - file kinds and their precedence (`tests/fixtures/x` is a fixture);
  - project-root-only segments, negatives with these exact paths, all kind `other`:
    `src/mcp/tools/architecture.ts`, `server/mcp/tools/list.ts`,
    `layers/nuxi/agent/tools/run.ts` (project `layers/nuxi`),
    `server/api/examples/code-explorer/[...path].get.ts`; positives `examples/a/B.java`,
    `scripts/x.ts`, `pkg/scripts/x.ts` (project `pkg`) and `.github/a/b.js`;
  - configs: `app/app.config.ts`, `nuxt.config.ts`, `vite.config.ts` are `other`;
    `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `evalite.config.ts`,
    `vitest.e2e.config.mts` are tooling; a `(root)` holding those five gets `frontend` from its
    own `package.json` `vue` and `nuxt.config.ts` (nuxt.com shape), never `tooling`;
  - the test-name pattern on `shrinker-test`, not on `testimony`; a `shrinker-test` fixture with
    17 `src/main/java` files, 1 test file, no `<packaging>` and an `exec-maven-plugin`
    `<mainClass>` is `test`, its evidence lists neither `application` nor `library`;
  - `<mainClass>`: inside `maven-jar-plugin` or `maven-shade-plugin` gives `application`; inside
    `exec-maven-plugin` gives nothing; spring-boot plugin gives `application`;
  - the `<mainClass>` reader is bounded to one `<plugin>` element: the fixture copies gson
    `shrinker-test/pom.xml` shape (a `maven-shade-plugin` without `<mainClass>` before an
    `exec-maven-plugin` with one) and gets no `application` evidence;
  - inherited evidence, and its drop when file-kind or name evidence is present; `(root)` reads
    the root manifest as direct evidence (no ` (workspace root manifest)` suffix);
  - the reason entry for `unknown`.
- `architectureUnits.test.ts`:
  - folding under a test folder; a declared folder preserved; a lone `*` does not preserve;
    `tests/fixtures/a` keeps `a` and folds its sibling `tests/fixtures/b`; `tests/fixtures/*`
    keeps both;
  - the root split; root files keep `(root)`; Windows: `src\cli\x.ts` and `src/cli/x.ts`
    passed through `normalizePath()` both go to unit `src` (test runs on every OS);
  - the `folders` map; `folderKeys` on an element unit with folder `""`.
- `workspaceUnits.test.ts`:
  - first-declared membership, `each` instances, `(unmatched)` with its warning, the overlap
    warning, the name exception for a single `unit` selector;
  - attachment per rule kind, including a violation projected from a second membership;
  - verdicts `pass`, `accepted` and `violated`; unit-level rules on a leaf;
  - `revision` changes when only the config changes; `config: false`; a refused config throws
    `ArchitectureRulesFileError`.
- `architectureReview.test.ts`: `checkGraphArchitecture` keeps returning the detected-project
  assignment, never the element one (set A owns this guarantee); with a config whose elements form a cycle while the detected
  projects do not, `unitCycles` is empty; with a cycle between two detected projects inside one
  element, `unitCycles` holds it and the markdown says `cycle between detected projects a, b`.
- `architectureContract.test.ts`: the frozen and kept signatures above, one typed call each.
- `architectureRules.test.ts`: the four new warnings (`(root)` roles key, `(root)` unit selector,
  a roles key that matches no unit, a `tooling` role selector), and the regenerated schema.
- Goldens (`architectureUnitsGolden`, `workspaces-project.units.json`) are updated and the diff is
  reviewed.
- A mutation check on the verdict and on kind precedence.

**Parity (B, after the merge).** `tests/integration/architectureUnitsParity.test.ts` builds one
temporary workspace with the `rulesWorkspace` helper. It holds 3 elements, one `each`, 2 rules
(one violated, one baselined), a `roles` key `(root)` and one inferred role. It also builds a
second workspace with no config. It compares
`[key, name, folder, role, confidence, fileCount]` for every unit, `[from, to, ruleVerdict,
rules[].name+verdict]` for every edge, and `configWarnings` across three sources:

- the CLI `architecture --level units --format json` (built binary);
- MCP `executeExploreArchitecture({ level: "units", limit: 500 })`;
- the `units` of the `architectureSummary` message from `ArchitectureViewService` (existing
  harness).

**Contract rows.** CLI rows go in `tests/cli/contract.e2e.test.ts` and MCP rows in
`tests/mcp/contract.e2e.test.ts`:

| Case | CLI `architecture --level units` | MCP `explore_architecture` `level: "units"` |
| --- | --- | --- |
| config with elements | exit 0, title says declared elements, Rules table | `unitsFrom: "elements"`, edges with `rules` |
| `roles["(root)"]` | exit 0, `Config warnings:` names the new units | `configWarnings[0]` same text |
| refused config (`roles.x: "nope"`) | exit 1, `graphit.architecture.json: $.roles.x: …` one line, no stack | `isError`, same line |
| unknown unit `--from srx` in elements mode | exit 1, `Unknown unit "srx". Did you mean: …` lists element names | same message |
| every file outside every element | exit 0, one `(unmatched)` unit plus warning, never an empty table | same |
| `init --dry-run` with an old `unit: "(root)"` element | exit 0, warning printed, nothing written | n/a |
| elements `a`, `b` import each other; detected projects have no cycle | `architecture --level units`: cycle `a, b` under `Cycles between declared elements`; `review-pr` on that diff: `Detected-project cycles: 0 new` | `explore_architecture`: `cycles` holds `[a, b]`; `review_pr` `architecture.unitCycles.newViolations` is empty |
| a cycle between two detected projects inside one element | no cycle in the view; `review-pr`: `cycle between detected projects p, q` | `unitCycles.newViolations` holds the pair |

**VS Code E2E (C).** `architectureView.test.ts` on a fixture workspace with 3 elements, 2 rules
(one violated) and one inferred role. It asserts:

- `unitLevel.units === 3`;
- no badge contains `?`;
- `inferredRoleBorders === 1`;
- `ruledEdges` and `violationEdges === 1`;
- the legend holds the dashed entry;
- the header names declared elements.

Failure cases:

- a refused config: the Rules panel shows the error, and the header says detected projects;
- a `(root)` key: the warning appears in the Rules panel.

The PR adds screenshots of the view in light and dark.

**Black-box check (user contract).** Cold and warm runs on this repository, gson, nuxt.com and the
private monorepo (≥ 50 units). The SVG and HTML diagrams and the `init` page are opened and looked
at. One fresh clone. The pasted outcomes go in the PR.

## Expected results

Verified on the corpora with a script that applies points 2 to 4 to the indexed file lists and the
manifests (unit files and kinds, product importers, element membership and rules for this
repository). The implementation PR reruns the real command and pastes the outcome.

| Workspace | Units (role, `*` = inferred) |
| --- | --- |
| this repository (config) | `tooling` 577 tooling, `analyzer` 133 library, `cli` 45 application, `webview` 35 frontend, `extension` 31 application, `mcp` 29 application, `shared` 28 library, `assets` 1 library* (imported by `webview`); 0 `(unmatched)`. 17 edges: `analyzer`→`shared`; `cli`→`analyzer`, `mcp`, `shared`; `extension`→`analyzer`, `mcp`, `shared`; `mcp`→`analyzer`, `shared`; `tooling`→`analyzer`, `cli`, `extension`, `mcp`, `shared`, `webview`; `webview`→`assets`, `shared`. 0 violations. 7 rules on edges (`analyzer-stays-node`, `cli-standalone`, `extension-no-webview-code`, `mcp-standalone`, `product-never-imports-tooling`, `webview-is-browser-code`, `webview-no-analyzer-runtime`); `shared-is-a-leaf` and `assets-are-leaves` on their unit only (no outgoing edge). All 9 visible. `src/mcp/tools/**` (17 files) is kind `other`. 0 config warnings once `roles` is updated (before: `$.roles["src"]` and `$.roles["(root)"]` warnings). |
| gson (no config) | `gson` 203 library* (pom jar by default; 119 test, 84 other files), `shrinker-test` 18 test* (name; `exec-maven-plugin` `<mainClass>` ignored, jar default dropped), `extras` 13 library* (pom jar), `metrics` 6 library* (pom jar), `proto` 4 library* (pom jar), `examples` 3 fixture* (top-level `examples`), `graal-native-image-test` 2 test*. No `(root)` unit (no code file at the root). 0 unknown. |
| nuxt.com (no config) | `server` 211, `app` 206, `shared` 30, `modules` 9, `utils` 1 frontend* (inherited: `vue` and `nuxt.config.ts` at the root; `shared` and `utils` also have product importers, but frontend comes first); `layers/nuxi` 159 library* (imported by `server`); `test` 93 test*; `(root)` 5 frontend* (own `package.json` `vue` and `nuxt.config.ts`; files: 4 tool configs eslint, evalite, playwright, vitest, plus `nuxt.config.ts` kind `other`); `scripts` 1 tooling*. 0 unknown. `server/mcp/tools/**` (26), `layers/nuxi/agent/tools/**` (24 indexed files), `server/api/examples/**` and `app/app.config.ts` are kind `other`. |
| private monorepo | measured in the PR: 99 units (96 before). No project sits under a test folder, so nothing folds, and the old `(root)` splits into 3 top-level units. The 29 `tooling` become 26 `test` and 2 `tooling`; the 10 `unknown` each carry their reason. No names. |

## Risks and mitigation

| Risk | Mitigation |
| --- | --- |
| Inherited root evidence labels `shared/` of nuxt.com as frontend | The evidence says ` (workspace root manifest)`, and the border is dashed. A declared role fixes it. |
| An `init` config later edited with overlapping elements draws files in an unexpected unit | Overlap warning names both elements and the one chosen |
| Users lose sight of detected project keys for `unit` selectors once elements are declared | `matches no unit` warnings list the closest detected keys (open question below) |
| An unlisted tool config (`*.config.*`) or a product folder named `tools` at a project root is misclassified | Both err in one direction each and are listed in the evidence; negative tests pin the known product paths; a declared role fixes a unit |
| The test-name pattern matches a product test-utils library named `testing` | The evidence names the pattern and the border is dashed; a declared role overrides it |
| Breaking JSON for scripts keyed on `(root)` or `tooling` | Changelog **Changed — breaking**; field names are unchanged, so only values move |

## Human decisions (2026-11-20)

1. No surface lists the detected projects once a config declares elements (no `--level projects`).
   The `matches no unit` warnings list the candidate keys.
2. Without a config, `tests/vscode-e2e` folds into `tests`.
3. `init` writes no `roles`.
4. Inherited root evidence keeps its place in the single priority order in this PR (nuxt.com
   `shared` and `utils` stay `frontend`, dashed). Revisit with data from a large monorepo.
5. The 12-tool config list is enough; extend it when a corpus shows a miss.

## Alternatives rejected

- Keep detected units and only paint the elements over them: `src/` would stay one box, and the
  9 rules would still have no edge to sit on.
- One shared `ROLE_ALIASES` map that turns `tooling` into `test|fixture|tooling` in selectors: a
  silent change of meaning, and no way to select only scripts.
- A role confidence scale (`high`/`low`) instead of declared/inferred: the evidence list already
  tells the user why, and a second scale is one more concept on every surface.
