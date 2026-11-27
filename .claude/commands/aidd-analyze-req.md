---
description: AIDD requirements step after GATE-0 — Julie writes user stories with testable acceptance criteria, Romain (devil) challenges them. Use after /aidd-clarify approval.
argument-hint: [brief path, default docs/specs/brief.md]
allowed-tools: Read, Write, Agent
---

# /aidd-analyze-req — GATE-1 (internal)

Brief: $ARGUMENTS (default `docs/specs/brief.md`)

## Sequence

1. **julie-requirements-analyst** on the brief → `docs/specs/requirements/user-stories.md`.
2. **romain-requirements-devil** on every story → flaws and stories to rework.
3. Julie fixes the blocked stories.
4. Two rounds maximum. Remaining BLOCK → the main conversation arbitrates or asks the human (`.claude/rules/agent-workflow.md`).
5. Save the validated stories in `docs/specs/requirements/`.
6. Next: `/aidd-design-archi`, plus `/aidd-design-ux` in parallel when a story changes commands, settings, views or a webview.
