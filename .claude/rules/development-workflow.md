---
paths:
  - "src/**/*.{ts,tsx,js,mjs}"
  - "tests/**/*.{ts,tsx,js,mjs}"
  - "scripts/**/*"
  - "esbuild.js"
  - "package*.json"
---

# Development Workflow and Tools

Apply this file by explicit routing for shell-heavy work, repository exploration, refactoring, or codemap maintenance even when no matched file is open.

## RTK

- Prefix shell commands with `rtk`: `rtk git status`, `rtk npm test`, `rtk cargo test`, `rtk docker ps`, `rtk kubectl get pods`.
- Use `rtk proxy <command>` when no optimized wrapper exists.
- Use `rtk gain`, `rtk gain --history`, and `rtk discover` to inspect savings and missed opportunities.

## Graphify

- For architecture, structure, impact, callers, or component-location questions, first use `graphify query "<question>"` when `graphify-out/graph.json` exists.
- Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts.
- Use `graphify-out/wiki/index.md` for broad navigation. Read full report or raw source only when scoped graph lacks needed detail or when editing/debugging exact code.
- Run `graphify update .` after source changes.
- For broad feature/refactor/audit work, generate one workspace snapshot with `graph-it architecture --format toon`, reuse its nodes/edges/counts, then run targeted codemap/call-graph/file-logic queries. For oversized output, rerun with `--maxFiles <N>`.

## Ponytail: lazy senior developer

Stop at first rung that solves requirement correctly:

1. Confirm feature is needed (YAGNI).
2. Reuse existing helper, utility, or pattern.
3. Prefer standard library.
4. Prefer native platform feature.
5. Prefer already-installed dependency.
6. Collapse to one clear line when possible.
7. Only then write minimum new code.

Understand full flow first. Trace callers and fix shared root cause once, not symptom per caller.

- No unrequested abstractions, dependencies, or boilerplate.
- Prefer deletion, boring solutions, and fewest files.
- Smallest correct diff wins; preserve security, accessibility, validation, error handling, and explicit requirements.
- When choosing equally small approaches, choose edge-case-correct one.
- Mark deliberate simplifications with known ceilings using `ponytail:` comment naming ceiling and upgrade path.
- Non-trivial logic needs smallest runnable check that fails when behavior breaks; trivial one-liners need no test.

## Git and Pull Requests

- Use repository Conventional Commit style (`feat:`, `fix:`, `refactor:`, etc.).
- PR descriptions include concise summary, commands and outcomes for validation, screenshots/GIFs for webview UI changes, and relevant issue links.
- Never claim check passed without running it in current session.

## Codemap Maintenance

When explicitly asked to update codemaps:

1. Analyze imports, exports, and dependencies with Graph-It-Live tools.
2. Update token-lean architecture/backend/frontend/data codemaps that actually exist for repository.
3. Calculate structural diff from previous version.
4. If change exceeds 30%, request user approval before replacing codemaps.
5. Add freshness timestamp and save diff report under `.reports/`.
6. Focus on high-level structure, not implementation detail.
