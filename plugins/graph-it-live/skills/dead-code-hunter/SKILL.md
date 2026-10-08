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

## CLI and Capability Discovery

Prefer the Graph-It CLI. At the first activation of any Graph-It skill in a session, check
`graph-it --version` when the CLI and terminal are available; use only its existing newer-version
notice and do not poll npm. Share discovery, version, and update decisions across Graph-It skills
for the session. Run `graph-it tool --list` once, consult `graph-it --help` or command help as
needed, and refresh only when the CLI/version, server, or workspace changes or a requested tool is
unknown. Examples are illustrative, not a fixed inventory. Do not install automatically. If the
CLI is unavailable or unsuitable, use MCP only when the connected host advertises an equivalent
tool and its schema; otherwise explain the gap. `graph-it tool <name>` invokes analysis directly
through CLI; `graph-it serve` starts MCP. CLI `--format` and MCP `response_format` are distinct.

If the CLI reports a newer version, interactive use requires explicit positive confirmation before
running `graph-it update`; silence, timeout, refusal, non-TTY, or generic Agent mode is not consent.
When automatic mode is explicitly enabled and pre-authorized, default the update decision to yes and
run `graph-it update` without another prompt. After success, refresh the version and `--list`,
invalidate cached capabilities, and advise that a running MCP server needs a host-authorized restart.
On failure, keep using the existing CLI only if it remains usable; otherwise explain the failure
and stop CLI analysis. Warn briefly and do not retry in a loop.

## When to Use

- Before a major refactor — clean up before you restructure
- After removing a feature — confirm nothing is left dangling
- Periodic code hygiene pass on a growing codebase
- Before onboarding a new developer — reduce noise in the codebase

---

## Workflow — Step by Step

### Step 1 — Build/refresh the index

```bash
graph-it scan
```

The reverse lookup index (who imports what, who calls what) is always built automatically — no extra flags needed.

**Monorepos.** Scanning one package is fine for finding candidates (smaller and faster), but there
"unused" means unused *inside that package*: a sibling package may still import the export. Without
`--workspace`, the CLI uses the nearest directory holding `package.json` or `tsconfig.json`;
`graph-it -w <dir>` is used exactly as given, and `.graph-it/` (index + cache) is created there. If
`scan` prints `Warning: N imports resolve outside the workspace root`, imports to or from sibling
packages are not in the index. Before recommending a deletion, confirm there is no consumer from the
monorepo root (`graph-it -w <monorepoRoot> tool find_referencing_files --targetPath=<path>`), or
state in the report that the result is limited to the selected package.

For a large or unfamiliar workspace, take a compact baseline before scanning:

```bash
graph-it architecture --format toon
```

Use it to identify packages, public entry points, and generated areas that require review rather than automatic deletion.

### Step 2 — Run a dead-code scan

If the installed CLI inventory advertises `scan_dead_code`, it can be invoked directly for the
workspace:

```bash
graph-it tool scan_dead_code
```

Use `--format` only as a CLI option supported by the installed command. For MCP, use an equivalent
tool only if the host advertises it, and pass only parameters in its input schema. Restrict scope
only when the current CLI help or MCP schema documents a scope parameter. A scan surfaces
candidates; **confirm each high-priority candidate in Step 3 before recommending deletion.**

---

### Step 3 — Per-file confirmation (avoid false positives)

`scan_dead_code` uses static analysis. A symbol may be used dynamically, from outside the indexed
workspace, or through a reference type the scan does not cover. For each symbol candidate, seek
independent incoming-reference/dependent evidence, including type-only references when the
available capability supports them. Use `get_symbol_dependents` only if the installed CLI
inventory advertises it and its supported parameters are known; for MCP, use only the connected
host's exact tool name and input schema. `query_call_graph` callers, when available, describe call
sites and are not a complete reference check. For a file candidate, check incoming file references
with an advertised equivalent capability and separately rule out entry points/public API use.

