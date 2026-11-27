---
description: AIDD reduced loop for a trivial S story — short spec, implementation with tests, QA, review, PR, light GATE-6. Use only for one-layer stories with no new MCP tool and no architecture change. Otherwise use /aidd-feature.
argument-hint: <issue number or story>
disable-model-invocation: true
allowed-tools: Read, Write, Agent, Bash(graph-it *), Bash(bash scripts/aidd-gate-check.sh), Bash(npx vitest run *), Bash(npm run build), Bash(npm run lint), Bash(npm run check:types), Bash(gh issue view *), Bash(git status), Bash(git diff *), Bash(node scripts/aidd-state.mjs *)
---

# /aidd-quick-win — Trivial story

Story: $ARGUMENTS

State: tier `quick-win` in `scripts/aidd-state.mjs` — resume with `status <id>`, record every step, `round` on BLOCK; exit 3 = stop and ask the human (`.claude/rules/agent-workflow.md` § State and Resume).

## Eligibility (all required, else `/aidd-feature`)

- Size S, confirmed by marc-orchestrator
- One layer
- No new MCP tool (else Nathan is needed)
- No architecture change (else Antoine is needed)

Follow `.claude/rules/agent-workflow.md` (five-line handoff, fresh agent per round, loop bounds). Any BLOCK in steps 3–7 → back to step 4 as one correction round; three rounds on the story → stop and ask the human. Found ineligible mid-way → `/aidd-feature` once; it never routes back here. If the change fits in 1–2 files, the main conversation implements it directly and skips steps 2–4.

## Sequence

1. Branch from up-to-date `main` (`feat/`, `fix/`, `docs/` or `chore/`); never commit on `main`.
2. **paul-spec-writer**: one paragraph plus a TypeScript interface if needed, with hand-back checks.
3. **julien-spec-devil**: contradictions only.
4. Developer of the layer (lucas / emma / marco / kevin): implementation with tests; black-box failure cases for user-facing changes.
5. `bash scripts/aidd-gate-check.sh`, `graph-it check-architecture`, `npx vitest run <touched tests> --coverage` (≥ 80% per touched file).
6. **hugo-qa-engineer**: targeted tests and edge cases.
7. **sophie-code-reviewer**: diff review (critical checklist, user contract). **theo-code-review-devil** only if the verdict is doubtful. **nathan-security-analyst** if the change touches untrusted input (CLI args, MCP payload, webview messages, paths).
8. `npm run build`, lint, typecheck, local Sonar 0 issues; `git push -u origin <branch> && gh pr create --milestone <current milestone>` in one call; wait for CI green and SonarCloud 0 new issues (at most two fix pushes, then stop and report).
9. **Light GATE-6**: the human approves; then `gh pr merge --rebase --delete-branch`.

## Not needed

julie, romain, antoine, clara, marine, adrien, camille, ines, eva, noa.
