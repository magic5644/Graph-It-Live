---
paths:
  - ".agents/agents/**/*.md"
  - ".github/agents/**/*.md"
  - ".github/prompts/**/*.md"
  - ".claude/agents/**/*.md"
  - ".claude/commands/**/*.md"
  - ".claude/agent-memory/**/*.md"
  - ".claude/FRAMEWORK.md"
  - "docs/sprints/**/*.md"
---

# AIDD Agent Workflow

Apply this file by explicit routing for AIDD orchestration tasks, even when no matched file is open.

## Mode Boundary

- Plan mode produces analysis, requirements, ADRs, and specifications only. No code changes.
- Implementation starts only after explicit implementation request and required human gate.
- Never cross GATE-0, GATE-4, GATE-5, GATE-6, or GATE-7 without explicit human approval.

## Output Contract

- Agent outputs are compact structured data, not narrative dumps.
- Use TOON for graphs above 50 nodes and preserve schema/key meanings.
- Reviews use one item per line: `path:line: PASS|BLOCK: <finding>. Fix: <required action>`.
- Final review verdict is explicit `APPROVED` or `CHANGES_REQUIRED`.

## Context Compression

- Handoffs contain exactly: CONTEXT, PHASE, BLOCKERS, PRIOR OUTPUTS (maximum two lines), ACTION.
- Never paste complete prior-agent output into next prompt.
- Compress large reports before handoff.
- Generate workspace architecture snapshot once per feature, then reuse it.

## Devil Escalation

- Devil verdict is explicit `PASS` or `BLOCK`, with evidence and required correction.
- Route `BLOCK` back to challenged agent.
- Maximum two devil↔agent correction rounds; persistent disagreement goes to Marc or human.
- Never arbitrate away layer isolation violation, demonstrated security bypass, or touched-file coverage below 80%.

## Agent Memory Scope

- Each agent reads only `.claude/agent-memory/<agent>/KNOWLEDGE.md` at task start, not every sprint/history file.
- At task end, append 3–6 factual bullets: durable decision, verified pattern, or recurring trap. Never append activity logs.
- Marc stores gate decisions and arbitration only, not every micro-decision.
- Handoff references relevant memory file rather than copying its contents.
