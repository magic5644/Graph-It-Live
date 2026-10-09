---
paths:
  - "changelog.md"
  - ".github/workflows/release.yml"
  - ".github/workflows/publish-npm.yml"
  - "scripts/release-notes.mjs"
---

# Release Preparation

Apply this file by explicit routing for any release preparation (changelog, version, tag), even when no matched file is open. Procedure: `CONTRIBUTING.md` *Releasing*.

## Documentation first

Documentation must match shipped code before the changelog PR. Never tag over stale docs.

1. Audit user-facing docs against code: `README.md`, `docs/CLI.md`, `docs/**`, `DEVELOPMENT.md`, `CONTRIBUTING.md`, plugin skills `plugins/graph-it-live/skills/*/SKILL.md` and `plugins/graph-it-live/README.md`.
2. Check facts from source, not memory: CLI commands/options (`src/cli`), MCP tools and parameters (`src/mcp`), settings and commands (`package.json` `contributes`), file paths, counts, versions.
3. Run `npm run sync:tool-descriptions -- --check`; fix drift.
4. Update or remove stale content; mark finished one-off docs (sprints, specs) as historical or delete them.
5. Land doc fixes in their own PR(s) before the changelog PR.

## Changelog and tag

- Add `## v<version>` at top of `changelog.md`; release fails without it. Group under *Breaking / Behavior changes*, *Changed*, *Fixed*, *Security*, *Tests*.
- Pick semver from content: feature → minor, fixes only → patch, breaking → major. Milestone name does not decide.
- Preview body: `node scripts/release-notes.mjs v<version> release-notes.md`.
- Tag only from `main` after changelog PR merges with CI, Review Gate and SonarCloud green.
