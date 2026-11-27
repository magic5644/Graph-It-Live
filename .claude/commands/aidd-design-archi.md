---
description: AIDD architecture step — Antoine and Clara write ADRs, Marine (devil) challenges them. Use after /aidd-analyze-req when stories need cross-layer or webview design.
argument-hint: [stories path, default docs/specs/requirements/]
allowed-tools: Read, Write, Agent, Bash(graph-it *)
---

# /aidd-design-archi — GATE-3 (internal)

Stories: $ARGUMENTS (default `docs/specs/requirements/`)

## Sequence

1. Run `graph-it architecture --format toon` once; pass the result to both architects.
2. **antoine-system-architect** on the validated stories → ADRs in `docs/architecture/`.
3. **clara-frontend-architect** for webview impact → component architecture and `src/shared/types.ts` messages.
4. **marine-architecture-devil** on every ADR from Antoine and Clara → flaws.
5. Antoine/Clara fix the blocked ADRs. Two rounds maximum; remaining BLOCK → the main conversation arbitrates or asks the human.
6. New `src/` folder or layer relationship → the ADR includes the `graphit.architecture.json` change.
7. Next: `/aidd-security-audit`.
