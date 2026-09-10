---
paths:
  - "src/**/*.{ts,tsx}"
---

# Architecture and TypeScript

- Keep layers distinct: `analyzer` is pure Node analysis; `extension` owns VS Code APIs and orchestration; `mcp` is standalone Node stdio; `webview` is browser React; `shared` contains pure types/utilities.
- Put extension orchestration in `src/extension/services/`. Keep `GraphProvider` as coordinator, not feature implementation.
- Define extension↔webview protocol in `src/shared/types.ts`; update message type, sender, router, and receiver together.
- Prefer `@/` imports for `src/`, named/type-only imports, strict types, and existing naming conventions. Use `SpiderError`/`SpiderErrorCode` when callers branch on failure reason.
- Preserve separate outputs: extension host, CLI, MCP server, workers, file/symbol webview, and call-graph webview.
- After modifying first-party source, run targeted tests, `npm run lint`, `npm run check:types`, and configured SonarQube analysis. Fix new findings before completion.

## Code Style

- Files containing primary classes/components use PascalCase; utility modules use camelCase; existing configuration filenames keep repository convention.
- Types, interfaces, classes, and React components use PascalCase. Variables and functions use camelCase. Constants use SCREAMING_SNAKE_CASE.
- Prefer named imports. Use `import type` or inline `type` modifiers for type-only imports. Follow library-required default import conventions where applicable.
- Prefer `@/` alias for imports rooted in `src/`; use relative imports for tightly local siblings when clearer.
- Include actionable context in errors. Use `SpiderError` and `SpiderErrorCode` when callers need typed branching; preserve original cause/context where supported.
- Comment WHY for non-obvious constraints, not WHAT code already states.

## Change Recipes

- New webview message: add discriminated type in `src/shared/types.ts`, implement relevant extension service handler, register it in `WebviewMessageRouter`, then send/receive typed payload in React.
- New MCP tool: add `McpToolName`, Zod parameter schema and result type, register WHEN/WHY/WHAT description in MCP server, handle worker dispatch, implement execution, and add tests.
