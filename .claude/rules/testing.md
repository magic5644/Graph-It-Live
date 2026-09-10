---
paths:
  - "tests/**/*.{ts,tsx,js,mjs}"
  - "**/*.test.{ts,tsx,js}"
  - "vitest*.{ts,mts,js,mjs}"
  - "tsconfig.test*.json"
  - "tsconfig.vscode-e2e.json"
---

# Testing and Coverage

- Use Vitest for unit tests. Keep analyzer/MCP tests Node-only, mock WASM, and mock `vscode` completely in extension tests.
- Every new function/module needs primary-success and relevant failure/edge coverage. Bug fixes need a regression test.
- Add VS Code Electron E2E coverage for new commands, settings, or user-visible interactions.
- Keep each touched source file at or above 80% coverage.
- A class instantiated with `new` must use a constructible mock, for example `vi.fn().mockImplementation(function () { ... })`; arrow-function constructor mocks throw.
- Use `@/` imports and existing fixtures. Include Windows separators, drive letters, and case behavior in new path tests.
- Run smallest relevant test during iteration, then required unit/E2E/coverage checks for changed scope.
