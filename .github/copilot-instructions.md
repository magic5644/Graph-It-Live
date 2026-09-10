# Graph-It-Live Copilot Adapter

Use repository-wide rules from `AGENTS.md`. VS Code also discovers path-scoped rules in `.claude/rules/`; apply only files matching current work or task routing table.

Keep context lean: do not load every rule preemptively. For broad architecture questions, query Graphify first. For edits, read exact conditional rule named by `AGENTS.md`, then inspect relevant source.

VS Code does not guarantee ordering between combined instruction files. If loaded rules conflict, stop and report conflict instead of choosing arbitrarily.
