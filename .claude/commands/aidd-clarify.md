---
description: AIDD GATE-0 entry point — frames a brief or GitHub issue (gaps, constraints, out of scope) into docs/specs/brief.md before any design. Use when a new feature or project needs framing. Not for a vague idea (/aidd-brainstorm) or a bug (/aidd-bug-hunt, /aidd-bugfix).
argument-hint: <issue number, file or brief>
allowed-tools: Read, Write, Bash(gh issue view *), Bash(gh issue list *)
---

# /aidd-clarify — GATE-0

Input: $ARGUMENTS

## Sequence

1. Read the brief: prompt, local file (for example `docs/specs/brief.md`), or GitHub issue (`gh issue view <n>`, `gh issue list --label feature`).
2. Find gaps, ambiguities and unstated constraints (surfaces: VS Code, CLI, MCP; languages; scale; failure cases from `.claude/rules/user-contract.md`).
3. Ask the user at most 5 targeted questions.
4. Write `docs/specs/brief.md`: scope, actors, technical constraints, out of scope, acceptance signal.
5. **Ask the human → GATE-0.**

After GATE-0: run `/aidd-analyze-req`. Single S story: `/aidd-quick-win`.
