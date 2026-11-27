---
description: AIDD opportunity search — internal debt, competitor gaps and field signals turned into 3–5 prioritized improvements with evidence. Use when the user asks which feature or area of Graph-It-Live to improve next.
argument-hint: [area]
allowed-tools: Read, Write, Agent
---

# /aidd-opportunities — What to improve next

Area: $ARGUMENTS (default: whole product)

## Sequence

1. **iris-opportunity-scout**:
   - `graph-it tool scan_dead_code`, `graph-it check <file>`: measurable debt
   - `gh issue list`: recurring field patterns
   - Past retros (`.claude/agent-memory/noa-retrospective-facilitator/`) and open milestones: postponed work
2. **diane-competitive-analyst**: gaps against comparable tools; reuse a recent `docs/strategy/competitive-*.md` instead of new research.
3. Consolidate: prioritized backlog (user impact, effort S/M/L, risk), evidence per item.
4. Present 3–5 opportunities, each justified.
5. The human chooses → `/aidd-brainstorm` (to refine) or `/aidd-clarify` (ready to frame).
