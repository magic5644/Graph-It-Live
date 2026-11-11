---
name: dead-code-hunter
description: |
  Scan the dependency graph for orphan nodes (uncalled symbols and unreferenced files) and produce
  a safe, ranked deletion plan. Use this skill whenever the user asks about dead code, unused code,
  orphan symbols, unreferenced files, code cleanup, or code hygiene — even if they don't say "dead code"
  explicitly. Also trigger for: "remove unused exports", "find unused functions", "find unused classes",
  "clean up before a refactor", "clean up after removing a feature", "what code is never called",
  "what files are never imported", "before merging this PR let me clean up", "reduce bundle size by
  removing dead code", supprimer code mort, code inutilisé, nettoyer le code, symboles non utilisés,
  exports inutiles.
argument-hint: 'Which project, folder, or file do you want to scan for dead code?'
context: fork
---

# Dead Code Hunter

Systematic scan of the dependency graph to surface orphan symbols and unreferenced files.
Produces a ranked, safety-annotated deletion plan powered by Graph-It-Live.

## Setup, routing and format

- Prefer the Graph-It CLI. At the first activation of any Graph-It skill in a session, run
  `graph-it --version` and `graph-it tool --list` once and share them across Graph-It skills. Requires
  CLI **1.21.0 or later**: if older or unreadable, say so, name the missing commands, offer
  `graph-it update`, and use only what `--help` and `tool --list` show. Do not install the CLI
  automatically. Without it, use only an equivalent MCP tool the host advertises, with its exact
  input schema; otherwise explain the gap.
- Run `graph-it update` only after explicit positive confirmation; silence, timeout, refusal, non-TTY
  or generic Agent mode is not consent, an explicitly pre-authorized automatic mode is. After success,
  refresh version and inventory; a running MCP server needs a host-authorized restart. On failure, keep
  a usable CLI, warn once, do not retry.
- Routing: finding candidates and confirming references always goes through the graph. Read a
  candidate file directly, bounded, only to judge it (dynamic use, framework magic, public API).
- Format: `--format toon` for everything you read; `json` only when a script parses the output.

## When to Use

- Before a major refactor — clean up before you restructure
- After removing a feature — confirm nothing is left dangling
- Periodic code hygiene pass on a growing codebase
- Before onboarding a new developer — reduce noise in the codebase

---

## Workflow — Step by Step

### Step 1 — Pick the workspace root

No `graph-it scan` first: every command restores `.graph-it/cache/`, re-analyzes changed files and
builds the reverse lookup index (who imports what, who calls what) on demand. `--reindex` rebuilds
from scratch when results look wrong.

**Monorepos.** Scanning one package finds candidates faster, but "unused" then means unused *inside
that package*: a sibling package may still import the export. Without `--workspace` the CLI uses the
nearest project marker (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, ...) and exits with
code `3` outside any project; `graph-it -w <dir>` forces the root. If a command prints `Warning: N imports
resolve outside the workspace root`, sibling-package imports are not indexed. Before recommending a
deletion, confirm there is no consumer from the monorepo root
(`graph-it -w <monorepoRoot> tool find_referencing_files --targetPath=<path> --format toon`), or state
that the result is limited to the selected package.

For a large or unfamiliar workspace, take a compact baseline before scanning:

```bash
graph-it architecture --level units --format toon
```

Use it to identify packages, public entry points, and generated areas that require review rather than automatic deletion.

### Step 2 — Run a dead-code scan

```bash
graph-it tool scan_dead_code --format toon
graph-it tool scan_dead_code --scopePath=/abs/src --maxFiles=500 --format toon
graph-it tool scan_dead_code --minConfidence=low --format toon   # every level, for review
graph-it tool scan_dead_code --verbose=true --format toon         # also what was left out, and why
```

Declared entry points are never listed (package.json `main` / `exports` / `bin` / `types`, npm's
default `index.js`, Python scripts, `__main__.py`, `__all__`, a Cargo lib crate's `pub` items, Rust
`#[no_mangle]`), nor JSX/Vue default exports. `--verbose=true` lists them under `excluded` with the
`reason` (`declared:package.json#exports["./x"]`, `convention:framework-default-export`).

Every item carries `confidence`, `reasons` and `evidence` (importer count and first importers). The
default lists `high` items only; `byConfidence` counts the others and `hint` says how to list them:

