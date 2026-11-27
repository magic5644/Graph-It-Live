# AIDD Framework — Graph-It-Live

Multi-agent Scrumban workflow for Graph-It-Live. Process rules (handoffs, rounds, devils, memory) live in `.claude/rules/agent-workflow.md`; this file maps tiers, gates and agents.

## Layout

```
.claude/
├── rules/          versioned rules, loaded by path or task
├── agents/         29 agents (17 core, 5 devils, 7 specialists)
├── commands/       18 /aidd-* commands
└── agent-memory/   one folder per agent, named after the agent (MEMORY.md + retro archives)
```

Agents are invoked by full name (`sophie-code-reviewer`); the first name is used in prose only.

## Who orchestrates

The main conversation runs the `/aidd-*` commands, invokes the agents and holds the human gates: only it can stop for a human answer. `marc-orchestrator` only classifies, routes and reports state; no agent spawns other agents (`Agent` is not in their tools).

## Tiers

Pick the smallest tier that fits; `marc-orchestrator` decides when unsure.

| Situation | Command |
|---|---|
| Unformed idea | `/aidd-brainstorm` |
| Brief or issue to frame (GATE-0) | `/aidd-clarify` |
| Full design phase | `/aidd-clarify` → `/aidd-analyze-req` → `/aidd-design-archi` + `/aidd-design-ux` → `/aidd-security-audit` → `/aidd-plan-mvp` |
| M/L story, cross-layer, new MCP tool, architecture change | `/aidd-feature` |
| S story, one layer, no new MCP tool, no architecture change | `/aidd-quick-win` |
| Suspected bug | `/aidd-bug-hunt` (read-only) |
| Confirmed bug | `/aidd-bugfix` |
| Performance question | `/aidd-optimize` |
| Suspected memory leak | `/aidd-leak-check` (read-only) |
| Security audit of design or existing code | `/aidd-security-audit` |
| One-off technical decision | `/aidd-adr` |
| What to improve next | `/aidd-opportunities` |
| Competitor research | `/aidd-competitive-scan` |
| Existing project never run through AIDD | `/aidd-onboard` |
| Sprint close | `/aidd-sprint-end` |
| Docs only | leo-documentation-writer |
| Dependency update only | sam-dependency-auditor → alex-devops-engineer |
| CI, build or packaging only | alex-devops-engineer, then `/aidd-quick-win` gates |
| Release | `.claude/rules/release.md` with eva-release-manager |
| Multi-file refactor | skill `graph-it-refactor`, then `/aidd-quick-win` or `/aidd-feature` |
| 1–2 file fix | main conversation, no agent |

Manual-only commands (`disable-model-invocation`, heavy or with side effects): `/aidd-feature`, `/aidd-quick-win`, `/aidd-bugfix`, `/aidd-plan-mvp`, `/aidd-onboard`, `/aidd-sprint-end`. Claude may suggest them but never starts them itself.

Every delivery tier ends the same way: branch from `main` → build, lint, typecheck, local Sonar 0 issues → `git push && gh pr create --milestone` in one call → CI green and SonarCloud 0 new issues → human gate → `gh pr merge --rebase --delete-branch`. Nothing is committed or pushed to `main` directly.

## Gates

| Gate | Type | When | Condition |
|---|---|---|---|
| GATE-0 | Human | `/aidd-clarify`, `/aidd-onboard` | Brief or state report approved |
| GATE-1 | Internal | `/aidd-analyze-req` | Stories pass Romain |
| GATE-2 | Internal | `/aidd-bug-hunt`, `/aidd-bugfix` | Root cause validated |
| GATE-3 | Internal | `/aidd-design-archi` | ADRs pass Marine |
| GATE-4 | Human | `/aidd-plan-mvp` | MVP plan approved |
| GATE-5 | Human | `/aidd-feature` | Spec approved before implementation |
| GATE-6 | Human | `/aidd-feature`, `/aidd-quick-win`, `/aidd-bugfix` | Hugo PASS, Sophie APPROVED, PR green, demo or fix accepted |
| GATE-7 | Human | `/aidd-sprint-end` | Retro approved |

Diagnostic tiers (`/aidd-bug-hunt`, `/aidd-optimize`, `/aidd-leak-check`, `/aidd-opportunities`, `/aidd-competitive-scan`) have no human gate: they end with a report the human routes.

## Agents

| Agent | Role | Model | Write access |
|---|---|---|---|
| marc-orchestrator | Router, gate state | sonnet | memory only |
| julie-requirements-analyst | User stories | sonnet | yes |
| paul-spec-writer | Specs, estimates | sonnet | yes |
| antoine-system-architect | System architecture, ADRs | opus | yes |
| clara-frontend-architect | Webview architecture | sonnet | yes |
| camille-ux-designer | VS Code UX | sonnet | yes |
| nathan-security-analyst | Threat models, diff security review | opus | yes |
| ines-performance-analyst | Performance analysis | sonnet | yes |
| lucas-analyzer-developer | `src/analyzer/` | sonnet | yes |
| emma-webview-developer | `src/webview/` | sonnet | yes |
| marco-mcp-developer | `src/mcp/` | sonnet | yes |
| kevin-extension-cli-developer | `src/extension/`, `src/cli/` | sonnet | yes |
| hugo-qa-engineer | QA, coverage gate | sonnet | read-only |
| sophie-code-reviewer | Code review gate | sonnet | read-only |
| alex-devops-engineer | Build, package, CI | sonnet | yes |
| eva-release-manager | Demo, release notes, release | haiku | yes |
| noa-retrospective-facilitator | Retro, memory consolidation | haiku | yes |
| romain-requirements-devil | Challenges Julie | sonnet | read-only |
| julien-spec-devil | Challenges Paul | sonnet | read-only |
| marine-architecture-devil | Challenges Antoine, Clara | opus | read-only |
| adrien-security-devil | Challenges Nathan | opus | read-only |
| theo-code-review-devil | Challenges Sophie | sonnet | read-only |
| victor-benchmark-runner | Measured benchmarks | sonnet | yes |
| diane-competitive-analyst | Competitor research | sonnet | yes |
| leo-documentation-writer | Docs sync | sonnet | yes |
| sam-dependency-auditor | Dependency audit | sonnet | yes |
| diego-bug-investigator | Read-only root cause | opus | read-only |
| mia-memory-leak-auditor | Read-only leak audit | sonnet | read-only |
| iris-opportunity-scout | Debt and product gaps | sonnet | yes |

Model policy: `opus` for rare, high-impact reasoning (architecture, security, root cause); `sonnet` for specs, implementation and reviews; `haiku` for checklists and synthesis. Every agent sets `model` explicitly so a nested call never inherits a costlier model.

## Memory

Each agent's memory is `.claude/agent-memory/<agent-name>/MEMORY.md`.

- Write-capable agents use `memory: project`: the file loads automatically and the agent updates it.
- Read-only agents read the file and return a `MEMORY:` block; the main conversation appends it.
- 3–6 durable bullets per task (decision, verified pattern, recurring trap), under 150 lines per file, in English. `/aidd-sprint-end` consolidates.

## Tests (non-negotiable)

Tests ship with the code, in the same loop. Developers write them; Hugo validates (touched-file coverage ≥ 80%, reproducing test for bugs, edge cases). User-facing behavior also needs VS Code E2E coverage.

## Common pitfalls

- Running the full loop for everything: pick the tier.
- Calling a devil alone: devils challenge a named agent inside a command flow.
- Resuming a finished agent for a new round: start a fresh agent with a five-line handoff.
- Skipping GATE-5 or GATE-6: no implementation without an approved spec, no merge without an accepted demo or fix.
