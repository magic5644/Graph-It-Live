---
paths:
  - "src/analyzer/**/*.{ts,tsx}"
  - "src/mcp/**/*.{ts,tsx}"
  - "src/shared/**/*.{ts,tsx}"
---

# Analyzer, MCP, and Path Security

- Never import `vscode` from `src/analyzer/**` or `src/mcp/**`; both run outside extension host.
- Build filesystem paths with `path.join()`/`path.resolve()`. Never hardcode separators.
- Normalize paths with `normalizePath()` before Set/Map insertion or lookup and before cross-platform comparison.
- Treat module specifiers, MCP payloads, and source-derived paths as untrusted. Resolve against intended root, then reject result outside root before file I/O (CWE-22).
- Validate MCP inputs with existing Zod schemas and keep tool descriptions in WHEN/WHY/WHAT form.
- Sanitize generated Mermaid/Markdown labels: remove control characters and syntax delimiters; escape `|` in table cells; display workspace-relative paths instead of absolute paths.
- Keep `ReverseIndex.removeDependenciesFromSource()` cleanup lazy; immediate empty-map deletion races with re-analysis.
