---
paths:
  - "src/cli/**/*.{ts,tsx}"
  - "src/mcp/**/*.{ts,tsx}"
  - "src/extension/**/*.{ts,tsx}"
  - "src/webview/**/*.{ts,tsx}"
  - "package.json"
---

# User Contract: CLI, MCP and VS Code

Apply this file by explicit routing to any issue, change or review of what a user or an agent runs: a CLI command or option, an MCP tool or parameter, a VS Code command, setting or view. Code that passes CI can still break this contract: coverage and Sonar do not see an ignored flag, an empty success or an unreadable diagram.

## Every surface

- **Contract first.** Acceptance criteria list the failure cases with their expected message and exit code or error, next to the success case: unknown option or parameter, invalid value, missing target, empty result, path outside the workspace, input large enough to hit a cap.
- **No silent fallback.** An option, format, view or parameter the code does not honour is an error naming what is supported. Never ignore it, replace it with another output, or render a generic dump of the result keys.
- **No empty success.** A missing file, symbol, scope, unit or key is an error with the closest candidates, never exit 0 with an empty result.
- **Errors a user can act on.** One line: what was received, what is expected, the next step. No stack trace, raw Zod or JSON issue list, raw child-process output (`Command failed: git …`) or internal hint (`use runExportHtml directly`). Paths are workspace-relative.
- **One name per concept.** Same option spelling, term and wording on the CLI, MCP, VS Code and docs (`--maxFiles` vs `--max-files`, units vs packages). A rename updates every surface in the same change.
- **Help matches behaviour.** CLI help, MCP descriptions and setting descriptions list every option that exists and nothing that does not. Build them from the declaration, or test them against it.
- **Readable at scale.** Each output defines its behaviour past its cap: it says what was left out and the command that shows it. A view that cannot stay readable (a node-link diagram of a 70-member cycle) switches to a list or matrix instead of drawing everything.
- **Same facts everywhere.** The CLI, MCP and VS Code report the same counts for the same question; a parity test covers each shared computation.

## CLI

- Each command declares its options (name, value type, allowed values), positionals and output formats in one place. Unknown options exit 1 (`GENERAL_ERROR`) with `Did you mean` when close; positionals are read wherever they sit among options.
- Every declared format renders the requested view. Any other format exits 4 (`UNSUPPORTED_FORMAT`) naming the supported ones.
- stdout holds the result only; progress and status go to stderr. `json`, `toon`, `csv`, `sarif` and `diagram-spec` parse with stderr discarded.
- `--output -` writes to stdout. A file output resolves against the workspace, outside paths exit 5 (`SECURITY_VIOLATION`), and the file extension matches the format.
- Without a TTY: no prompt, no colour or progress, and nothing written unless the user passed `--yes` or an explicit output.
- Exit codes follow `ExitCode` in `src/cli/errors.ts`; a new failure kind reuses one of them.
- Contract test: the table-driven CLI test runs every command × declared format × {valid input, unknown option, invalid value, missing target} and checks the exit code and that the output is the requested view. A new command, option or format adds its rows.

## MCP

- New or changed tool schemas reject unknown parameters (`.strict()`) and use enums for closed values.
- Errors are tool errors with a readable message naming the parameter and the allowed values, never a raw Zod issue list.
- Descriptions name only parameters and returned fields that exist; `npm run sync:tool-descriptions -- --check` passes, and a test checks that every schema parameter appears in its description.
- Responses use workspace-relative paths, say when they are truncated and how to get the rest (cursor, `limit`), and keep field names stable; a renamed field is a breaking change in the changelog.

## VS Code

- Every contributed command works, or says why it cannot, with no workspace, no active editor, or an unsupported file. It never fails silently.
- Long operations show progress and can be cancelled; one failure gives one notification, not one per file.
- Settings declare their type, enum or bounds, and a description matching the code. A setting change applies without restart, or the description says it needs one.
- Every view has a loading, an empty and an error state; it never stays blank.
- E2E covers the user path of a new command, setting or view, including one failure case.

## Verify as a user before the pull request

- Run each changed command, tool or view black-box as a user or an agent would, including its failure cases, on a fixture and, when the output depends on size, on a large public repository (cal.com, svelte.dev or nuxt.com, never private code).
- Open every visual output (SVG, HTML page, webview, diagram) and look at it.
- For a command that analyzes a workspace: time it cold and warm on the large repository (a warm run that redoes all the work is a defect), run it once on a fresh clone without generated or build outputs (an import that resolves to no file is reported, never silently changes counts), and open visual outputs with ≥ 50 units (every node labelled, colour never the only key).
- Paste the commands run and their outcome in the pull request *User-facing check* section. A pull request touching these surfaces without it is not ready, and a review that only reads the diff does not approve it.
