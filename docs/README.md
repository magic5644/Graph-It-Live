# Graph-It-Live Documentation

**Last Updated:** 2026-10-09

Technical documentation for the VS Code extension, the `graph-it` CLI and the MCP server. User-facing setup and features are in the root [README](../README.md).

---

## Usage

| File | Description |
|------|-------------|
| [CLI.md](CLI.md) | `graph-it` CLI reference: REPL, commands, options, output formats, environment variables, MCP tools via `graph-it tool`, review gate |
| [examples/graph-it-review-gate.yml](examples/graph-it-review-gate.yml) | Consumer workflow for the Graph-It Review Gate GitHub Action |

## Architecture

| File | Description |
|------|-------------|
| [architecture/codemaps/architecture.md](architecture/codemaps/architecture.md) | System overview: layers, services, MCP tools, review gate |
| [architecture/codemaps/backend.md](architecture/codemaps/backend.md) | Analyzer layer: Spider, parsers, indexes, call graph, Branch Watch, community detection |
| [architecture/codemaps/cli.md](architecture/codemaps/cli.md) | Standalone CLI layer |
| [architecture/codemaps/frontend.md](architecture/codemaps/frontend.md) | Webview (React, ReactFlow, Cytoscape) |
| [architecture/codemaps/data.md](architecture/codemaps/data.md) | Messages, shared types, MCP tool names |
| [architecture/codemaps/class-hierarchy.md](architecture/codemaps/class-hierarchy.md) | Core interfaces, classes and design patterns |
| [architecture/TOON_FORMAT.md](architecture/TOON_FORMAT.md) | TOON serialization format |
| [architecture/MCP_PAYLOAD_LIMITS.md](architecture/MCP_PAYLOAD_LIMITS.md) | MCP input validation and payload size limits |
| [architecture/MCP_DEBUG_LOGGING_SECURITY.md](architecture/MCP_DEBUG_LOGGING_SECURITY.md) | MCP debug logging: opt-in, rotation, privacy |
| [architecture/PERFORMANCE_OPTIMIZATIONS.md](architecture/PERFORMANCE_OPTIMIZATIONS.md) | Batch processing, concurrency, caching |

### Diagrams

The diagrams are being refreshed in #300; some content predates Branch Watch and the review gate.

| File | Description |
|------|-------------|
| [architecture/graph-it-live-architecture-diagram.html](architecture/graph-it-live-architecture-diagram.html) | Architecture overview (interactive HTML) |
| [architecture/graph-it-live-four-layer-diagram.html](architecture/graph-it-live-four-layer-diagram.html) | Four-layer view: analyzer, extension, MCP, webview |
| [architecture/graph-it-live-runtime-flows-diagram.html](architecture/graph-it-live-runtime-flows-diagram.html) | Runtime flows: extension, MCP server, CLI |
| [architecture/graph-it-live-architecture.svg](architecture/graph-it-live-architecture.svg) | Static class diagram (April 2026, outdated) |

### Architecture decision records

| File | Decision |
|------|----------|
| [architecture/ADR-F2-01-hubscore-source-of-truth.md](architecture/ADR-F2-01-hubscore-source-of-truth.md) | `hubScore` source of truth |
| [architecture/ADR-F3-01-visjs-inlining-strategy.md](architecture/ADR-F3-01-visjs-inlining-strategy.md) | Inlining vis.js in the standalone HTML export |
| [architecture/ADR-F3-02-vis-network-dependency-position.md](architecture/ADR-F3-02-vis-network-dependency-position.md) | `vis-network` as dependency vs devDependency |
| [architecture/ADR-F4-01-community-detection-algo.md](architecture/ADR-F4-01-community-detection-algo.md) | Community detection (Louvain, superseded by path-based detection) |
| [architecture/ADR-F5-01-graph-context-gateway.md](architecture/ADR-F5-01-graph-context-gateway.md) | Unified graph context gateway |
| [architecture/ADR-S2-01-toon-field-mcp-compat.md](architecture/ADR-S2-01-toon-field-mcp-compat.md) | MCP compatibility of the `toon` field |
| [development/ADR-001-package-manager-choice.md](development/ADR-001-package-manager-choice.md) | npm vs Yarn |

## Development

| File | Description |
|------|-------------|
| [development/CODING_STANDARDS.md](development/CODING_STANDARDS.md) | TypeScript, layering and MCP conventions |
| [development/CROSS_PLATFORM_TESTING.md](development/CROSS_PLATFORM_TESTING.md) | Windows, macOS and Linux path handling and testing |
| [benchmarks/graph-context-benchmark.md](benchmarks/graph-context-benchmark.md) | Graph context benchmark |

## Specifications

| File | Description |
|------|-------------|
| [specs/2026-07-17-graph-it-review-gate.md](specs/2026-07-17-graph-it-review-gate.md) | Review gate: `review-pr`, risk model, GitHub Action |
| [specs/requirements/F4-user-stories.md](specs/requirements/F4-user-stories.md) | Community detection user stories (delivered, then replaced by path-based detection) |

Finished one-off documents (sprint notes, implemented specs and plans) were removed in #301; they remain in Git history.
