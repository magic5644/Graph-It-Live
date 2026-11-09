---
name: onboarding-express
description: |
  AI-guided architectural tour of any codebase — entry points, business logic, and the most complex
  module in one structured pass, powered by Graph-It-Live. Use this skill whenever someone is new to
  a codebase or wants a quick orientation. Trigger for: "I just joined this team", "explain this repo
  to me", "give me a project overview", "where is the main logic", "what is the entry point",
  "I need to understand the architecture before starting", "walk me through this codebase",
  "which module is the most complex", "find the business logic", "I'm about to refactor and need
  to understand the structure first", onboarding, project walkthrough, architecture tour,
  découvrir le projet, visite guidée, point d'entrée, logique métier, module complexe.
argument-hint: 'Which project or folder do you want to explore?'
context: fork
---

# Onboarding Express

AI-guided architectural tour of any codebase for a new developer.
Powered by Graph-It-Live — extracts entry points, business logic, and the most complex module in one structured pass.

## Setup, routing and format

- Prefer the Graph-It CLI. At the first activation of any Graph-It skill in a session, run
  `graph-it --version` and `graph-it tool --list` once and share them across Graph-It skills. Requires
  CLI **1.21.0 or later**: if older or unreadable, say so, name the missing commands, offer
  `graph-it update`, and use only what `--help` and `tool --list` show. Do not install the CLI
  automatically. Without it, use only an equivalent MCP tool the host advertises, with its schema;
  otherwise explain the gap.
- Run `graph-it update` only after explicit positive confirmation; silence, timeout, refusal, non-TTY
  or generic Agent mode is not consent, an explicitly pre-authorized automatic mode is. After success,
  refresh version and inventory; a running MCP server needs a host-authorized restart. On failure, keep
  a usable CLI, warn once, do not retry.
- Routing: the tour is graph-first (structure, entry points, fan-in). Once a file is selected, read
  it directly and bounded; for a question about one already-known file, skip the tour and read it.
- Format: `--format toon` for everything you read; `json` only when a script parses the output;
  `--format mermaid` only for the critical-path diagram shown to the human.

## Choose the Workspace Root

Graph-It-Live analyzes one workspace root and skips imports that resolve outside it. Without
`--workspace`, the CLI uses the nearest project marker (`package.json`, `pyproject.toml`,
`Cargo.toml`, `go.mod`, `pom.xml`, `*.csproj`, ...) and exits with code `3` outside any project;
`graph-it -w <dir>` forces the root, where `.graph-it/` (index + cache) is created.

- **Monorepo tour, entry points, dependents, cross-package questions**: use
  `graph-it -w <monorepoRoot> <command>` rather than `cd` into a package.
- **One package only**: scan that package and say in the report that siblings are not covered.
- If `scan` prints `Warning: N imports resolve outside the workspace root`, rerun with the
  `--workspace` it names or report the limitation (`graph-it tool get_index_status` reports
  `outOfRootImports` and `monorepoRoot`); never present narrow results as workspace-wide.

## When to Use

- A developer joins the team and needs a codebase overview
- You want to understand an unfamiliar project quickly
- You need to identify where business logic lives before a refactor
- You want to find the most complex/risky module before making changes

---

## Workflow — Step by Step

### Step 1 — Build the index

```bash
graph-it scan
```

Run it once first; all subsequent commands depend on it. It is incremental and cached, so no
timeout wrapper is needed. Check its stderr for the out-of-root warning (see Choose the Workspace Root).

---

### Step 2 — Workspace overview

```bash
graph-it architecture --format toon
```

Parse the output to identify:
- Top-level files and their role
- Candidate **entry point files** (look for: `index`, `main`, `app`, `server`, `cli`, `bootstrap`, `startup` in filenames or in exported symbols)
- Candidate **business logic folders** (look for: `services`, `domain`, `core`, `usecases`, `business`, `handlers`, `controllers`)

If the graph is too large, restrict the initial pass:

```bash
graph-it architecture --maxFiles 300 --format toon
```

---

### Step 3 — Identify the 3 main entry points

For each candidate entry file (max 5), run both directions:

