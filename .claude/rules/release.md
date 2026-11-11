---
paths:
  - "changelog.md"
  - ".github/workflows/release.yml"
  - ".github/workflows/publish-npm.yml"
  - "scripts/release-notes.mjs"
  - "site/**"
  - "media/**"
  - ".vscodeignore"
---

# Release Preparation

Apply this file by explicit routing for any release preparation (docs, media, site, changelog, version, tag), even when no matched file is open. Order: dependencies PR → docs PR → media and site PR → changelog PR → tag. Procedure: `CONTRIBUTING.md` *Releasing*.

## Dependencies first

Every release starts with a `chore(deps)` PR in the release milestone, merged before the docs PR.

1. `npm outdated` and `npm audit`. Take minor and patch updates within current ranges (`npm update <names>`). List skipped majors in the PR body; each one is a separate decision.
2. Keep `engines.vscode` and `@types/vscode` equal, with `@types/vscode` pinned exactly (no `^`): a newer types package compiles code that calls APIs the declared minimum lacks. Raise the minimum only with user approval, and update `README.md`, `CONTRIBUTING.md`, `DEVELOPMENT.md` and `tests/vscode-e2e/test-host/package.json` with it.
3. `npm audit` must report 0 vulnerabilities. Check npm's suggested fix before applying it (it can be a downgrade, or a major that still ships the vulnerable range); prefer the smallest `overrides` entry for a transitive dependency. Never run `npm audit fix --force`.
4. Validate: `npm run build`, `npm run lint`, `npm run check:types`, `npm test`, `npm run package && npm run package:verify`. When the VS Code minimum or a test runner changes, dispatch `e2e-os.yml` with `os=all`, suite `**/*.test.js` and `vscode-version=<minimum>`.

## Documentation first

Documentation must match shipped code before the changelog PR. Never tag over stale docs.

1. Audit user-facing docs against code: `README.md`, `docs/CLI.md`, `docs/**`, `DEVELOPMENT.md`, `CONTRIBUTING.md`, plugin skills `plugins/graph-it-live/skills/*/SKILL.md` and `plugins/graph-it-live/README.md`.
2. Check facts from source, not memory: CLI commands/options (`src/cli`), MCP tools and parameters (`src/mcp`), settings and commands (`package.json` `contributes`), file paths, counts, versions.
3. Run `npm run sync:tool-descriptions -- --check`; fix drift.
4. Update or remove stale content; mark finished one-off docs (sprints, specs) as historical or delete them.
5. Land doc fixes in their own PR(s) before the changelog PR.

## Media and site

Users discover features through images, so every release showing new user-facing features ships new visuals. Land them in their own PR, after the feature PRs and before the changelog PR.

1. Capture each new feature from the final build: animated GIF for flows (short and narrow, a few MB at most), PNG for still states. Name files `media/<feature>-<what>.{gif,png}`. `pr-assets/<issue>` branches hold earlier captures to reuse as sources, but only those that follow the next rule (not the OSS corpus shots, such as hono).
   - Show only this repository's code: Graph-It-Live itself, or `tests/fixtures/**` for other languages and project shapes. Never third-party code, OSS corpora or private code.
   - Accompany every image and GIF with an English explanation: alt text, a caption or short paragraph saying what it shows and how to get there (command, setting, click).
2. Show them in `README.md` and `site/index.html` (feature section, `og:image` when the headline feature changes). `.github/workflows/pages.yml` deploys the site when `site/**` or `media/**` lands on `main`.
3. Keep demo media out of the VSIX: `.vscodeignore` excludes `media/**` except the icon. `vsce` rewrites relative README images to `https://github.com/magic5644/Graph-It-Live/raw/HEAD/media/...`, and both stores publish that same VSIX. Never rename or delete a `media/` file that a published README still references.
4. Check the package: `npm run package && npm run package:verify`, then `ls -lh graph-it-live-*.vsix` (≤ 20 MB).

## Changelog and tag

- Add `## v<version>` at top of `changelog.md`; release fails without it. Group under *Breaking / Behavior changes*, *Changed*, *Fixed*, *Security*, *Tests*.
- Present each user-facing feature with a concrete example: the command or setting to use, a short config snippet, or the scenario it fixes, plus its image. Use absolute image URLs (`https://github.com/magic5644/Graph-It-Live/raw/HEAD/media/...`): the GitHub release body built by `scripts/release-notes.mjs` does not resolve relative paths.
- Pick semver from content: feature → minor, fixes only → patch, breaking → major. Milestone name does not decide.
- Preview body: `node scripts/release-notes.mjs v<version> release-notes.md`.
- Tag only from `main` after changelog PR merges with CI, Review Gate and SonarCloud green.
