---
description: AIDD full feature loop for one story — spec, GATE-5, implementation with tests, QA, review, security, package, PR, demo, GATE-6. Use for M/L stories, cross-layer work, a new MCP tool or an architecture change. Not for S one-layer stories (/aidd-quick-win) or bugs (/aidd-bugfix).
argument-hint: <issue number or story>
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

# /aidd-feature — Feature loop

Story: $ARGUMENTS

State: tier `feature` in `scripts/aidd-state.mjs` — resume with `status <id>`, record every step, `round` on BLOCK; exit 3 = stop and ask the human (`.claude/rules/agent-workflow.md` § State and Resume).

The main conversation orchestrates and holds the gates. Every agent call follows `.claude/rules/agent-workflow.md`: five-line handoff (CONTEXT, PHASE, BLOCKERS, PRIOR OUTPUTS ≤ 2 lines, ACTION), fresh agent per correction round, loop bounds (two rounds per gate, three per story, then the human decides), 1–2 file fixes made directly without an agent. Announce the estimated cost before each heavy agent.

## GATE-5 — Spec

1. **marc-orchestrator**: classify the story (S/M/L, layers, add-on specialists). If S + one layer + no new MCP tool + no architecture change → stop and run `/aidd-quick-win`, unless the story already came from `/aidd-quick-win` (one tier change only).
2. Run `graph-it architecture --format toon` once; point later agents to the result.
3. **camille-ux-designer** if `package.json` `contributes` or a webview panel changes; **ines-performance-analyst** if indexing, cache, WASM loading or > 1000 files/nodes is involved.
4. **paul-spec-writer**: spec with interfaces, estimate and the developer's hand-back checks.
5. **julien-spec-devil**: PASS/BLOCK per spec. A second round of fixes is made by the main conversation, not a new Paul.
6. **Ask the human → GATE-5.**

## Implementation (after GATE-5)

7. Create the branch from up-to-date `main` (`feat/<issue>-<slug>`); never commit on `main`. Record it: `done <id> branch --artifact branch=<name>` (the merge hook checks it).
8. Developers by layer, in parallel when independent: **lucas-analyzer-developer** (`src/analyzer/`), **emma-webview-developer** (`src/webview/`), **marco-mcp-developer** (`src/mcp/`), **kevin-extension-cli-developer** (`src/extension/`, `src/cli/`). The first handoff lists every check they must pass before handing back: tests with the code, black-box failure cases (`.claude/rules/user-contract.md`), A/B bench `scripts/bench-e2e.mjs` on each touched language corpus, visual outputs at ≥ 50 units, corrupt/truncated cache input, Sonar.
9. Deterministic checks (no agent):
   - `bash scripts/aidd-gate-check.sh` and `graph-it check-architecture` (0 violations, 0 unmatched)
   - `graph-it review-pr --base main --format toon` (breaking changes, impact, missing test candidates)
   - `npx vitest run <touched test files> --coverage` → every touched file ≥ 80%
   - Any BLOCK → back to step 8 with a fresh agent (one correction round).
10. **hugo-qa-engineer**: coverage and edge cases. BLOCK → step 8.
11. In parallel: **sophie-code-reviewer**, then **theo-code-review-devil**; **nathan-security-analyst** on the diff (+ **adrien-security-devil** if a BLOCK is disputed). BLOCK → step 8 (one correction round). After three rounds on this story, stop and ask the human.
12. **alex-devops-engineer**: package and CI check. If `package.json`/`package-lock.json` changed → **sam-dependency-auditor** first.
13. **leo-documentation-writer** if a public API, CLI command, MCP tool, setting or VS Code command changed.

## Delivery

14. `npm run build`, `npm run lint`, `npm run check:types`, local Sonar analysis with 0 issues.
15. Push and open the PR in the same call: `git push -u origin <branch> && gh pr create --milestone <current milestone>`; the PR body contains the *User-facing check* evidence.
16. Wait for CI green and SonarCloud 0 new issues on the PR; fix root causes, never rerun. At most two fix pushes, then stop and report.
17. **eva-release-manager**: demo script and release notes.
18. **Ask the human → GATE-6 (demo).** After approval: `gh pr merge --rebase --delete-branch`.

Record gate decisions in marc-orchestrator memory; append the `MEMORY:` blocks returned by read-only agents to their `.claude/agent-memory/<agent>/MEMORY.md`.
