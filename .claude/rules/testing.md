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
- Enumerate edge cases before writing tests (shadowing, unknown/missing target, repeated or nested use, type-only, JS and TS variants) and cover each.
- Bug fix: check whether the same defect affects the other supported languages (TS/JS, Python, Go, Rust, Java, C#); fix shared causes together, otherwise list the affected languages in the PR and open a follow-up issue.
- Add VS Code Electron E2E coverage for new commands, settings, or user-visible interactions.
- E2E suites share one workbench and run in unsorted glob order (Linux order differs from macOS). A suite restores in `finally` every workbench change it makes (theme, settings, panels, editor layout). Never hide workbench parts (sidebar, auxiliary bar), not even for local screenshots: their visibility cannot be read back, so it cannot be restored; crop the screenshot instead. Before pushing a new or changed suite, run it first together with the layout-sensitive one: `E2E_SUITE_GLOB='suite/@(<suite>|architectureView).test.js'`.
- Pull request CI runs the E2E suites on Linux only. Before opening or pushing to a pull request that adds or changes an E2E suite, or touches code run on every file event (graph refresh, indexing, extension services, file watcher), validate the pushed branch with the on-demand workflow: `gh workflow run e2e-os.yml --ref <branch> -f os=ubuntu-latest -f suite='**/**.test.js'`; use `os=all` when paths, workbench layout or file events are involved.
- Keep each touched source file at or above 80% coverage.
- A class instantiated with `new` must use a constructible mock, for example `vi.fn().mockImplementation(function () { ... })`; arrow-function constructor mocks throw.
- Use `@/` imports and existing fixtures. Include Windows separators, drive letters, and case behavior in new path tests.
- Compare paths in assertions only after `normalizePath()` on both sides (or as workspace-relative paths with `/`), never a raw result path against a normalized one: on Windows the two differ in separators and drive-letter case, so `find`/`toEqual`/`has` silently miss (#519, PR #594).
- Give heavy tests an explicit timeout sized for the slowest CI runner, not for a local machine: anything that builds a real index, spawns the CLI or MCP server, loads WASM, starts the AST worker, or runs a VS Code E2E suite. GitHub-hosted runners vary in power (Windows and macOS are often several times slower), so never assert tight wall-clock bounds; prefer work counters or ratios. `vitest.config.mts` sets the floor (`testTimeout` 30 s, `hookTimeout` 60 s); a test that needs more gets its own timeout on the `it`/hook that does the work.
- Run smallest relevant test during iteration, then required unit/E2E/coverage checks for changed scope.
