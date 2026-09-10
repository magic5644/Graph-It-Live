---
paths:
  - "**/*.md"
  - "**/*.mmd"
  - "**/*.mermaid"
---

# Documentation and Mermaid

- Keep documentation concise, factual, and synchronized with code; do not duplicate rules already defined in `AGENTS.md` or `.claude/rules/`.
- Store diagrams as `.mmd` files. Fetch Mermaid syntax guidance for unfamiliar diagram types, validate syntax, then preview rendered output before completion.
- Use correct first-line diagram keyword, balanced delimiters, and valid arrow syntax.
- Sanitize source-derived labels: remove quotes, backticks, line breaks, Mermaid brackets/operators, and HTML-risk characters; cap label length.
- Never emit executable HTML, scripts, `javascript:` links, `eval`, or untrusted external URLs inside generated diagrams.
- Escape `|` as `\|` in Markdown table cells.
- Show paths relative to workspace root in generated prose; do not expose absolute workspace paths.
- Anchor output-directory `.gitignore` patterns at repository root, for example `/wiki/`.
