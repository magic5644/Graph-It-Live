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

## README size and fit

`README.md` is the landing page for GitHub, the VS Code Marketplace, Open VSX, and npm. It orients readers and links to `docs/` for details.

- Keep it at 220 lines or fewer.
- Keep this order: pitch, badges, and one video; quick start per surface (VS Code, CLI, MCP); one line, one image, and one link per feature; the AI clients table; supported languages; short summaries with links; documentation, development, license.
- Put details in `docs/` (`features.md`, `architecture-view.md`, `ai-integrations.md`, `configuration.md`, `CLI.md`), never in the README. A new feature, command, setting, or client gets one line or one table row in the README, plus a link.
- After every README change, check four things:
  - `wc -l README.md` is 220 or less;
  - the table of contents lists every `##` section;
  - every relative link and image path resolves;
  - every command, setting, and feature named in the README still exists in the code.
- If the README goes over 220 lines or a section stops matching the product, restructure it in the same change. Never raise the limit to make it pass.
