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

## Requires

Graph-It-Live CLI installed and indexed:

```bash
npm install -g @magic5644/graph-it-live
graph-it scan
```

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

Always run first. All subsequent commands depend on it.

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
graph-it tool find_referencing_files --targetPath=<absolutePath>
```

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
graph-it tool generate_codemap --filePath=<absolutePath> --format toon

# Incoming: who depends on this file across the project
graph-it tool find_referencing_files --targetPath=<absolutePath>
```

The combination of both tells you:
- **generate_codemap** → what the file does (exported symbols, internal call depth, its own dependencies)
- **find_referencing_files** → how central it is (how many other files rely on it)

Look for files that score high on both axes: many exports **and** many importers. A file with rich exports but no importers is dead code; a file with many importers but few exports is a utility hub. The real business logic sits at the intersection.

Pick the **1–3 files** with the highest combination of fan-in + exported symbol count. These are the business logic core.

---

### Step 5 — Find the most complex module

For a representative sample of files (top 20 by size, or all files for small projects under 50 files), run:

```bash
graph-it tool analyze_file_logic --filePath=<absolutePath>
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
graph-it query "which module has the deepest call stack and widest impact"
```

---

### Step 6 — Trace the critical path

From the highest-scored entry point, trace the full execution chain:

```bash
graph-it trace <entryFile>#<mainFunction> --format mermaid
```

Use `--format mermaid` here because the output is intended for a human — the Mermaid diagram renders as a visual flowchart in VS Code, GitHub, Obsidian, and most Markdown preview panes. For all other graph-it calls in this workflow, prefer `--format toon` (token-efficient, AI-readable).

---

## Output Format

Synthesize steps 3–6 into this structured report:

---

### Project Tour — `<ProjectName>`

**3 Main Entry Points**

| # | File | Role | Type |
|---|------|------|------|
| 1 | `src/index.ts` | Application bootstrap, wires all modules | True entry (no callers) |
| 2 | `src/api/router.ts` | HTTP routing, dispatches to controllers | Called by index.ts |
| 3 | `src/cli.ts` | CLI interface, alternative entry point | True entry (no callers) |

**Business Logic Core**

| File | Exported Symbols | Referenced By |
|------|-----------------|---------------|
| `src/services/orderService.ts` | 12 | 8 files |
| `src/domain/pricing.ts` | 7 | 5 files |

**Most Complex Module**

> `src/services/orderService.ts` — 4 levels of internal call depth, 2 internal cycles, imported by 8 files.
> **Recommendation**: Any change here has high blast radius. Run `get_impact_analysis` before modifying.

**Critical Path (Mermaid)**

```mermaid
<trace output here>
```

---

## Tips

- On a **monorepo**, scope the tour per package: `cd packages/api && graph-it scan` then repeat the workflow.
- If the architecture graph returns too much data, lower `--maxFiles` or tour one package/folder at a time.
- If indexing is incomplete, rerun `graph-it scan` from the package root and report the unanalysed area rather than guessing.
- The "most complex module" heuristic is architectural, not cyclomatic. For line-level complexity, combine with a linter.
- After the tour, run the **dead-code-hunter** skill to find safe cleanup targets before the new developer starts writing code — a clean codebase is much easier to onboard into.
- For deeper call-graph questions ("what calls this function?", "what breaks if I change X?"), use the **graph-it-live** skill directly.
- Before merging an onboarding-driven change, use **pr-review** to inspect its diff and static-impact limitations.
