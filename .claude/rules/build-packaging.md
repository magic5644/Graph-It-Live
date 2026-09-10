---
paths:
  - "esbuild.js"
  - "package.json"
  - "package-lock.json"
  - ".vscodeignore"
  - "scripts/**/*"
  - ".github/workflows/**/*.{yml,yaml}"
---

# Build, Dependencies, and Packaging

- `esbuild.js` builds extension, CLI, MCP, workers, and two webviews; verify every target after build changes.
- WASM and Tree-sitter query files are copied assets, not normal bundled JavaScript. Keep required files in `dist/wasm/` and `dist/queries/`.
- Production VSIX must contain zero `.map` files. Keep `**/*.map` excluded and avoid broad `node_modules` re-inclusions.
- After build config or dependency changes run production build, `npm run package`, and `npm run package:verify`.
- Inspect package contents: zero `.map`; required `.wasm`/`.scm` assets present; package remains below 20 MB.
- Bundle pure JS/TS dependencies unless runtime architecture explicitly requires externalization. Add no dependency when standard library or installed package suffices.
- Stop release work if package validation fails; fix exclusion/copy rules and repackage.

## Mandatory Verification Workflow

1. Run `npm run build -- --production`.
2. Run `npm run package`.
3. Run `npm run package:verify`; direct `npx vsce ls | grep "\.map$"` must return empty.
4. Inspect package size and investigate unexpected growth or size above 20 MB.
5. Inspect `npx vsce ls` for all required `.wasm` and `.scm` assets.
6. After runtime asset changes, install generated VSIX and verify extension activation.

If any `.map` is present: stop commit/release, fix `.vscodeignore`, repackage, and repeat verification.

`.vscodeignore` must exclude `**/*.map`, avoid broad dependency re-inclusions, and include only runtime-required files. Re-exclude maps after any necessary inclusion rule.
