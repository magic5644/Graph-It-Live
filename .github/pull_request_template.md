## Summary
<!-- What changed and why -->

## Type of change
- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Build/packaging
- [ ] Documentation
- [ ] Tests

## Validation evidence
<!-- Paste short command outputs (or links to CI jobs) -->

### User-facing check (CLI, MCP, VS Code changes; `.claude/rules/user-contract.md`)
<!-- Commands, tools or views run as a user, with their failure cases, and what came out. Visual outputs opened. -->
- [ ] Each changed command / tool / view run black-box, including unknown option, invalid value and missing target
- [ ] Every declared format renders the requested view; others are refused with the supported list
- [ ] Visual outputs (SVG, HTML, webview) opened and readable, also on a large input when size matters
- [ ] Help, MCP descriptions and docs match the behavior

### Quality
- [ ] `npm run lint`
- [ ] `npm run check:types`
- [ ] `npm test`
- [ ] Sonar clean on modified files (no new issues)

### VSIX / Packaging (required when build config or deps changed)
- [ ] `npm run package:verify` → `✅ No .map files in package`
- [ ] `npx vsce ls graph-it-live-*.vsix | grep "\.wasm$"` shows required WASM files
- [ ] `ls -lh graph-it-live-*.vsix` size checked (target ≤ 20 MB, warn above)

### E2E
- [ ] `npm run test:vscode:vsix` (required only when VS Code webviews `src/webview/**` or E2E tests change)

## Checklist
- [ ] Tests added/updated for changed behavior
- [ ] Docs updated (if needed)
- [ ] Cross-platform impact considered (Windows/Linux/macOS)
- [ ] No `vscode` import added under `src/analyzer/**` or `src/mcp/**`