```bash
# Outgoing: what this file calls and imports
graph-it explain <filePath> --format toon

# Incoming: who imports/calls this file
graph-it tool find_referencing_files --targetPath=<path> --format toon
```

`<path>` may be absolute or relative to the workspace root (for example `apps/worker/src/a.ts`).

Rank by:
1. **Highest fan-out** (outgoing) + **0 fan-in** (nothing imports it) → true root entry points
2. **High fan-out** + **few importers** → secondary entry points (e.g., CLI, alternative bootstraps)
3. **High fan-in** (imported by many) + **exports many symbols** → shared core, not an entry point
4. Presence of bootstrap / initialization patterns in the call tree

Select the **top 3** and for each, produce:

> **Entry point `<filename>`** — `<one-line role description>`
> Called by: `<callers or "root — no callers (true entry point)">` 
> Calls into: `<top 3–5 downstream modules>`

---

### Step 4 — Locate the business logic

For each candidate business logic file, run **both directions** to build a complete dependency picture:

```bash
# Outgoing: what this file exports, imports, and calls internally
graph-it tool generate_codemap --filePath=<path> --format toon

# Incoming: who depends on this file across the project
graph-it tool find_referencing_files --targetPath=<path> --format toon
```

The combination of both tells you:
- **generate_codemap** → what the file does (exported symbols, internal call depth, its own dependencies)
- **find_referencing_files** → how central it is (how many other files rely on it)

Look for files that score high on both axes: many exports **and** many importers. A file with rich exports but no importers may be an entry point, public API, or dead-code candidate; confirm references and external use before classifying. A file with many importers but few exports is a utility hub. The real business logic sits at the intersection.

Pick the **1–3 files** with the highest combination of fan-in + exported symbol count. These are the business logic core.

---

### Step 5 — Find the most complex module

For a representative sample of files (top 20 by size, or all files for small projects under 50 files), run:

```bash
graph-it explain <path> --format toon
```

Score each file using this heuristic:

| Signal | Weight |
|---|---|
| Internal call depth (max recursion level) | High |
| Number of internal cycles (circular calls) | High |
| Number of exported symbols | Medium |
| Number of distinct callers (fan-in) | Medium |
| Number of distinct callees (fan-out) | Medium |

The file with the highest combined score is the **most complex module**.

For an open-ended follow-up, use the natural-language query as a hypothesis generator, then
verify the answer with the deterministic scores above:

```bash
graph-it query "which module has the deepest call stack and widest impact" --format toon
```

---

### Step 6 — Trace the critical path

From the highest-scored entry point, trace the full execution chain:

```bash
graph-it trace <entryFile>#<mainFunction> --format mermaid
```

Nodes are named by symbol and workspace-relative file; calls into external modules are dashed
`:::external` nodes. Paste the diagram unchanged into the report.

---

## Output Format

Synthesize steps 3–6 with the template in `references/report-template.md`: the 3 main entry points
(file, role, type), the business logic core (exported symbols, referencing files), the most complex
module with its blast-radius recommendation, and the critical-path Mermaid diagram.

---

## Tips

- On a **monorepo**, tour from the monorepo root with `graph-it -w <monorepoRoot> ...` (see Choose the Workspace Root). Narrow to one package with `graph-it architecture --folder <key> --format toon` or per-package file paths, not by changing the root.
- If the architecture graph returns too much data, tour one unit or folder at a time with `--level units` then `--folder <key>`. `--maxFiles` caps analysed files, not scope: a capped pass is partial, say so.
- If indexing is incomplete or `scan` warns about out-of-root imports, report the unanalysed area rather than guessing.
- The "most complex module" heuristic is architectural, not cyclomatic. For line-level complexity, combine with a linter.
- After the tour, run the **dead-code-hunter** skill to find safe cleanup targets before the new developer starts writing code — a clean codebase is much easier to onboard into.
- For deeper call-graph questions ("what calls this function?", "what breaks if I change X?"), use the **graph-it-live** skill directly.
- Before merging an onboarding-driven change, use **pr-review** to inspect its diff and static-impact limitations.
