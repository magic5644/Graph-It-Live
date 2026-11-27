---
description: AIDD UX step — Camille specifies commands, settings, views, webview layout and messages; Clara checks feasibility. Use after /aidd-analyze-req, in parallel with /aidd-design-archi, when stories change package.json contributes or a webview panel.
argument-hint: [stories path, default docs/specs/requirements/]
allowed-tools: Read, Write, Agent, Bash(node scripts/aidd-state.mjs *)
hooks:
  PreToolUse:
    - matcher: "Agent"
      hooks:
        - type: command
          command: 'node "${CLAUDE_PROJECT_DIR}/scripts/aidd-hook.mjs" agent'
---

# /aidd-design-ux

Stories: $ARGUMENTS (default `docs/specs/requirements/`)

State: epic item (tier `epic`, steps ux) in `scripts/aidd-state.mjs` — resume with `status <id>`, record every step, `round` on BLOCK; exit 3 = stop and ask the human (`.claude/rules/agent-workflow.md` § State and Resume).

## Sequence

1. **camille-ux-designer** on the validated stories → `docs/specs/ux.md`: command titles, labels, tooltips, settings schema (name, type, default, description), text wireframes, error and empty states, UX edge cases.
2. **clara-frontend-architect**: feasibility against both bundles and the message protocol; one round of remarks.
3. Camille updates the spec. No second Clara round; remaining disagreement → the main conversation arbitrates or asks the human.
4. Check against `.claude/rules/user-contract.md`: every failure case has a clear message; visual outputs readable at ≥ 50 units, colour never the only key.
5. Next: `/aidd-security-audit` once `/aidd-design-archi` is done.
