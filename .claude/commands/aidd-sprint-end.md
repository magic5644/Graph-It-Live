---
description: AIDD sprint close — retro (3 KEEP / 3 DROP / 3 TRY), GATE-7, memory consolidation, milestone check. Use once per sprint when the user asks to close it.
argument-hint: [milestone]
disable-model-invocation: true
allowed-tools: Read, Write, Agent, Bash(gh pr list *), Bash(gh issue list *), Bash(gh api *), Bash(git log *)
---

# /aidd-sprint-end — GATE-7

Milestone: $ARGUMENTS

Work merges story by story through PRs (`gh pr merge --rebase --delete-branch` after GATE-6). This command never merges or pushes to `main`.

## Sequence

1. Check the sprint is closed: no open PR for the milestone (`gh pr list --search "milestone:<name>" --state open`); report any open PR or issue instead of continuing.
2. **noa-retrospective-facilitator**:
   - Metrics: stories delivered, gates blocked, QA/review verdicts, correction rounds, CI failures
   - 3 KEEP / 3 DROP / 3 TRY
   - Archive in `.claude/agent-memory/noa-retrospective-facilitator/retro-YYYY-MM-DD.md`
3. Present the retro to the human.
4. **Ask the human → GATE-7.**
5. After GATE-7:
   - Apply the approved rule changes (`.claude/rules/*.md` is versioned: branch `chore/` + PR).
   - Record the final sprint state in marc-orchestrator memory.
   - **noa-retrospective-facilitator**: consolidate every `.claude/agent-memory/<agent>/` into its `MEMORY.md` and compress any file above 150 lines. Retro archives stay.
6. Release is separate: follow `.claude/rules/release.md`.
