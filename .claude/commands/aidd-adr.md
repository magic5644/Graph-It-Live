---
description: AIDD one-off architecture decision — Antoine compares options, Marine (devil) challenges, Antoine writes the ADR in docs/architecture/. Use when a single technical decision must be made and recorded outside a feature loop.
argument-hint: <decision to make>
allowed-tools: Read, Write, Agent, Bash(graph-it *)
---

# /aidd-adr — Architecture Decision Record

Decision: $ARGUMENTS

## Sequence

1. Collect context and the options already considered.
2. **antoine-system-architect**: options A/B/C, impact on each layer, fit with `graphit.architecture.json` and `.claude/rules/`, motivated recommendation.
3. **marine-architecture-devil**: reasoning flaws, uncovered edge cases, bundle impact. Two rounds maximum.
4. Antoine writes `docs/architecture/ADR-XXX-<title>.md`: context, options, decision, consequences (positive and negative), date and author.
5. **The human approves** → the ADR goes through a `docs/` branch and PR.
