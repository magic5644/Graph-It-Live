---
description: AIDD read-only memory leak audit — Mia checks caches, listeners, WASM instances and workers and returns CONFIRMED/SUSPECTED/NONE per component with evidence. Use when the user suspects a memory leak or growing memory in the extension, CLI, MCP server or workers.
argument-hint: [component or area]
allowed-tools: Read, Agent
---

# /aidd-leak-check — Memory audit

Scope: $ARGUMENTS (default: whole product)

## Sequence

1. **mia-memory-leak-auditor**:
   - Targets: caches (ReverseIndex, spider cache, symbol cache), webview listeners, WASM instances, workers, timers
   - Method: skill `memory-leak-audit`
   - Look for: unsubscribed listeners, closures holding references, Maps/Sets never purged, workers never terminated
   - Reproduce when possible (heap snapshot, `node --inspect`)
2. Report: verdict per component (CONFIRMED / SUSPECTED / NONE) with `file:line` evidence.
3. Confirmed leak → `/aidd-bugfix` (isolated fix) or `/aidd-feature` (structural fix).

## Rule

Read-only: no fix in this command.
