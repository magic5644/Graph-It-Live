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

### Quality
- [ ] `npm run lint`
- [ ] `npm run check:types`
- [ ] `npm test`
- [ ] Sonar clean on modified files (no new issues)

### VSIX / Packaging (required when build config or deps changed)
- [ ] `npm run package:verify` → `✅ No .map files in package`
- [ ] `npx vsce ls graph-it-live-*.vsix | grep "\.wasm$"` shows required WASM files
- [ ] `ls -lh graph-it-live-*.vsix` size checked (target ≤ 16 MB, warn above)

### E2E
- [ ] `npm run test:vscode:vsix` (required for user-facing changes)

## Checklist
- [ ] Tests added/updated for changed behavior
- [ ] Docs updated (if needed)
- [ ] Cross-platform impact considered (Windows/Linux/macOS)
- [ ] No `vscode` import added under `src/analyzer/**` or `src/mcp/**`
