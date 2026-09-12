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

## Requires

Graph-It-Live CLI installed and indexed:

```bash
npm install -g @magic5644/graph-it-live
graph-it scan
```

Check updates:

```bash
graph-it update
```

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

For a large or unfamiliar workspace, take a compact baseline before scanning:

```bash
graph-it architecture --format toon
```

Use it to identify packages, public entry points, and generated areas that require review rather than automatic deletion.

### Step 2 — Run workspace-wide dead code scan

```bash
graph-it check                     # scan entire workspace
graph-it check src/                # scope to a specific folder
graph-it check src/ --format toon  # toon format saves 30-60% tokens
```

Or via the MCP tool directly (supports `scopePath` param):

```bash
graph-it tool scan_dead_code
graph-it tool scan_dead_code --scopePath=/abs/path/src
graph-it tool scan_dead_code --scopePath=/abs/path/src --format=toon
```

This returns a ranked list of dead symbols and ghost files in a single pass. **No per-file loop needed for discovery — use Step 3 to confirm high-priority candidates before deleting.**

---

### Step 3 — Per-file confirmation (avoid false positives)

`scan_dead_code` uses static analysis. A symbol may be called **dynamically** or **from outside the indexed workspace** (e.g. a published library). For high-confidence verification on specific candidates:

```bash
# Who calls this symbol? (0 callers = confirmed dead)
graph-it tool get_symbol_callers --filePath=<absolutePath> --symbolName=<symbol>

# Is this file imported by anything? (0 refs + not an entry point = ghost file)
graph-it tool find_referencing_files --targetPath=<absolutePath>
```

- **0 callers** → confirmed dead code candidate
- **1+ callers** → false positive, discard
- **Only test-file callers** → flag as "test-only symbol", handle separately

A ghost file may contain multiple symbols — mark the entire file for deletion rather than symbol-by-symbol.

---

### Step 4 — Rank candidates by deletion safety

Apply this risk classification:

| Risk Level | Criteria | Action |
|---|---|---|
| **Safe** | 0 callers, 0 referencing files, not a public API export | Delete freely |
| **Ghost file** | 0 referencing files, not an entry point | Delete entire file |
| **Likely safe** | 0 callers confirmed, file has other live symbols | Remove symbol, keep file |
| **Review first** | Symbol is exported from a barrel (`index.ts`) | Check if barrel is consumed externally |
| **Do not delete** | Dynamic call patterns detected (`eval`, string-based dispatch) | Flag only |
| **Test-only** | Only called from test files | Evaluate — may be intentional |

---

## Output Format

Produce a **Deletion Plan** in this format:

---

### Dead Code Scan Report

**Scanned**: `<N>` files | **Candidates found**: `<M>` symbols + `<K>` ghost files

#### Ghost Files (entire file can be deleted)

| File | Last modified | Reason |
|------|--------------|--------|
| `src/utils/oldMigration.ts` | 2022-03-11 | 0 imports, 0 callers, not an entry point |

**Suggested command:**
```bash
# Review first, then:
rm src/utils/oldMigration.ts
```

#### Orphan Symbols — Safe to Remove

| Symbol | File | Kind | Callers |
|--------|------|------|---------|
| `formatLegacyCurrency` | `src/utils/format.ts` | function | 0 |
| `MD5Hash` | `src/services/auth.ts` | function | 0 |

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

1. Ghost files first — highest impact, no surgical precision needed
2. Orphan symbols in non-barrel files — safe, isolated changes
3. Barrel exports — requires checking external consumers
4. Test-only symbols — discuss with the team

---

## Safety Checklist Before Deleting

- [ ] Re-run `graph-it scan` + `graph-it check` after any refactor that modified imports
- [ ] Check if the project is a **published library** — unused exports may be part of the public API
- [ ] Check `package.json` `exports` field — symbols exported via package entry points are always live
- [ ] Run the test suite after each deletion batch to catch dynamic usage not visible to static analysis
- [ ] Commit in small batches — one file or one symbol group per commit for easy revert

---

## Quick Scan (Single File or Folder)

```bash
graph-it scan                                                                     # build/refresh index
graph-it check src/utils/format.ts                                               # per-file unused symbols
graph-it check src/utils/                                                        # scoped folder scan
graph-it tool find_unused_symbols --filePath=/abs/path/src/utils/format.ts       # same as above, MCP tool
```

---

## Limitations & Future Improvements

- **Dynamic dispatch** (`obj[methodName]()`, `require(variable)`) is invisible to static analysis — always review before deleting
- **Monorepos**: scan per package, not at root, to avoid cross-package false positives
- **Framework magic**: decorators (`@Component`, `@Injectable`) may make symbols appear unused but they're resolved at runtime — exclude framework entry files from the scan
- **`graph-it check` is the native single-pass dead code scanner** — `graph-it check` (no args) runs `scan_dead_code` across the whole workspace. Use `graph-it check <folder>` to scope by directory.

## Related Skills

- **graph-it-live** — lower-level access to the full dependency intelligence toolkit: impact analysis, call graphs, codemaps, and more. Use it when you want to explore rather than clean up.
- **onboarding-express** — run a codebase architecture tour before (or after) the dead code sweep, especially when a new developer is joining.
- **pr-review** — review a cleanup diff before merge and inspect its impact evidence.
