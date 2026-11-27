---
description: AIDD performance analysis — Ines analyzes complexity and caching, Victor measures a baseline, then the gain is measured after the change. Use when the user asks whether a path, command or indexing step can be made faster or lighter.
argument-hint: <file, command or hot path>
allowed-tools: Read, Write, Agent, Bash(node scripts/aidd-state.mjs *)
---

# /aidd-optimize — Performance analysis

Target: $ARGUMENTS

State: tier `optimize` in `scripts/aidd-state.mjs` — resume with `status <id>`, record every step, `round` on BLOCK; exit 3 = stop and ask the human (`.claude/rules/agent-workflow.md` § State and Resume).

## Sequence

1. Confirm the target (file, query, hot path, observed volume, cold or warm run).
2. **ines-performance-analyst**: complexity, bottlenecks, caching strategy, benchmark plan.
3. **victor-benchmark-runner**: BEFORE baseline (measured, never estimated; corpora of `scripts/bench-corpora.json`, cold and warm).
4. Net gain likely → implementation as a separate item (`start <new id> quick-win|feature --parent <id>`) through `/aidd-quick-win` (isolated change) or `/aidd-feature` (structural or cross-layer).
5. After implementation: **victor-benchmark-runner** measures AFTER with the same command.
6. Final report: measured delta (ms, MB, req/s), regressions if any. "Iterate" allows one more change-and-measure round; then the human decides to merge or drop.

## Rule

No code change without a measured baseline. No unmeasured "optimization".
