# ADR-F5-01: Unified Graph Context Gateway

## Status

Accepted

## Context

Graph-It-Live already maintains a file dependency graph and a cross-file symbol
call graph. Asking an agent to combine them through several specialized tools
adds tool calls and makes scope, provenance, and truncation easy to lose.

The gateway is a read-only federation over those indexes. It is a retrieval
surface, not a replacement for either index and not a source-content loader.

## Decision

Expose one shared graph-context contract through MCP, the CLI, and the native
VS Code Language Model tool. The federator joins existing index results at read
time and returns workspace-relative nodes and edges. Existing specialized tools
remain available and retain their contracts.

Stable node IDs are:

- `file:<relative-path>`
- `symbol:<relative-path>:<symbol-name>:<start-line>`
- `test:<relative-path>:<symbol-name>:<start-line>`

Community, external, document, and rationale nodes use the same workspace-
relative model and are included only when the relevant analysis or scope asks
for them. Edges carry one of these provenance classes:

- `EXTRACTED`: direct import, AST, or test evidence;
- `RESOLVED`: identity or module resolution evidence;
- `INFERRED`: derived community, impact, or relationship evidence;
- `AMBIGUOUS`: more than one valid endpoint;
- `STALE`: evidence is older than the indexed source.

Scope patterns are normalized workspace-relative globs (`*`, `**`, `?`) and are
applied before seed scoring and traversal. Results preserve requested seeds and
path endpoints, then select additional nodes by deterministic relevance within
the requested token budget. Truncation reports omitted nodes/edges and returns
an opaque cursor bound to the request, scope, budget, and index revision.

The gateway returns graph structure, evidence, line spans, and follow-up
queries. It does not return source contents by default; clients should read
the precise files and lines after retrieval.

## Alternatives rejected

- **Replace either existing index:** rejected because it creates a risky schema
  migration and discards mature specialized analysis.
- **External vector database:** rejected for the core release because local,
  deterministic retrieval has no network or service dependency.
- **Immediate multimedia ingestion:** rejected; PDFs, images, video, and audio
  are outside this code-context release.
- **Global Graphify replacement claim:** rejected without a shared-corpus
  comparison. Graph-It-Live's defensible claim is narrower: unified,
  evidence-backed, token-bounded context for local code navigation and
  refactoring across supported languages. Graphify parity for PR triage,
  multi-project HTTP serving, broad language coverage, and multimedia graphs
  remains separate.

## Release and versioning

Release-tag versioning is normal release hygiene, not a defect. An immutable
tag such as `v1.13.0` identifies the source revision consumed by the extension,
Action, or CLI; an npm version or tag selects the published CLI. The Action's
`cli-version` may intentionally use an npm version, tag, or range, and the
resolved installed version is logged. Documentation must not describe this
normal release-tag workflow as a gateway or packaging bug.

