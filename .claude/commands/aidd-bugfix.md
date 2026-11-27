---
description: AIDD bug loop without design phase — reproduce, fix with a regression test, QA, review, security, PR, light GATE-6. Use for a confirmed, reproducible bug with known scope. For a suspected bug use /aidd-bug-hunt; for a systemic cross-layer issue use /aidd-feature.
argument-hint: <issue number or bug description>
disable-model-invocation: true
allowed-tools: Read, Write, Agent, Bash(graph-it *), Bash(bash scripts/aidd-gate-check.sh), Bash(npx vitest run *), Bash(npm run build), Bash(npm run lint), Bash(npm run check:types), Bash(gh issue view *), Bash(git status), Bash(git diff *), Bash(node scripts/aidd-state.mjs *)
hooks:
  PreToolUse:
    - matcher: "Agent"
      hooks:
        - type: command
          command: 'node "${CLAUDE_PROJECT_DIR}/scripts/aidd-hook.mjs" agent'
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'node "${CLAUDE_PROJECT_DIR}/scripts/aidd-hook.mjs" merge'
---

# /aidd-bugfix — Bug loop

Bug: $ARGUMENTS

State: tier `bugfix` in `scripts/aidd-state.mjs` — resume with `status <id>`, record every step, `round` on BLOCK; exit 3 = stop and ask the human (`.claude/rules/agent-workflow.md` § State and Resume).

No design phase: the scope is already defined. Follow `.claude/rules/agent-workflow.md`, including loop bounds: every BLOCK below is one correction round; three rounds on this bug → stop and ask the human. A 1–2 file fix is made by the main conversation directly; the review steps still apply.

## Sequence

1. **Diagnose** (main conversation)
   - Not confirmed yet → run `/aidd-bug-hunt` first, unless the bug already came from it: then ask the human.
   - Reproduce: exact steps, error message, `file:line`.
   - Find every caller of the faulty function (`graph-it path-in`, `graph-it trace`); fix the root cause once in shared code.
   - Identify the layer (analyzer / extension / CLI / MCP / webview). Systemic → `/aidd-feature` (one tier change).
2. Branch `fix/<issue>-<slug>` from up-to-date `main`. Record it: `done <id> branch --artifact branch=<name>` (the merge hook checks it).
3. **Fix + test** by the developer of the layer: lucas (`src/analyzer/`), emma (`src/webview/`), marco (`src/mcp/`), kevin (`src/extension/`, `src/cli/`).
   - The test reproducing the bug ships with the fix.
   - Critical rules still apply (no vscode in analyzer/MCP, `normalizePath`, etc.).
   - Windows cases when the fix touches paths/Sets/Maps.
   - Black-box failure cases when the bug is user-facing.
4. `bash scripts/aidd-gate-check.sh` and `graph-it check-architecture`. BLOCK → step 3 without an agent (one correction round).
5. **hugo-qa-engineer**: the reproducing test exists and passes; touched file ≥ 80%. BLOCK → step 3 (one correction round).
6. In parallel:
   - **sophie-code-reviewer**: diff only; vscode imports, `normalizePath`, callbacks, edge cases, user contract. **theo-code-review-devil** if doubtful.
   - **nathan-security-analyst**: diff only; untrusted input (MCP payload, CLI args, webview messages): Zod, limits, paths (CWE-22, null bytes, workspace escape); no project data or absolute paths in logs or errors. **adrien-security-devil** if a BLOCK is disputed.
   - BLOCK → step 3 with a fresh agent (one correction round).
7. `npm run build`, lint, typecheck, local Sonar 0 issues; `git push -u origin <branch> && gh pr create --milestone <current milestone>` in one call; wait for CI green and SonarCloud 0 new issues (at most two fix pushes, then stop and report).
8. **Light GATE-6**: the human confirms the bug is fixed; then `gh pr merge --rebase --delete-branch`.

## Not needed

julie, paul, romain, julien, antoine, clara, marine, camille, ines, eva.
