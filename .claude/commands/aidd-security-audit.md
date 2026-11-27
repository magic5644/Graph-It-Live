---
description: AIDD security audit — Nathan threat-models a validated design or existing code, Adrien (devil) attacks every control. Use after /aidd-design-archi, or on demand to audit existing code (an MCP tool, CLI command, webview, path handling).
argument-hint: [design path | src path or area to audit]
allowed-tools: Read, Write, Agent, Bash(graph-it *)
---

# /aidd-security-audit

Target: $ARGUMENTS

## Mode

- **Design** (default after `/aidd-design-archi`): ADRs in `docs/architecture/` and stories in `docs/specs/requirements/`.
- **Existing code** (a `src/` path or area is given): map entry points of untrusted input with `graph-it path-in` and `graph-it tool get_impact_analysis` before the audit.

## Sequence

1. **nathan-security-analyst** → threat model and required controls (or `path:line: PASS|BLOCK` findings in existing-code mode).
2. **adrien-security-devil** → attack scenario per control, insufficient controls.
3. Nathan strengthens the blocked controls. Two rounds maximum; a demonstrated bypass is never arbitrated away — escalate to the human.
4. Existing-code mode: a vulnerability in released code goes to a private security advisory, never a public issue or PR. Fixes go through `/aidd-bugfix` or `/aidd-feature`.
5. Design mode next: `/aidd-plan-mvp` → GATE-4.
