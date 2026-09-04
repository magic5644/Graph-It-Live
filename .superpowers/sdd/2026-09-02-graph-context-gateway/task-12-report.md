# Task 12 report

## Status

Implemented Task 12 on `feat/graph-context-gateway`.

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

Tool-count documentation now matches MCP 27, native LM 22, and CLI
`tool --list` 22; `src/**` examples are shell-quoted.

## Validation

- `npx vitest run tests/analyzer/graph-context/DocumentReferenceIndexer.test.ts tests/analyzer/graph-context/GraphContextRetriever.test.ts` — passed (21 tests).
- `npm run check:types` — passed.
- `npm run lint -- --quiet` — passed.

## Commit

Committed as:

```text
feat(graph): index local documentation and rationale
```
