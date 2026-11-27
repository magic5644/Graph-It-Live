---
paths:
  - ".agents/agents/**/*.md"
  - ".github/agents/**/*.md"
  - ".github/prompts/**/*.md"
  - ".claude/agents/**/*.md"
  - ".claude/commands/**/*.md"
  - ".claude/agent-memory/**/*.md"
  - ".claude/FRAMEWORK.md"
---

# AIDD Agent Workflow

Apply this file by explicit routing for AIDD orchestration tasks, even when no matched file is open.

## Orchestration

- The main conversation runs the `/aidd-*` commands, invokes agents and holds human gates. marc-orchestrator classifies and routes only; agents never spawn agents.
- Every agent sets `model` explicitly: `opus` for architecture, security and root cause; `sonnet` for specs, implementation and reviews; `haiku` for checklists.

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

## Rounds and Token Budget

- Each correction round goes to a fresh agent with a five-line handoff (item, owned files, criteria, test commands, branch state). Never resume a finished agent with a new round: it reloads its whole history, so every round costs more than the last.
- Resume a running agent only for a short clarification.
- Put every check the orchestrator will run afterwards in the first handoff: black-box runs and failure cases, A/B benchmark (`scripts/bench-e2e.mjs`) on every touched language corpus, visual outputs opened at ≥ 50 units, corrupt or truncated cache input, Sonar. The agent passes them before handing back.
- The orchestrator makes one- or two-file fixes itself. Reviews and mechanical fixes use a smaller model.

## Devil Escalation

- Devil verdict is explicit `PASS` or `BLOCK`, with evidence and required correction.
- Route `BLOCK` back to challenged agent.
- Maximum two devil↔agent correction rounds; persistent disagreement is arbitrated by the main conversation or escalated to the human.
- Never arbitrate away layer isolation violation, demonstrated security bypass, or touched-file coverage below 80%.

## Loop Bounds

- Every return to a developer or spec writer is one correction round, whatever gate raised it (deterministic check, QA, review, security, devil).
- At most two rounds per gate and three per story or bug across all gates. Next failure: stop, report state, open BLOCKs and options to the human.
- CI or SonarCloud failures on a PR: at most two fix pushes, then stop and report.
- An item changes tier at most once (`/aidd-quick-win` ↔ `/aidd-feature`, `/aidd-bug-hunt` ↔ `/aidd-bugfix`, `/aidd-bugfix` → `/aidd-feature`, diagnostic → delivery). A second change goes to the human.
- Diagnostics (`/aidd-bug-hunt`, `/aidd-leak-check`, `/aidd-optimize`) get one follow-up investigation or iteration, then the human decides.
- Never lower a bound to finish faster or raise it to keep going; report instead.

## State and Resume

- `scripts/aidd-state.mjs` holds each item's state in `.claude/aidd-state/<id>.json` (local, written atomically): tier, step order, done and skipped steps, correction rounds, human gate decisions, artifacts, last handoff per agent, running step. It enforces step order and the loop bounds above; exit code 3 = stop and ask the human.
- Start of any stateful command: `node scripts/aidd-state.mjs status <id>`. If the item exists, resume at `next`; an `interrupted` step is rerun with a fresh agent after checking the branch with `git status`. Otherwise `start <id> <tier> [--parent <epic id>]`. `status` without id lists open items after a stop or crash.
- Per step: `begin <id> <step> <agent>` before invoking the agent, `done <id> <step> [--artifact k=path]` (or `skip <id> <step> --reason`) after it; human gates only through `gate <id> GATE-n approve|reject`.
- A BLOCK is `round <id> <step> --reason <text>`: it rewinds to the step to redo and counts against the bounds. Tier changes go through `retier`; extra rounds only through a human `override`.
- State passed between agents = artifacts (spec, ADR, report paths) plus the five-field handoff stored with `handoff <id> <agent> <file>`; the next agent gets the handoff and artifact paths, never a previous agent's raw output.

## Agent Memory Scope

- Each agent uses only `.claude/agent-memory/<agent-name>/MEMORY.md`, not sprint or history files. Write-capable agents load it through `memory: project`; read-only agents read it and return a `MEMORY:` block that the main conversation appends.
- At task end, add 3–6 factual bullets: durable decision, verified pattern, or recurring trap. Never activity logs. Keep each file under 150 lines.
- marc-orchestrator stores gate decisions and arbitration only, not every micro-decision.
- Handoff references relevant memory file rather than copying its contents.
