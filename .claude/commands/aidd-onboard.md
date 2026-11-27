---
description: AIDD onboarding of an existing codebase — architecture, webview, coverage and debt audit consolidated into a state report and debt backlog for GATE-0. Use once, before any other AIDD command, on a project never run through AIDD.
disable-model-invocation: true
allowed-tools: Read, Write, Agent, Bash(graph-it *)
---

# /aidd-onboard — Existing project

## Sequence

1. Bootstrap: `graph-it architecture --format toon` and `graph-it check-architecture`. Without graph-it: read `AGENTS.md` and `docs/architecture/`.
2. **antoine-system-architect**: layer audit — existing rule violations, missing ADRs, technical debt.
3. **clara-frontend-architect**: webview audit — `webview.js` and `callgraph.js` still separate, callbacks in deps, non-compliant patterns.
4. **hugo-qa-engineer**: current coverage (`npm run test:coverage`), files below 80%.
5. **iris-opportunity-scout**: debt backlog from `graph-it tool scan_dead_code` and `graph-it check`, alongside the Antoine/Clara audit.
6. **marc-orchestrator**: consolidate into `docs/specs/onboarding.md` (state, debt backlog, recommended next tier: `/aidd-brainstorm`, `/aidd-clarify` or `/aidd-opportunities`).
7. **Ask the human → GATE-0.**
