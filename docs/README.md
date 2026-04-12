# Graph-It-Live Documentation

**Last Updated:** 2026-04-12

This directory is the single source of truth for technical documentation. It is organized into three sections.

---

## Architecture

Documentation describing how the system is built and how the layers interact.

| File | Description |
|------|-------------|
| [architecture/codemaps/architecture.md](architecture/codemaps/architecture.md) | System overview — layers, services, file count |
| [architecture/codemaps/backend.md](architecture/codemaps/backend.md) | Analyzer, MCP, and extension services |
| [architecture/codemaps/cli.md](architecture/codemaps/cli.md) | Standalone CLI layer (`graph-it`) |
| [architecture/codemaps/frontend.md](architecture/codemaps/frontend.md) | Webview / React components |
| [architecture/codemaps/data.md](architecture/codemaps/data.md) | Data flow and shared types |
| [architecture/TOON_FORMAT.md](architecture/TOON_FORMAT.md) | TOON serialization format spec (token-efficient output) |
| [architecture/MCP_PAYLOAD_LIMITS.md](architecture/MCP_PAYLOAD_LIMITS.md) | MCP input validation and payload size limits |
| [architecture/MCP_DEBUG_LOGGING_SECURITY.md](architecture/MCP_DEBUG_LOGGING_SECURITY.md) | MCP debug logging — opt-in, rotation, privacy |
| [architecture/PERFORMANCE_OPTIMIZATIONS.md](architecture/PERFORMANCE_OPTIMIZATIONS.md) | Performance patterns: batch processing, concurrency, caching |
| [architecture/graph-it-live-architecture.svg](architecture/graph-it-live-architecture.svg) | Architecture diagram (SVG) |

---

## Development

Standards and guidelines for contributors.

| File | Description |
|------|-------------|
| [development/CODING_STANDARDS.md](development/CODING_STANDARDS.md) | TypeScript conventions, layer rules, React patterns |
| [development/CROSS_PLATFORM_TESTING.md](development/CROSS_PLATFORM_TESTING.md) | Cross-platform path handling and test guidelines |
| [development/ADR-001-package-manager-choice.md](development/ADR-001-package-manager-choice.md) | ADR: npm vs Yarn decision |

---

## Specifications

Design documents and approved feature specs.

| File | Description |
|------|-------------|
| [specs/2026-03-17-graph-it-cli-design.md](specs/2026-03-17-graph-it-cli-design.md) | CLI design spec — approved 2026-03-17, implemented in PR #80 |
| [specs/2026-04-12-csharp-go-java-language-support.md](specs/2026-04-12-csharp-go-java-language-support.md) | C#, Go, Java language support — implemented |

---

## Removed Documentation

The following documents were removed as obsolete:

| File (removed) | Reason |
|----------------|--------|
| `MCP_MODULARIZATION.md` | Plan superseded — tools are now split into `src/mcp/tools/` per category, no registry pattern needed |
| `MIGRATION_MCP_DEBUG_LOGGING.md` | One-time migration notice for a change already shipped |
| `PAYLOAD_LIMITS_IMPLEMENTATION.md` | Implementation recap fully covered by `architecture/MCP_PAYLOAD_LIMITS.md` |
