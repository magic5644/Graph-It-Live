---
paths:
  - "src/**/*.{ts,tsx}"
  - "graphit.architecture.json"
---

# Architecture and TypeScript

- Keep layers distinct: `analyzer` is pure Node analysis; `extension` owns VS Code APIs and orchestration; `mcp` is standalone Node stdio; `webview` is browser React; `shared` contains pure types/utilities.
- Put extension orchestration in `src/extension/services/`. Keep `GraphProvider` as coordinator, not feature implementation.
- Define extension↔webview protocol in `src/shared/types.ts`; update message type, sender, router, and receiver together.
- Prefer `@/` imports for `src/`, named/type-only imports, strict types, and existing naming conventions. Use `SpiderError`/`SpiderErrorCode` when callers branch on failure reason.
- Preserve separate outputs: extension host, CLI, MCP server, workers, file/symbol webview, and call-graph webview.
- After modifying first-party source, run targeted tests, `npm run lint`, `npm run check:types`, and configured SonarQube analysis. Fix new findings before completion.

## Architecture Rules (`graphit.architecture.json`)

The layer boundaries above are machine-checked by the repository's own `graphit.architecture.json`. Keep it the single source of truth and keep it passing.

- After any source change that adds, moves, or rewires imports, run `graph-it check-architecture` (or the `graphitlive_check_architecture` MCP tool). Exit code 1 means a new `error` violation: fix the import, not the rule.
- Require 0 violations, 0 `unmatchedFiles`, and no `configWarnings`. A file no element selects escapes every rule.
- New top-level folder under `src/`, new shipped entry point, or new tooling root: add its element and its `allowOnly`/`forbid` rules (with a `reason`) in the same change.
- Changing a layer relationship on purpose: get user approval first, then update the rule and its `reason`, the layer list above, and `AGENTS.md` together, and state the change in the PR summary. Cross-layer redesigns also get an ADR.
- Never weaken a rule (`severity: "warning"`/`"off"`, wider `allowOnly`, removed `forbid`) only to make a check pass. Never add `graphit.architecture.baseline.json`: the repository has no accepted violations.

## Code Style

- Files containing primary classes/components use PascalCase; utility modules use camelCase; existing configuration filenames keep repository convention.
- Types, interfaces, classes, and React components use PascalCase. Variables and functions use camelCase. Constants use SCREAMING_SNAKE_CASE.
- Prefer named imports. Use `import type` or inline `type` modifiers for type-only imports. Follow library-required default import conventions where applicable.
- Prefer `@/` alias for imports rooted in `src/`; use relative imports for tightly local siblings when clearer.
- Include actionable context in errors. Use `SpiderError` and `SpiderErrorCode` when callers need typed branching; preserve original cause/context where supported.
- Comment WHY for non-obvious constraints, not WHAT code already states.

## Change Recipes

- New webview message: add discriminated type in `src/shared/types.ts`, implement relevant extension service handler, register it in `WebviewMessageRouter`, then send/receive typed payload in React.
- New MCP tool: add `McpToolName`, Zod parameter schema and result type, add its WHEN/WHY/WHAT description to `src/mcp/toolDescriptions.ts` (run `npm run sync:tool-descriptions` when an LM tool changes), handle worker dispatch, implement execution, and add tests.
