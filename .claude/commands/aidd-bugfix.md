---
description: AIDD bug loop without design phase — reproduce, fix with a regression test, QA, review, security, PR, light GATE-6. Use for a confirmed, reproducible bug with known scope. For a suspected bug use /aidd-bug-hunt; for a systemic cross-layer issue use /aidd-feature.
argument-hint: <issue number or bug description>
disable-model-invocation: true
allowed-tools: Read, Write, Agent, Bash(graph-it *), Bash(bash scripts/aidd-gate-check.sh), Bash(npx vitest run *), Bash(npm run build), Bash(npm run lint), Bash(npm run check:types), Bash(gh issue view *), Bash(git status), Bash(git diff *)
---

# /aidd-bugfix — Bug loop

Bug: $ARGUMENTS

No design phase: the scope is already defined. Follow `.claude/rules/agent-workflow.md`. A 1–2 file fix is made by the main conversation directly; the review steps still apply.

## Sequence

1. **Diagnose** (main conversation)
   - Not confirmed yet → run `/aidd-bug-hunt` first.
   - Reproduce: exact steps, error message, `file:line`.
   - Find every caller of the faulty function (`graph-it path-in`, `graph-it trace`); fix the root cause once in shared code.
   - Identify the layer (analyzer / extension / CLI / MCP / webview). Systemic → `/aidd-feature`.
2. Branch `fix/<issue>-<slug>` from up-to-date `main`.
3. **Fix + test** by the developer of the layer: lucas (`src/analyzer/`), emma (`src/webview/`), marco (`src/mcp/`), kevin (`src/extension/`, `src/cli/`).
   - The test reproducing the bug ships with the fix.
   - Critical rules still apply (no vscode in analyzer/MCP, `normalizePath`, etc.).
   - Windows cases when the fix touches paths/Sets/Maps.
   - Black-box failure cases when the bug is user-facing.
4. `bash scripts/aidd-gate-check.sh` and `graph-it check-architecture`. BLOCK → step 3 without an agent.
5. **hugo-qa-engineer**: the reproducing test exists and passes; touched file ≥ 80%. BLOCK → step 3.
6. In parallel:
   - **sophie-code-reviewer**: diff only; vscode imports, `normalizePath`, callbacks, edge cases, user contract. **theo-code-review-devil** if doubtful.
   - **nathan-security-analyst**: diff only; untrusted input (MCP payload, CLI args, webview messages): Zod, limits, paths (CWE-22, null bytes, workspace escape); no project data or absolute paths in logs or errors. **adrien-security-devil** if a BLOCK is disputed.
   - BLOCK → step 3 with a fresh agent, two rounds maximum.
7. `npm run build`, lint, typecheck, local Sonar 0 issues; `git push -u origin <branch> && gh pr create --milestone <current milestone>` in one call; wait for CI green and SonarCloud 0 new issues.
8. **Light GATE-6**: the human confirms the bug is fixed; then `gh pr merge --rebase --delete-branch`.

## Not needed

julie, paul, romain, julien, antoine, clara, marine, camille, ines, eva.
