---
description: AIDD read-only bug diagnosis — Diego finds the root cause of a suspected bug with evidence and a confidence level; no code change. Use when the user suspects a bug but nothing is confirmed. For a confirmed bug use /aidd-bugfix.
argument-hint: <symptom>
allowed-tools: Read, Agent, Bash(node scripts/aidd-state.mjs *)
---

# /aidd-bug-hunt — Diagnosis (read-only)

Symptom: $ARGUMENTS

State: tier `bug-hunt` in `scripts/aidd-state.mjs` — resume with `status <id>`, record every step, `round` on BLOCK; exit 3 = stop and ask the human (`.claude/rules/agent-workflow.md` § State and Resume).

## Sequence

1. Collect the symptom: behavior, context, frequency, error message, surface (VS Code, CLI, MCP).
2. **diego-bug-investigator**:
   - Reproduce if possible (exact command, `file:line`).
   - Walk to real callers with `graph-it` (`trace`, `path-in`, `tool get_impact_analysis`, `tool query_call_graph`) before any broad grep.
   - Root-cause hypothesis with evidence; isolated vs systemic; confidence 0–100%.
3. Report: hypothesis, evidence, suspect files, confidence.
4. Confidence ≥ 60% → propose `/aidd-bugfix`. Below 60% → list further investigations and run one follow-up round; still below 60% → report to the human, no forced conclusion.

## Rule

Diagnosis only: no fix in this command.