- **Zero call sites alone** → unconfirmed, never a deletion basis
- **Incoming references found** → retain or classify for review (test-only use is not automatically dead)
- **Required reference capability/result missing, partial, or unable to cover relevant types** → unconfirmed; do not recommend deletion
- **No relevant incoming references confirmed** → candidate for manual safety review, not automatic deletion
- **Package-scoped index in a monorepo, no monorepo-root check** → unconfirmed for sibling-package use; say so

Do not use `get_symbol_callers` for this check: it returns call sites only, so a symbol passed as a callback, re-exported, or used as a type reports 0 callers while still in use.

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
| **Test-only** | Only called from test files | Evaluate — may be intentional |

---

## Output Format

Produce a **Deletion Plan** in this format:

---

### Dead Code Scan Report

**Scanned**: `<N>` files | **Candidates found**: `<M>` symbols + `<K>` ghost files

#### Possible Ghost Files (confirmation required)

| File | Last modified | Reason |
|------|--------------|--------|
| `src/utils/oldMigration.ts` | 2022-03-11 | No incoming file references confirmed; entry-point and external-use checks completed |

#### Symbol Candidates — Manual Review

| Symbol | File | Kind | Reference evidence |
|--------|------|------|---------|
| `formatLegacyCurrency` | `src/utils/format.ts` | function | Include incoming-reference and type-only check status |
| `MD5Hash` | `src/services/auth.ts` | function | Include incoming-reference and type-only check status |

#### Orphan Symbols — Review First

| Symbol | File | Risk | Note |
|--------|------|------|------|
| `createReport` | `src/api/index.ts` | Barrel export | Check if consumed by external packages |

#### Test-Only Symbols

| Symbol | File | Test callers |
|--------|------|-------------|
| `mockPaymentGateway` | `src/mocks/payment.ts` | 3 test files |

---

### Recommended Deletion Order

1. Complete missing incoming-reference checks; keep unconfirmed candidates out of deletion recommendations
2. Review possible ghost files, public APIs, barrel exports, and external consumers
3. Review remaining symbol candidates and test-only use with the team

---

## Safety Checklist Before Deleting

- [ ] Re-run `graph-it scan` and the currently advertised workspace scan after any refactor that modified imports
- [ ] In a monorepo, confirm each candidate has no consumer from the monorepo root (or state the package-only scope)
- [ ] Check if the project is a **published library** — unused exports may be part of the public API
- [ ] Check `package.json` `exports` field — symbols exported via package entry points are always live
- [ ] Run the test suite after each deletion batch to catch dynamic usage not visible to static analysis
- [ ] Commit in small batches — one file or one symbol group per commit for easy revert

---

## Quick Scan (Single File)

```bash
graph-it scan
graph-it check src/utils/format.ts
```

`graph-it check` is file-scoped in the CLI help observed for this installation. Use a workspace or
folder scan only through a capability and scope parameter documented by the installed CLI or the
connected MCP host schema.

---

## Limitations & Future Improvements

- **Dynamic dispatch** (`obj[methodName]()`, `require(variable)`) is invisible to static analysis — always review before deleting
- **Monorepos**: a per-package scan only sees consumers inside that package; an export it reports as unused may be imported by a sibling package. Confirm from the monorepo root before deleting (see Step 1)
- **Framework magic**: decorators (`@Component`, `@Injectable`) may make symbols appear unused but they're resolved at runtime — exclude framework entry files from the scan
- The installed CLI help describes `graph-it check` as file-scoped. Use a workspace scan only through a currently advertised capability; apply scope only when its help or input schema documents it.

## Related Skills

- **graph-it-live** — lower-level access to the full dependency intelligence toolkit: impact analysis, call graphs, codemaps, and more. Use it when you want to explore rather than clean up.
- **onboarding-express** — run a codebase architecture tour before (or after) the dead code sweep, especially when a new developer is joining.
- **pr-review** — review a cleanup diff before merge and inspect its impact evidence.
