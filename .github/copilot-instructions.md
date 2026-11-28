# Graph-It-Live Copilot Adapter

Use repository-wide rules from `AGENTS.md`. VS Code also discovers path-scoped rules in `.claude/rules/`; apply only files matching current work or task routing table.

Keep context lean: do not load every rule preemptively. For `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.cts`, and `.mts` code, follow the routing in `AGENTS.md` (Working Method): a known file or symbol gets a bounded direct read; editing an exported symbol, an unknown location, callers, impact, or architecture go through Graph-It-Live MCP tools or the `graph-it` CLI (it indexes on demand) first. For edits, read exact conditional rule named by `AGENTS.md`, then inspect relevant source.

VS Code does not guarantee ordering between combined instruction files. If loaded rules conflict, stop and report conflict instead of choosing arbitrarily.
