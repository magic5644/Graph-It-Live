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

Expose one shared graph-context contract through MCP
(`graphitlive_graph_context`), the CLI (`graph-it context` and the lower-level
`graph-it tool graph_context` bridge), and the native VS Code Language Model
tool (`graph-it-live_graph_context`, referenced as `#graphContext`). The
federator joins existing index results at read time and returns
workspace-relative nodes and edges. Existing specialized tools remain
available and retain their contracts.

Stable node IDs are:

- `file:<relative-path>`
- `symbol:<relative-path>:<symbol-name>:<start-line>`
- `test:<relative-path>:<symbol-name>:<start-line>`
- `document:<relative-path>`
- `rationale:<relative-path>:<source-line>`
- `external:<unresolved-name>`
- `community:<positive-integer>`

File, symbol, test, document, and rationale IDs use normalized
workspace-relative paths. External IDs preserve the unresolved target name.
Community IDs are deterministic for one index revision but may change when the
graph topology changes. Edges carry one of these provenance classes:

- `EXTRACTED`: direct import, AST, or test evidence;
- `RESOLVED`: identity or module resolution evidence;
- `INFERRED`: derived community, impact, or relationship evidence;
- `AMBIGUOUS`: more than one valid endpoint;
- `STALE`: evidence is older than the indexed source.

Scope defaults to `**`. Patterns are normalized workspace-relative globs that
support `*`, `**`, and `?`; paths outside the workspace are rejected. Scope is
applied before seed scoring and traversal. Local document and rationale nodes
participate when their paths match the public request scope or a document seed
selects them.

The gateway accepts depth 1–5, 1–500 nodes per page, and a token budget of
500–16,000 (default 4,000). `maxNodes` is a requested page bound, not a hard
response-size ceiling: the budgeter preserves mandatory requested seeds and
path endpoints even when they make the page exceed that value. It counts the
serialized response with `gpt-tokenizer`'s `cl100k_base` encoding. It preserves
requested seeds and path
endpoints, then selects additional nodes by deterministic relevance. If the
mandatory nodes alone exceed the budget, the request fails instead of dropping
them. Truncation reports omitted nodes and edges and returns an opaque cursor
bound to the workspace, request, scope, filters, budget, and index revision.

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
tag such as `v1.14.1` identifies the source revision consumed by the extension,
Action, or CLI; an npm version or tag selects the published CLI. The Action's
`cli-version` may intentionally use an npm version, tag, or range, and the
resolved installed version is logged. Documentation must not describe this
normal release-tag workflow as a gateway or packaging bug.
