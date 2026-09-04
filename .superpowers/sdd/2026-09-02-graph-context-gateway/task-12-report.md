# Task 12 report

## Status

Implemented Task 12 and addressed its review findings on
`feat/graph-context-gateway`.

## Delivered

- Added `docs/architecture/ADR-F5-01-graph-context-gateway.md` covering
  federation, stable IDs, provenance, scope, token selection, rejected
  alternatives, and the narrow Graphify comparison boundary.
- Documented `graph-it context` and `graph_context` in `docs/CLI.md`, including
  modes, examples, limits, cursors, and failure boundaries.
- Added the unified gateway entry points and boundaries to `README.md`.
- Added graph-context TOON sections and separated tokenizer budgets from
  representation-size estimates in `docs/architecture/TOON_FORMAT.md`.
- Added graph-context request limits and failure modes to
  `docs/architecture/MCP_PAYLOAD_LIMITS.md`.
- Added `DocumentReferenceIndexer` for Markdown/MDX/RST/YAML, local links,
  headings, and `WHY`/`NOTE`/`HACK` rationale markers.
- Federated document and rationale nodes with extracted `REFERENCES`,
  `EXPLAINS`, and `DOCUMENTS` edges, line evidence, and workspace safety.
- Kept document indexing opt-in by explicit scope or document seed.
- Added focused indexer and retriever tests.

## Review fixes

- Exact `document:<workspace-relative-path>` seeds now load documentation
  without requiring `scope`.
- Rationale markers explain only the nearest code link in their Markdown or
  RST section instead of every code link in the document.
- RST underline headings and inline links preserve document titles and source
  lines.
- MDX indexing accepts Markdown links and quoted JSX `href`/`to` values while
  ignoring expression-valued and remote links.
- YAML indexing accepts local path scalars and quote-aware comments; quoted
  `# WHY:`, `# NOTE:`, and `# HACK:` strings remain data.
- Document links remain workspace-relative, local-only, and opt-in.

Tool-count documentation now matches MCP 27, native LM 22, and CLI
`tool --list` 22; `src/**` examples are shell-quoted.

## Validation

- Focused analyzer, resolver, retriever, federator, and MCP graph-context tests
  — passed (52 tests).
- `npm run check:types` — passed.
- `npm run lint` — passed.

## Commits

- Task 12: `feat(graph): index local documentation and rationale`
- Review fixes: `fix(graph): harden documentation indexing`