| Confidence | Reasons | Use in the plan |
|---|---|---|
| `high` | `importers-use-other-exports`: the file is imported, no importer uses the export | Deletion candidate; still run Step 3 for public API and monorepo use |
| `medium` | `test-only-use`, `dynamic-import-in-workspace`, `convention:decorated`, `named-in-own-file` (drop `export` rather than delete), `name-written-elsewhere` (Rust), `convention:test-file`, `named-in-deploy-manifest` (a Dockerfile, serverless, SAM or Procfile names it: a Lambda handler), `convention:generated` (edit the generator's input, not the file), `published-deep-import` (a published package without `exports` the workspace imports by deep path: outside projects may too) | Review; never delete without the evidence of Step 3 |
| `low` | `no-importer`: nothing imports the file | Entry point by convention as often as dead (Lambda handler, Dockerfile `CMD`, `serverless.yml` / SAM handler: these manifests declare nothing): review only |

Methods, nested functions and Rust `impl` members are never reported. Go, Java and C# are not scanned.

`--scopePath` restricts the scan to a directory inside the workspace. Without `--maxFiles` every
analysable file in scope is scanned (no upper bound; about 90 s for 12,000 files). `--maxFiles` caps it
and reports `truncated=true` with `filesBeyondLimit` when reached: report that result as partial. A scan surfaces candidates;
**confirm each high-priority candidate in Step 3 before recommending deletion.**

---

### Step 3 — Per-file confirmation (avoid false positives)

`scan_dead_code` uses static analysis. A symbol may be used dynamically, from outside the indexed
workspace, or through a reference type the scan does not cover. For each symbol candidate, seek
independent incoming-reference evidence, type-only references included. Verify tool names and
parameters with `graph-it tool --list` and `graph-it tool <name> --help` first:

```bash
graph-it tool get_impact_analysis --filePath=/abs/src/a.ts --symbolName=fn --format toon    # runtime and type-only dependents
graph-it tool find_referencing_files --targetPath=/abs/src/a.ts --format toon               # incoming file references
```

`query_call_graph` callers describe call sites and resolved runtime references (`REFERENCES`:
callbacks, JSX components); they are not a complete reference check. For a file candidate, check
incoming file references and separately rule out entry points and public API use. MCP fallback: use
only the host's exact tool name and input schema.

- **Zero call sites alone** → unconfirmed, never a deletion basis
- **Incoming references found** → retain or classify for review (test-only use is not automatically dead)
- **Required reference capability/result missing, partial, or unable to cover relevant types** → unconfirmed; do not recommend deletion
- **No relevant incoming references confirmed** → candidate for manual safety review, not automatic deletion
- **Package-scoped index in a monorepo, no monorepo-root check** → unconfirmed for sibling-package use; say so

Do not use `query_call_graph` callers alone for this check: they hold calls and resolved references only, so a symbol re-exported, passed through a name the graph cannot resolve, or used as a type (MCP and CLI leave `USES` out without `includeTypeOnly`) reports 0 callers while still in use.

A ghost file may contain multiple symbols. Do not recommend deleting it until incoming-reference
checks, entry-point checks, and external/public-use review are complete.

---

### Step 4 — Rank candidates by deletion safety

Apply this risk classification:

| Risk Level | Criteria | Action |
|---|---|---|
| **Candidate for safe review** | No relevant incoming references confirmed (including type-only references when supported); not a public API export or entry point | Review manually before deletion |
| **Possible ghost file** | No incoming file references confirmed and not an entry point | Review file contents and external/public use |
| **Unconfirmed** | Only call sites checked, confirmation unavailable/partial, or relevant reference types unsupported | Do not recommend deletion |
| **Review first** | Symbol is exported from a barrel (`index.ts`) | Check if barrel is consumed externally |
| **Do not delete** | Dynamic call patterns detected (`eval`, string-based dispatch) | Flag only |
| **Test-only** | Only called from test files (`test-only-use`, `medium`) | Evaluate — may be intentional |

---

## Output Format

Write a **Deletion Plan** with the template in `references/report-template.md`: scan totals, possible
ghost files, symbol candidates for manual review, barrel exports to review first, test-only symbols,
then the recommended deletion order. Every row states its reference evidence.

---

## Safety Checklist Before Deleting

- [ ] Re-run the currently advertised workspace scan after any refactor that modified imports (changed files are re-indexed automatically)
- [ ] In a monorepo, confirm each candidate has no consumer from the monorepo root (or state the package-only scope)
- [ ] Check if the project is a **published library** — unused exports may be part of the public API
- [ ] Check `package.json` `exports` field — symbols exported via package entry points are always live
- [ ] Delete the doc comment and decorators above the declaration too: an item's `line` is the declaration's first line, not its JSDoc
- [ ] Run the typecheck and lint after each deletion batch: an import, type or helper only the deleted code used is now unused (TypeScript `noUnusedLocals`, ESLint) — delete it in the same batch
- [ ] Run the test suite after each deletion batch to catch dynamic usage not visible to static analysis
- [ ] Commit in small batches — one file or one symbol group per commit for easy revert

---

## Quick Scan (Single File)

```bash
graph-it check src/utils/format.ts --format toon
```

`find_unused_symbols` is file-scoped; `graph-it check` takes a file, a folder or nothing (the whole
workspace), like `scan_dead_code` with `--scopePath`. Both take `--minConfidence`; a scan
(`graph-it check [folder] --verbose`) also lists the excluded exports with their reason.

---

## Limitations & Future Improvements

- **Dynamic dispatch** (`obj[methodName]()`, `require(variable)`) is invisible to static analysis — always review before deleting
- **Monorepos**: a per-package scan only sees consumers inside that package; an export it reports as unused may be imported by a sibling package. Confirm from the monorepo root before deleting (see Step 1)
- **Framework magic**: decorators (`@Component`, `@Injectable`) may make symbols appear unused but they're resolved at runtime — exclude framework entry files from the scan

## Related Skills

- **graph-it-live** — lower-level access to the full dependency intelligence toolkit: impact analysis, call graphs, codemaps, and more. Use it when you want to explore rather than clean up.
- **onboarding-express** — run a codebase architecture tour before (or after) the dead code sweep, especially when a new developer is joining.
- **pr-review** — review a cleanup diff before merge and inspect its impact evidence.
