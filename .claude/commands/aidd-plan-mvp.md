---
description: AIDD MVP plan — Paul writes specs and estimates, Julien (devil) challenges them, producing docs/specs/mvp-plan.md for GATE-4. Use at the end of the design phase, after /aidd-security-audit.
argument-hint: [stories path, default docs/specs/requirements/]
disable-model-invocation: true
allowed-tools: Read, Write, Agent
---

# /aidd-plan-mvp — GATE-4

Stories: $ARGUMENTS (default `docs/specs/requirements/`)

## Sequence

1. **paul-spec-writer** → technical specs for the MVP: prioritized stories, S/M/L/XL estimates, developer per layer, hand-back checks.
2. **julien-spec-devil** → flaws and inconsistencies per spec.
3. The main conversation fixes the blocked specs (no second Paul run unless the change is large). Two rounds maximum.
4. Write `docs/specs/mvp-plan.md`: ordered backlog with estimates; create or link one GitHub issue per story, on the current milestone.
5. **Ask the human → GATE-4.**

After GATE-4: run `/aidd-feature` (or `/aidd-quick-win` for S stories) per story, one story per session.
