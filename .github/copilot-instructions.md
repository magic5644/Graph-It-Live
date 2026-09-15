# Graph-It-Live Copilot Adapter

Use repository-wide rules from `AGENTS.md`. VS Code also discovers path-scoped rules in `.claude/rules/`; apply only files matching current work or task routing table.

Keep context lean: do not load every rule preemptively. For any exploration involving `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.cts`, or `.mts`, use Graph-It-Live MCP tools first, or `graph-it` after `graph-it scan`; only then inspect source directly to verify details or edit. For edits, read exact conditional rule named by `AGENTS.md`, then inspect relevant source.

VS Code does not guarantee ordering between combined instruction files. If loaded rules conflict, stop and report conflict instead of choosing arbitrarily.
